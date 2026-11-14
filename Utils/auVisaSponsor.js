// "Australia visa sponsors only": for an Australian client with the switch on,
// every job an operator pushes must come from an employer the Department of
// Home Affairs has approved to sponsor skilled visas (subclass 482 / 186 / 494).
// Same contract as the UK and US gates (ukVisaSponsor.js, usVisaSponsor.js);
// like the US one, the data lives in MEMORY, not in Mongo.
//
// Data: data/au-visa-sponsors.json.gz, built by DASH/au-visa-sponsors/refresh.sh.
// Australia has no downloadable sponsor register (one was legislated in April
// 2026 and is not published yet), so the file is the union of everything Home
// Affairs has released:
//   LA   current labour agreements (live list, refreshed monthly)
//   A25  accredited sponsors, 15 Jan 2025 (FOI FA 25/01/01229)
//   A24  accredited sponsors, 11 Jan 2024 (FOI FA 24/01/00298)
//   S23  every active sponsor, 30 Sep 2023 (FOI FA 23/08/01597)
// as rows [name, sources, laTypes]. The names are normalised HERE, at load,
// so there is one set of matching rules instead of a Python and a JS copy.
//
// A Standard Business Sponsorship lasts five years, so a 2023 sponsor is
// usually still approved; an employer approved after Jan 2025 is the gap. The
// lookup reports which lists an employer is on and how recent the newest is.
//
// The posting is read too (Utils/auNoSponsorshipText.js): "must have full
// Australian working rights" or "Australian citizens only" is refused even
// when the employer sponsors.
//
// Where it runs: /addjob (extension + autopilot, operator pushes only),
// /job-api/run and /extension/saveToDashboard. /addjob answers 403
// NOT_AU_VISA_SPONSOR, which the extension files under "blocked" without
// spending the daily cap.
//
// Who is an Australian client: dashboardtrackings.clientCountry ===
// "Australia", or, when unset, an "AUD" amountPaid (resolveClientCountry in
// ukVisaSponsor.js, the same rule clients-tracking uses).
//
// Matching, strongest evidence first:
//   1. exact key                       "Atlassian" = "ATLASSIAN PTY LTD"
//   2. a short alias table             "NAB" -> National Australia Bank, "AWS" -> Amazon Web Services
//   3. brand + generic words only      "Commonwealth Bank" -> "Commonwealth Bank of Australia"
//   4. spaces ignored                  "Judo Bank" = OCR "JudoBankPtyLtd"; "Minter Ellison" = "MINTERELLISON"

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { ProfileModel } from "../Schema_Models/ProfileModel.js";
import { resolveClientCountry } from "./ukVisaSponsor.js";
import { detectAuNoSponsorship } from "./auNoSponsorshipText.js";
import { createSponsorMatcher } from "./sponsorMatch.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const AU_SPONSOR_FILE = process.env.AU_SPONSOR_FILE || path.resolve(HERE, "../data/au-visa-sponsors.json.gz");

// Legal-form and filler words that say nothing about WHICH employer it is.
// "Pty Ltd", "P/L", "Proprietary Limited", "(Aust)" and the trust wrapper
// ("The Trustee for X Trust") all go.
const LEGAL = new Set([
  "pty", "ltd", "limited", "proprietary", "pl", "inc", "incorporated", "co", "company", "corp",
  "corporation", "the", "llc", "plc", "llp", "lp", "nl", "gmbh", "ag", "sa", "bv", "nv",
]);

// Words a register name may add after a brand without becoming a different
// employer ("Commonwealth Bank" -> "commonwealth bank of australia").
// Industry and geography only: a noun like "care" or "tree" changes the business.
const GENERIC = new Set([
  "australia", "australian", "aust", "australasia", "australasian", "asia", "pacific", "apac",
  "oceania", "nz", "new", "zealand", "group", "holdings", "holding", "trust", "unit",
  "services", "service", "solutions", "technologies", "technology", "tech", "consulting",
  "consultancy", "consultants", "financial", "finance", "international", "global", "worldwide",
  "operations", "management", "systems", "software", "digital", "retail", "trading", "partners",
  "capital", "enterprises", "enterprise", "industries", "investments", "investment", "markets",
  "securities", "labs", "media", "studios", "research", "engineering", "products", "networks",
  "communications", "insurance", "bank", "banking", "advisory", "and", "of", "national",
  "nsw", "vic", "qld", "wa", "sa", "tas", "nt", "act", "sydney", "melbourne", "brisbane",
  "perth", "adelaide", "health", "healthcare", "anz", "administration", "commercial", "corporate",
  "support", "supermarkets", "supermarket", "private", "airways", "airlines", "institutional",
  "business", "professional", "operating", "computing", "constructors", "construction",
  "contracting", "contractors", "mining", "payments",
]);

// Brands job boards use that the sponsor list never contains. Key is the
// normalised job-board name, value the normalised list keys to try.
const ALIASES = new Map([
  ["nab", ["national australia bank"]],
  ["anz", ["australia and new zealand banking", "australia and new zealand banking group"]],
  ["cba", ["commonwealth bank of australia"]],
  ["commbank", ["commonwealth bank of australia"]],
  ["deloitte", ["deloitte touche tohmatsu", "deloitte services"]],
  ["ey", ["ernst and young", "ernst and young services"]],
  ["pwc", ["pricewaterhousecoopers", "pricewaterhousecoopers consulting australia"]],
  ["optus", ["singtel optus"]],
  ["aws", ["amazon web services australia"]],
  ["amazon web services", ["amazon web services australia"]],
  ["csiro", ["commonwealth scientific and industrial research organisation"]],
  ["unsw", ["university of new south wales"]],
  ["tcs", ["tata consultancy services"]],
  ["meta", ["facebook australia"]],
  ["facebook", ["facebook australia"]],
  ["rea", ["realestatecomau"]],
  ["realestatecomau", ["realestatecomau"]],
  ["jll", ["jones lang lasalle"]],
  ["webuild", ["salini australia"]],
  ["programmed", ["programmed skilled workforce"]],
  ["downer", ["downer edi engineering power", "downer utilities australia"]],
  ["ausnet", ["ausnet transmission group"]],
  ["coates", ["coates hire operations"]],
  ["planit", ["planit test management solutions"]],
]);

const SOURCE_RANK = { LA: 0, A25: 1, A24: 2, S23: 3 };
// More lists, and newer ones, make a stronger entry when two share a key.
const weight = (e) => e.sources.length * 10 - Math.min(...e.sources.map((x) => SOURCE_RANK[x] ?? 9));

const matcher = createSponsorMatcher({
  legal: LEGAL,
  generic: GENERIC,
  aliases: ALIASES,
  // "The Trustee for X Trust" is X's trust.
  prefixRx: /^\s*(?:the\s+)?trustee\s+for\s+/i,
  // "X ATF Y", "X as trustee for Y", "X T/A Y", "X trading as Y": both halves are names.
  splitRx: /\s+(?:atf|a\/t\/f|as\s+trustee\s+for|t\s*\/\s*a|trading\s+as)\s+/i,
  // "NSW Department of Education" is listed as "Department of Education".
  leadingRx: /^\s*(?:nsw|vic|qld|wa|sa|tas|nt|act)\s+(?=\S+\s+\S)/i,
  // An OCR line keeps the legal form glued on: "judobankptyltd" -> "judobank".
  gluedLegalRx: /(?:ptyltd|ptylimited|proprietarylimited|limited|ltd|incorporated)$/,
  weight,
});
export const auNameKey = matcher.nameKey;
export const auNameKeys = matcher.nameKeys;
export const auCompactKey = matcher.compactKey;

// ---- the in-memory index ----------------------------------------------------

let index = null;

/** Build the maps from the decoded file. Exported for tests. */
export function buildAuSponsorIndex(data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const entries = rows.map(([name, sources, laTypes]) => ({
    name, sources: Array.isArray(sources) ? sources : [], laTypes: Array.isArray(laTypes) ? laTypes : [],
  }));
  const built = matcher.buildIndex(entries);
  return { ...built, meta: data?.meta || {}, employers: rows.length, keys: built.byKey.size, loadedAt: new Date() };
}

/**
 * Read data/au-visa-sponsors.json.gz into memory. Called once at server
 * start. Throws when the file is missing or empty, so the caller can log it;
 * the gate then refuses pushes for opted-in clients (503) instead of guessing.
 */
export function loadAuSponsors({ file = AU_SPONSOR_FILE } = {}) {
  const t0 = Date.now();
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
  const built = buildAuSponsorIndex(data);
  if (!built.employers) throw new Error(`${file} has no sponsor rows`);
  index = built;
  console.log(`[auVisaSponsor] loaded ${built.employers} Australian sponsors (${built.keys} keys) in ${Date.now() - t0}ms`);
  return auSponsorStatus();
}

/** For tests: install an index built from fixture rows (or null to unload). */
export function setAuSponsorIndex(built) { index = built; }

export function auSponsorStatus() {
  if (!index) return { loaded: false, employers: 0, keys: 0, builtAt: null, loadedAt: null, sources: {} };
  return {
    loaded: true,
    employers: index.employers,
    keys: index.keys,
    builtAt: index.meta.builtAt || null,
    loadedAt: index.loadedAt,
    // { LA: { label, asOf, sponsors, url }, ... } for the clients-tracking footer
    sources: index.meta.sources || {},
  };
}

function assertLoaded() {
  if (index) return index;
  try {
    loadAuSponsors();
    return index;
  } catch (e) {
    const err = new Error(`Australian sponsor data is not loaded (${e.message})`);
    err.code = "AU_SPONSOR_DATA_NOT_LOADED";
    throw err;
  }
}

/**
 * Is this employer an approved Australian sponsor? Synchronous, in memory.
 * @returns {{sponsor:boolean, match:"exact"|"prefix"|"compact"|"alias"|null, name:string|null,
 *            sources:string[], laTypes:string[], newestAsOf:string|null,
 *            reason:"NO_COMPANY_NAME"|"NOT_AN_AU_SPONSOR"|null}}
 */
export function lookupAuSponsor(company) {
  const idx = assertLoaded();
  const found = matcher.find(idx, company);
  const { entry, match } = found;
  const reason = found.reason === "NOT_LISTED" ? "NOT_AN_AU_SPONSOR" : found.reason;
  if (!entry) return { sponsor: false, match: null, name: null, sources: [], laTypes: [], newestAsOf: null, reason };
  const srcMeta = idx.meta.sources || {};
  const dates = entry.sources.map((s) => srcMeta[s]?.asOf).filter(Boolean).sort();
  return {
    sponsor: true,
    match,
    name: entry.name,
    sources: entry.sources,
    laTypes: entry.laTypes,
    newestAsOf: dates.length ? dates[dates.length - 1] : null,
    reason: null,
  };
}

const POSTING_REFUSAL = {
  NO_SPONSORSHIP: "says it will not sponsor a visa",
  WORK_RIGHTS: "needs full Australian working rights",
  CITIZENS_ONLY: "is for Australian citizens or permanent residents only",
  CLEARANCE: "needs an Australian security clearance (citizens only)",
};

/** The 403 message for a refused employer. Exported for tests. */
export function auSponsorRefusal(companyName) {
  const who = String(companyName || "").trim() || "(no company name)";
  return `${who} is not on any Home Affairs list of approved sponsors (labour agreements, or accredited and standard business sponsors released under FOI). Client is set to Australia visa sponsors only.`;
}

// ---- the push gate ----------------------------------------------------------

/**
 * null when the gate does not apply to this client, else
 * { check(companyName, jobDescription?) } where check returns null (allow) or
 * { status: 403, error: "NOT_AU_VISA_SPONSOR", message, sponsor, posting }.
 *
 * Throws AU_SPONSOR_DATA_NOT_LOADED when the client is opted in but the data
 * is missing; callers answer 503 (fail closed).
 */
export async function auSponsorGate({ email, profile }, deps = {}) {
  const prof = profile !== undefined
    ? profile
    : await ProfileModel.findOne({ email: String(email || "").toLowerCase().trim() })
        .select("auSponsorOnly")
        .lean();
  if (!prof?.auSponsorOnly) return null;
  const client = await resolveClientCountry(email, deps);
  // Offered to Australian clients only; a client re-tagged elsewhere is not gated.
  if (!client.isAu) return null;
  assertLoaded();
  return {
    check(companyName, jobDescription) {
      const r = lookupAuSponsor(companyName);
      if (!r.sponsor) {
        return { status: 403, error: "NOT_AU_VISA_SPONSOR", message: auSponsorRefusal(companyName), sponsor: r, posting: null };
      }
      const posting = detectAuNoSponsorship(jobDescription);
      if (posting.refuses) {
        const who = String(companyName || "").trim();
        return {
          status: 403,
          error: "NOT_AU_VISA_SPONSOR",
          message: `${who} is an approved sponsor, but this posting ${POSTING_REFUSAL[posting.kind]}: "${posting.quote}". Client is set to Australia visa sponsors only.`,
          sponsor: { ...r, sponsor: false, reason: `POSTING_${posting.kind}` },
          posting,
        };
      }
      return null;
    },
  };
}

/** null when the push may go ahead, else { status: 403, error, message, sponsor, posting }. */
export async function auSponsorPushBlock({ email, companyName, jobDescription, profile }, deps = {}) {
  const gate = await auSponsorGate({ email, profile }, deps);
  return gate ? gate.check(companyName, jobDescription) : null;
}
