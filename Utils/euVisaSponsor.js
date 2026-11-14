// "Europe visa sponsors only": for a Europe client with the switch on, every
// job an operator pushes must be one the client can actually be hired into
// from outside the EU. Same contract as the UK, US and Australia gates; like
// the US and Australian ones, the data lives in MEMORY.
//
// Only two European countries publish employer lists, so the check depends on
// WHERE the job is (its location, read with europeClients.js):
//   NL  the employer must be on the IND public register of recognised
//       sponsors. Dutch law requires it to hire a highly skilled migrant.
//   IE  the employer must have been issued Irish employment permits this
//       year or last (Department of Enterprise company lists).
//   anywhere else (Germany, France, Finland, ...) there is no sponsor licence:
//       any employer can hire on an EU Blue Card, so there is no list to check.
//       Only the posting is read.
// A job whose location names several countries passes if any of them passes.
//
// Every job is also read for "EU citizens only", "must have the right to work
// in the EU", "Stamp 4 required" (Utils/euNoSponsorshipText.js).
//
// Data: data/eu-visa-sponsors.json.gz from DASH/eu-visa-sponsors/refresh.sh, as
// rows [name, country, kvk, permitsByYear].
//
// Who is a Europe client: dashboardtrackings.clientCountry === "Europe", or,
// when unset, a "€" amountPaid (resolveClientCountry in ukVisaSponsor.js).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { ProfileModel } from "../Schema_Models/ProfileModel.js";
import { resolveClientCountry } from "./ukVisaSponsor.js";
import { europeanLocations } from "./europeClients.js";
import { detectEuNoSponsorship } from "./euNoSponsorshipText.js";
import { createSponsorMatcher } from "./sponsorMatch.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EU_SPONSOR_FILE = process.env.EU_SPONSOR_FILE || path.resolve(HERE, "../data/eu-visa-sponsors.json.gz");

// Countries with an employer list, keyed by europeClients.js's ISO codes.
export const EU_LIST_COUNTRIES = { nl: "NL", ie: "IE" };

// Legal forms: Dutch (B.V., N.V., V.O.F., C.V.), Irish (Ltd, DAC, UC, CLG,
// Teoranta), and the usual international ones. "Koninklijke" (Royal) is part
// of a Dutch registered name, never of the brand: "Koninklijke Philips" is Philips.
const LEGAL = new Set([
  "bv", "nv", "vof", "cv", "limited", "ltd", "dac", "uc", "unlimited", "company", "clg",
  "teoranta", "teo", "plc", "llp", "lp", "llc", "inc", "incorporated", "corp", "corporation",
  "co", "gmbh", "sarl", "sa", "ag", "se", "the", "koninklijke",
]);

const GENERIC = new Set([
  "netherlands", "nederland", "holland", "dutch", "ireland", "irish", "dublin", "cork", "galway",
  "limerick", "amsterdam", "rotterdam", "eindhoven", "utrecht", "europe", "european", "emea",
  "eu", "international", "global", "worldwide", "services", "service", "technologies",
  "technology", "tech", "group", "holding", "holdings", "solutions", "systems", "software",
  "consulting", "development", "data", "cloud", "payments", "operations", "management",
  "branch", "centre", "center", "digital", "pharmaceuticals", "pharma", "healthcare",
  "manufacturing", "research", "financial", "finance", "bank", "banking", "labs", "media",
  "enterprise", "enterprises", "partners", "capital", "insurance", "markets", "securities",
  "engineering", "products", "networks", "communications", "retail", "trading", "business",
  "corporate", "commercial", "support", "platforms", "and", "of",
]);

const ALIASES = new Map([
  ["meta", ["meta platforms", "facebook"]],
  ["facebook", ["meta platforms", "facebook"]],
  ["aws", ["amazon web services"]],
  ["ey", ["ernst and young"]],
  ["pwc", ["pricewaterhousecoopers"]],
  ["tcs", ["tata consultancy services"]],
  ["philips", ["philips"]],
  ["ing", ["ing bank"]],
  ["abn amro", ["abn amro bank"]],
]);

const totalPermits = (e) => Object.values(e.permits || {}).reduce((a, b) => a + (Number(b) || 0), 0);

const matcher = createSponsorMatcher({
  legal: LEGAL,
  generic: GENERIC,
  aliases: ALIASES,
  // "X trading as Y" / "X t/a Y" both name the employer.
  splitRx: /\s+(?:t\s*\/\s*a|trading\s+as|h\.?o\.?d\.?n\.?)\s+/i,
  gluedLegalRx: /(?:limited|ltd|bv|nv)$/,
  // Irish rows: the employer with the most permits wins a shared key.
  weight: totalPermits,
});
export const euNameKeys = matcher.nameKeys;

// Irish employers need at least this many permits (this year + last) to count.
const envInt = (name, fallback) => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
export const EU_IE_MIN_PERMITS = envInt("EU_IE_MIN_PERMITS", 1);

// ---- the in-memory index ----------------------------------------------------

let index = null;

/** Build one index per country from the decoded file. Exported for tests. */
export function buildEuSponsorIndex(data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const byCountry = {};
  for (const code of Object.values(EU_LIST_COUNTRIES)) {
    const entries = rows
      .filter((r) => r[1] === code)
      .map(([name, country, kvk, permits]) => ({ name, country, kvk: kvk || null, permits: permits || {} }));
    byCountry[code] = { ...matcher.buildIndex(entries), employers: entries.length };
  }
  return { byCountry, meta: data?.meta || {}, employers: rows.length, loadedAt: new Date() };
}

export function loadEuSponsors({ file = EU_SPONSOR_FILE } = {}) {
  const t0 = Date.now();
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
  const built = buildEuSponsorIndex(data);
  if (!built.employers) throw new Error(`${file} has no sponsor rows`);
  index = built;
  console.log(`[euVisaSponsor] loaded ${built.employers} European sponsors (NL ${built.byCountry.NL.employers}, IE ${built.byCountry.IE.employers}) in ${Date.now() - t0}ms`);
  return euSponsorStatus();
}

/** For tests: install an index built from fixture rows (or null to unload). */
export function setEuSponsorIndex(built) { index = built; }

export function euSponsorStatus() {
  if (!index) return { loaded: false, employers: 0, builtAt: null, loadedAt: null, countries: {} };
  return {
    loaded: true,
    employers: index.employers,
    builtAt: index.meta.builtAt || null,
    loadedAt: index.loadedAt,
    // { NL: { label, asOf, sponsors, url }, IE: {...} } for the clients-tracking footer
    countries: index.meta.countries || {},
  };
}

function assertLoaded() {
  if (index) return index;
  try {
    loadEuSponsors();
    return index;
  } catch (e) {
    const err = new Error(`European sponsor data is not loaded (${e.message})`);
    err.code = "EU_SPONSOR_DATA_NOT_LOADED";
    throw err;
  }
}

// Towns europeClients.js does not know, for the two countries where a miss
// matters: an unrecognised Dutch or Irish town would skip the employer check.
const LISTED_TOWNS = {
  nl: ["amstelveen", "almere", "apeldoorn", "arnhem", "breda", "delft", "den bosch", "'s-hertogenbosch",
    "s-hertogenbosch", "den haag", "deventer", "enschede", "groningen", "haarlem", "haarlemmermeer",
    "hilversum", "hoofddorp", "leeuwarden", "leiden", "maastricht", "nijmegen", "schiphol", "tilburg",
    "veldhoven", "venlo", "zwolle", "zoetermeer", "wageningen", "amersfoort", "alkmaar", "dordrecht",
    "helmond", "diemen", "rijswijk", "naarden", "hengelo", "noord-holland", "zuid-holland", "noord-brabant"],
  ie: ["galway", "limerick", "waterford", "athlone", "sligo", "kilkenny", "drogheda", "dundalk", "swords",
    "dun laoghaire", "sandyford", "blanchardstown", "tallaght", "leixlip", "maynooth", "carlow", "letterkenny",
    "ennis", "shannon", "naas", "tralee", "wexford", "co. dublin", "county dublin", "co dublin", "co. cork",
    "co. galway", "co. kildare", "co. limerick", "co. meath", "co. wicklow"],
};
const TOWN_RX = Object.fromEntries(Object.entries(LISTED_TOWNS).map(([iso, towns]) => [
  iso, new RegExp(`(?:^|[^a-z])(?:${towns.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:$|[^a-z])`, "i"),
]));

/** The job's countries that have an employer list ("Amsterdam" -> ["NL"]). */
export function listCountriesOf(jobLocation) {
  const text = String(jobLocation || "");
  const countries = [...europeanLocations([text]).countries];
  for (const [iso, rx] of Object.entries(TOWN_RX)) {
    if (!countries.includes(iso) && rx.test(text)) countries.push(iso);
  }
  return { all: countries, listed: countries.map((c) => EU_LIST_COUNTRIES[c]).filter(Boolean) };
}

/** One country's verdict for an employer. */
function checkCountry(idx, code, company) {
  const { entry, match, reason } = matcher.find(idx.byCountry[code], company);
  if (!entry) {
    return { country: code, sponsor: false, match: null, name: null, kvk: null, permits: {},
      reason: reason === "NO_COMPANY_NAME" ? reason : code === "NL" ? "NOT_IND_RECOGNISED_SPONSOR" : "NO_IRISH_PERMITS" };
  }
  const enough = code !== "IE" || totalPermits(entry) >= EU_IE_MIN_PERMITS;
  return { country: code, sponsor: enough, match, name: entry.name, kvk: entry.kvk, permits: entry.permits,
    reason: enough ? null : "TOO_FEW_IRISH_PERMITS" };
}

/**
 * Can this employer hire a non-EU candidate for a job here? Synchronous, in memory.
 * @param {string} company
 * @param {string} [jobLocation]  free text; decides which list applies
 * @returns {{ sponsor: boolean, basis: "LISTED"|"NO_LIST"|null, jobCountries: string[],
 *             checked: object[], match, name, country, kvk, permits, reason }}
 *   basis "NO_LIST": the job is somewhere with no employer list (or no known
 *   place), so the employer is not checked; only the posting is.
 */
export function lookupEuSponsor(company, jobLocation) {
  const idx = assertLoaded();
  const { all, listed } = listCountriesOf(jobLocation);
  // No country with a list in the location: report what the lists say anyway
  // (useful in clients-tracking), but do not refuse on it.
  const codes = listed.length ? listed : Object.values(EU_LIST_COUNTRIES);
  const checked = codes.map((code) => checkCountry(idx, code, company));
  const hit = checked.find((c) => c.sponsor) || checked.find((c) => c.name) || checked[0];
  const base = { jobCountries: all, checked, match: hit.match, name: hit.name, country: hit.name ? hit.country : null,
    kvk: hit.kvk, permits: hit.permits };
  if (!String(company || "").trim()) return { ...base, sponsor: false, basis: null, reason: "NO_COMPANY_NAME" };
  if (!listed.length) return { ...base, sponsor: true, basis: "NO_LIST", reason: null };
  const pass = checked.find((c) => c.sponsor);
  return pass
    ? { ...base, sponsor: true, basis: "LISTED", reason: null }
    : { ...base, sponsor: false, basis: null, reason: hit.reason };
}

const POSTING_REFUSAL = {
  NO_SPONSORSHIP: "says it will not sponsor a visa",
  WORK_RIGHTS: "needs an existing right to work in the EU",
  CITIZENS_ONLY: "is for EU citizens only",
};

/** The 403 message for a refused employer. Exported for tests. */
export function euSponsorRefusal(companyName, r) {
  const who = String(companyName || "").trim() || "(no company name)";
  const tail = "Client is set to Europe visa sponsors only.";
  const failed = r.checked.filter((c) => !c.sponsor);
  const parts = failed.map((c) => {
    if (c.reason === "NOT_IND_RECOGNISED_SPONSOR") return `is not an IND recognised sponsor, which a Dutch employer needs to hire a highly skilled migrant`;
    if (c.reason === "TOO_FEW_IRISH_PERMITS") return `(${c.name}) has too few Irish employment permits`;
    return `has no Irish employment permits this year or last`;
  });
  return `${who} ${parts.join(", and ")}. ${tail}`;
}

// ---- the push gate ----------------------------------------------------------

/**
 * null when the gate does not apply to this client, else
 * { check(companyName, jobDescription?, jobLocation?) } returning null (allow) or
 * { status: 403, error: "NOT_EU_VISA_SPONSOR", message, sponsor, posting }.
 * Throws EU_SPONSOR_DATA_NOT_LOADED when opted in but the data is missing.
 */
export async function euSponsorGate({ email, profile }, deps = {}) {
  const prof = profile !== undefined
    ? profile
    : await ProfileModel.findOne({ email: String(email || "").toLowerCase().trim() })
        .select("euSponsorOnly")
        .lean();
  if (!prof?.euSponsorOnly) return null;
  const client = await resolveClientCountry(email, deps);
  if (!client.isEu) return null;
  assertLoaded();
  return {
    check(companyName, jobDescription, jobLocation) {
      const r = lookupEuSponsor(companyName, jobLocation);
      if (!r.sponsor) {
        return { status: 403, error: "NOT_EU_VISA_SPONSOR", message: euSponsorRefusal(companyName, r), sponsor: r, posting: null };
      }
      const posting = detectEuNoSponsorship(jobDescription);
      if (posting.refuses) {
        const who = String(companyName || "").trim() || "This employer";
        return {
          status: 403,
          error: "NOT_EU_VISA_SPONSOR",
          message: `${who}: this posting ${POSTING_REFUSAL[posting.kind]}: "${posting.quote}". Client is set to Europe visa sponsors only.`,
          sponsor: { ...r, sponsor: false, reason: `POSTING_${posting.kind}` },
          posting,
        };
      }
      return null;
    },
  };
}

/** null when the push may go ahead, else { status: 403, error, message, sponsor, posting }. */
export async function euSponsorPushBlock({ email, companyName, jobDescription, jobLocation, profile }, deps = {}) {
  const gate = await euSponsorGate({ email, profile }, deps);
  return gate ? gate.check(companyName, jobDescription, jobLocation) : null;
}

