// "UK visa sponsors only": for a UK client with the switch on, every job an
// operator pushes must come from an employer on the Home Office register of
// licensed sponsors, with a licence for the Skilled Worker route.
//
// Where it runs: the BACKEND, at every path that writes an operator job -
// /addjob (jr-direct extension and autopilot), /job-api/run (Adzuna API mode)
// and /extension/saveToDashboard. The extension is not changed: /addjob answers
// 403 NOT_UK_VISA_SPONSOR, which the extension already files under "blocked",
// does not count against the daily cap, and moves on to the next job.
//
// Who is a UK client: dashboardtrackings.clientCountry === "UK", set by ops in
// clients-tracking. When that field is unset, a "£" amountPaid means UK - the
// same fallback clients-tracking's Client Job Analysis uses, so the two screens
// never disagree. Location text is deliberately NOT a signal: on the live data
// every profile it would have added was a false positive (Cambridge MA,
// "New England", Toronto's Cambridge).
//
// Matching a job's employer to a register name:
//   1. Normalise both sides the same way (companyMatchKeys): lowercase, strip
//      accents, "&" -> "and", drop legal-form words (Ltd, PLC, LLP, UK...),
//      split "X t/a Y" into both names.
//   2. EXACT: any key equal to a stored matchKey. One index seek.
//   3. BRAND PREFIX: the job says "Barclays", the register says "Barclays Bank
//      PLC". Accepted only when every extra word is generic ("bank",
//      "services", "europe"...). That is what stops "Apple" matching
//      "Apple Tree Care Ltd", a care home with its own licence.
//   4. A spaced-out brand ("JP Morgan" -> "JPMorgan Chase Bank") and, last, a
//      "t/a" trading name. lookupUkSponsor documents the exact order.
// Results are cached in memory, including misses, so an operator run that
// sees the same employer forty times costs one lookup.

import mongoose from "mongoose";
import { UkVisaSponsorModel, CITY_COLLATION } from "../Schema_Models/UkVisaSponsorModel.js";
import { ProfileModel } from "../Schema_Models/ProfileModel.js";

const TRACKING_COLLECTION = "dashboardtrackings";

// Legal-form and filler words that say nothing about WHICH company it is.
const LEGAL_WORDS = new Set([
  "ltd", "limited", "plc", "llp", "lp", "llc", "inc", "incorporated", "corp", "corporation",
  "co", "company", "cic", "cio", "uk", "gb", "the", "group", "holdings", "holding",
]);

// Words a register name may add after a brand without becoming a different
// employer. Kept to industry and geography words on purpose: a noun like
// "tree" or "care" changes the business, so it must not be on this list.
const GENERIC_WORDS = new Set([
  "bank", "banking", "services", "service", "solutions", "technologies", "technology", "tech",
  "consulting", "consultancy", "consultants", "financial", "finance", "international", "global",
  "europe", "european", "emea", "britain", "british", "england", "london", "operations",
  "management", "systems", "software", "digital", "retail", "trading", "partners", "capital",
  "enterprises", "enterprise", "industries", "investments", "investment", "asset", "markets",
  "securities", "labs", "media", "studios", "worldwide", "and", "of", "advisory", "research",
  "engineering", "manufacturing", "products", "networks", "communications", "insurance",
  "stores", "store", "supermarkets", "national", "association",
]);

// Below this many letters a bare brand ("bt", "ey") is too short to prefix-match
// safely; it still matches exactly.
const MIN_PREFIX_LEN = 3;

export function normalizeCompany(raw) {
  const base = String(raw ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\+/g, " and ")
    // Join rather than split on these, so "Ltd." -> "ltd" and "McDonald's" ->
    // "mcdonalds" instead of "mcdonald s".
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!base) return "";
  const tokens = base.split(" ");
  const kept = tokens.filter((t) => !LEGAL_WORDS.has(t));
  // "The Group Ltd" would strip to nothing; keep the original words instead.
  const out = (kept.length ? kept : tokens).join(" ");
  // A trailing "and" is left over from "X & Co" once "co" is dropped.
  return out.replace(/(?:\s+and)+$/, "").trim();
}

const TRADING_AS_RX = /\s+(?:t\s*\/\s*a|trading\s+as)\s+/i;

/** Every normalised form a company name should be findable under. */
export function companyMatchKeys(raw) {
  const name = String(raw ?? "").trim();
  if (!name) return [];
  const parts = [name, ...name.split(TRADING_AS_RX)];
  return [...new Set(parts.map(normalizeCompany).filter(Boolean))];
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const pickBest = (docs) =>
  docs.find((d) => d.skilledWorker && d.ukvjVerified) ||
  docs.find((d) => d.skilledWorker) ||
  docs[0];

const SPONSOR_FIELDS = "name matchKeys skilledWorker ukvjVerified ukvjJobs routes cities registerDate";

// Remainder after the brand is only industry/geography words.
const allGeneric = (rest) => rest.split(" ").every((w) => GENERIC_WORDS.has(w));

/**
 * Look an employer up in the register, without the cache.
 *
 * All candidate queries go out together (one round trip), then the best match
 * wins in this order, strongest evidence first:
 *   1. exact on the register's own name        "Deloitte" = "Deloitte LLP"
 *   2. brand prefix + generic words             "Barclays" -> "Barclays Bank PLC"
 *   3. spaced-out brand written as one word     "JP Morgan" -> "JPMorgan Chase Bank"
 *   4. exact on a "t/a" trading name only       "The Amazon" (a restaurant) is
 *      last on purpose, so "Amazon" lands on Amazon UK Services Ltd instead.
 * @returns {{sponsor:boolean, match:"exact"|"prefix"|null, name:string|null,
 *            skilledWorker:boolean, ukvjVerified:boolean, routes:string[], reason:string|null}}
 */
export async function lookupUkSponsor(company, { model = UkVisaSponsorModel } = {}) {
  const keys = companyMatchKeys(company);
  const miss = (reason) => ({
    sponsor: false, match: null, name: null, skilledWorker: false, ukvjVerified: false, routes: [], reason,
  });
  if (!keys.length) return miss("NO_COMPANY_NAME");

  const toResult = (doc, match) => ({
    sponsor: doc.skilledWorker === true,
    match,
    name: doc.name,
    skilledWorker: doc.skilledWorker === true,
    ukvjVerified: doc.ukvjVerified === true,
    routes: doc.routes || [],
    reason: doc.skilledWorker ? null : "NO_SKILLED_WORKER_ROUTE",
  });
  // Anchored, case-sensitive regex on an indexed field: Mongo turns this into
  // an index range scan over keys starting with the prefix, not a full scan.
  const byRegex = (rx) => model.find({ matchKeys: { $regex: rx } }).select(SPONSOR_FIELDS).limit(200).lean();

  // The job may carry generic words the register lacks ("Lloyds Banking Group"
  // vs "Lloyds Bank plc"), so also try the brand with those trimmed off.
  const brand = keys[0].split(" ");
  while (brand.length > 1 && GENERIC_WORDS.has(brand[brand.length - 1])) brand.pop();
  const heads = [...new Set([...keys, brand.join(" ")])]
    .filter((k) => k.replace(/\s/g, "").length >= MIN_PREFIX_LEN);
  // "JP Morgan" -> "jpmorgan": only for multi-word names, where the join is a
  // deliberate spelling of one brand rather than a coincidence.
  const compact = keys[0].includes(" ") ? keys[0].replace(/ /g, "") : "";
  const [exact, prefixSets, compactDocs] = await Promise.all([
    model.find({ matchKeys: { $in: keys } }).select(SPONSOR_FIELDS).limit(25).lean(),
    Promise.all(heads.map((h) => byRegex(`^${escapeRegex(`${h} `)}`))),
    compact.length >= 5 ? byRegex(`^${escapeRegex(compact)}( |$)`) : Promise.resolve([]),
  ]);

  // 1. exact on the primary name (matchKeys[0] is the whole register name).
  const primary = exact.filter((d) => keys.includes((d.matchKeys || [])[0]));
  if (primary.length) return toResult(pickBest(primary), "exact");

  // 2. brand prefix, extra words generic only.
  const prefixHits = [];
  heads.forEach((h, i) => {
    const head = `${h} `;
    for (const d of prefixSets[i]) {
      if ((d.matchKeys || []).some((k) => k.startsWith(head) && allGeneric(k.slice(head.length)))) prefixHits.push(d);
    }
  });
  if (prefixHits.length) return toResult(pickBest(prefixHits), "prefix");

  // 3. spaced-out brand: the register's first word is the joined query.
  const compactHits = compactDocs.filter((d) => ((d.matchKeys || [])[0] || "").split(" ")[0] === compact);
  if (compactHits.length) return toResult(pickBest(compactHits), "prefix");

  // 4. trading-name alias.
  if (exact.length) return toResult(pickBest(exact), "exact");
  return miss("NOT_ON_REGISTER");
}

// ---- cache ------------------------------------------------------------------
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 5000;
const cache = new Map();

export function clearUkSponsorCache() {
  cache.clear();
  registerSize = { n: null, at: 0 };
}

/** Cached lookupUkSponsor. Misses are cached too; the register changes daily. */
export async function findUkSponsor(company, deps = {}) {
  const key = companyMatchKeys(company).join("|");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await lookupUkSponsor(company, deps);
  cache.delete(key);
  cache.set(key, { value, at: Date.now() });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); // oldest first
  return value;
}

// An empty collection would make every employer "not a sponsor" and silently
// block every push for every opted-in client. Refuse loudly instead.
let registerSize = { n: null, at: 0 };
async function assertRegisterLoaded(model = UkVisaSponsorModel) {
  if (registerSize.n == null || Date.now() - registerSize.at > 10 * 60 * 1000) {
    registerSize = { n: await model.estimatedDocumentCount(), at: Date.now() };
  }
  if (!registerSize.n) {
    const err = new Error("UK sponsor register is empty - run scripts/import-uk-visa-sponsors.mjs");
    err.code = "SPONSOR_REGISTER_EMPTY";
    throw err;
  }
}

// ---- who is a UK client -----------------------------------------------------
const UK_COUNTRY = "UK";

/** Pure rule, shared with clients-tracking's Client Job Analysis derivation. */
// Mirrors clients-tracking's Client Job Analysis (applications_monitor_backend
// index.js, clientCountry derivation) rule for rule, so both screens agree.
export function deriveClientCountry(trackingDoc) {
  const set = trackingDoc?.clientCountry;
  if (["USA", "Canada", "UK", "Australia", "Europe"].includes(set)) return { country: set, source: "clientCountry" };
  const amt = String(trackingDoc?.amountPaid ?? "");
  const byPayment =
    amt.startsWith("CAD") ? "Canada"
    : amt.startsWith("AUD") ? "Australia"
    : amt.startsWith("£") ? UK_COUNTRY
    : amt.startsWith("€") ? "Europe"
    : amt.startsWith("$") || amt.startsWith("₹") ? "USA"
    : null;
  return byPayment ? { country: byPayment, source: "amountPaid" } : { country: null, source: null };
}

export async function resolveClientCountry(email, { collection } = {}) {
  const e = String(email || "").trim().toLowerCase();
  if (!e.includes("@")) return { email: e, isUk: false, isUs: false, isAu: false, isEu: false, country: null, source: null };
  const col = collection || mongoose.connection.collection(TRACKING_COLLECTION);
  const doc = await col.findOne({ email: e }, { projection: { clientCountry: 1, amountPaid: 1 } });
  const { country, source } = deriveClientCountry(doc);
  return { email: e, isUk: country === UK_COUNTRY, isUs: country === "USA", isAu: country === "Australia", isEu: country === "Europe", country, source };
}

// ---- the push gate ----------------------------------------------------------

/**
 * Should this operator push be refused?
 * Returns null to allow, or { status, error, message, sponsor } to refuse.
 * Throws on database errors; callers answer 503 (fail closed - letting a
 * non-sponsor through is the exact mistake this switch exists to prevent).
 *
 * @param {object} p
 * @param {string} p.email        client email
 * @param {string} p.companyName  employer on the job
 * @param {object} [p.profile]    already-loaded profile, to skip the read
 */
export async function ukSponsorPushBlock({ email, companyName, profile }, deps = {}) {
  const gate = await ukSponsorGate({ email, profile }, deps);
  return gate ? gate.check(companyName) : null;
}

/**
 * Resolve the switch once, then check many employers. Returns null when the
 * gate does not apply to this client, else { check(companyName) } where check
 * resolves to null (allow) or the same refusal object ukSponsorPushBlock gives.
 * Used by the Job API run, which checks a whole batch for one client.
 */
export async function ukSponsorGate({ email, profile }, deps = {}) {
  const prof = profile !== undefined
    ? profile
    : await ProfileModel.findOne({ email: String(email || "").toLowerCase().trim() })
        .select("ukSponsorOnly")
        .lean();
  if (!prof?.ukSponsorOnly) return null;

  const client = await resolveClientCountry(email, deps);
  // The switch is only offered to UK clients. If ops later re-tagged the
  // client to another country the switch no longer applies.
  if (!client.isUk) return null;

  await assertRegisterLoaded(deps.model);
  return {
    async check(companyName) {
      const r = await findUkSponsor(companyName, deps);
      if (r.sponsor) return null;
      const who = String(companyName || "").trim() || "(no company name)";
      const message = r.reason === "NO_SKILLED_WORKER_ROUTE"
        ? `${who} holds a UK sponsor licence (${r.name}) but not for the Skilled Worker route, so it cannot sponsor this job. Client is set to UK visa sponsors only.`
        : `${who} is not on the Home Office register of licensed sponsors. Client is set to UK visa sponsors only.`;
      return { status: 403, error: "NOT_UK_VISA_SPONSOR", message, sponsor: r };
    },
  };
}

// ---- where the client wants to work -----------------------------------------

const UK_NATIONS = new Map([
  ["england", "England"], ["scotland", "Scotland"], ["wales", "Wales"],
  ["northern ireland", "Northern Ireland"], ["ni", "Northern Ireland"],
]);
const WHOLE_UK_RX = /^(uk|u k|united kingdom|great britain|gb|britain|anywhere in the uk|uk wide|nationwide)$/;
// Words that are about the work arrangement, not a place.
const NOT_A_PLACE_RX = /^(remote|hybrid|on ?site|onsite|in office|flexible|anywhere|open to relocation|relocation|willing to relocate|any)$/;
const LONDON_RX = /^(greater )?london$|^(central|east|west|north|south) london$|^city of london$/;

/**
 * Split free-text preferred locations into places, and say what the register
 * knows about each:
 *   kind "city"   - count of Skilled Worker sponsors registered there
 *   kind "london" - Greater London, using the importer's london flag
 *   kind "nation" / "uk" - the register has no nation column, so these are
 *                          labelled, not counted per nation
 *   kind "other"  - not a UK place the register knows (e.g. "Dubai", "Remote")
 * The register records the sponsor's registered address, not every office, so
 * these counts describe where sponsors are based - useful context, never a filter.
 */
export async function sponsorCountsForPlaces(preferredLocations, { model = UkVisaSponsorModel } = {}) {
  const seen = new Set();
  const places = [];
  for (const raw of Array.isArray(preferredLocations) ? preferredLocations : []) {
    for (const part of String(raw || "").split(/[,;/|()]|\s+-\s+|\s+or\s+|\s+and\s+/i)) {
      const label = part.replace(/\s+/g, " ").trim();
      const key = label.toLowerCase().replace(/[^a-z ]/g, "").trim();
      if (!key || key.length > 40 || seen.has(key)) continue;
      seen.add(key);
      places.push({ label, key });
    }
  }
  const out = [];
  for (const { label, key } of places.slice(0, 20)) {
    if (NOT_A_PLACE_RX.test(key)) continue;
    if (WHOLE_UK_RX.test(key)) { out.push({ place: "Whole UK", kind: "uk", sponsors: null }); continue; }
    if (UK_NATIONS.has(key)) { out.push({ place: UK_NATIONS.get(key), kind: "nation", sponsors: null }); continue; }
    if (LONDON_RX.test(key)) {
      out.push({ place: "London", kind: "london",
        sponsors: await model.countDocuments({ london: true, skilledWorker: true }) });
      continue;
    }
    const n = await model.countDocuments({ cities: label, skilledWorker: true }, { collation: CITY_COLLATION });
    out.push({ place: label, kind: n ? "city" : "other", sponsors: n || 0 });
  }
  // "London, UK" means London. Keep "Whole UK" only when nothing narrower was given.
  const specific = out.some((o) => o.kind !== "uk" && o.kind !== "other");
  return specific ? out.filter((o) => o.kind !== "uk") : out;
}
