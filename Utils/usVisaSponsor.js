// "US H-1B sponsors only": for a US client with the switch on, every job an
// operator pushes must come from an employer that has actually filed H-1B
// petitions recently. Same shape as "UK visa sponsors only" (ukVisaSponsor.js),
// with one difference: the data lives in MEMORY, not in Mongo.
//
// Data: data/us-h1b-sponsors.json.gz, built by DASH/us-visa-sponsors/refresh.sh
// from ellis.com (US Department of Labor LCA + PERM disclosure data) and
// flexapply.org. Every employer that filed a work-visa LCA (H-1B, E-3, H-1B1)
// or a green card (PERM) case, as
//   [name, matchKeys, lastH1bFiling, recentH1b, h1bFilings, domain, lastPermFiling, permFilings].
// loadUsSponsors() reads it once at server start (index.js) into hash maps,
// so a lookup is a few Map.get calls, no I/O.
//
// "Sponsor" (verdictOf below) = filed since US_SPONSOR_SINCE (default
// 2024-10-01, the start of DOL fiscal year 2025) AND did it more than once:
// US_SPONSOR_MIN_RECENT LCAs in the last four quarters or US_SPONSOR_MIN_FILINGS
// all time, or US_SPONSOR_MIN_PERM green card cases. Older and one-off filers
// stay in the maps so a refusal can say why.
//
// The posting is read too (Utils/noSponsorshipText.js): a big sponsor's
// posting that says "we are unable to sponsor" is refused like a non-sponsor.
//
// Where it runs: /addjob (extension + autopilot, operator pushes only),
// /job-api/run and /extension/saveToDashboard. /addjob answers 403
// NOT_US_H1B_SPONSOR, which the extension files under "blocked" without
// spending the daily cap.
//
// Who is a US client: dashboardtrackings.clientCountry === "USA", or, when that
// is unset, a "$" or "₹" amountPaid - exactly clients-tracking's rule
// (resolveClientCountry in ukVisaSponsor.js), so the two screens agree.
//
// Matching mirrors DASH/us-visa-sponsors/bin/build.py name_key() character for
// character (Utils/__tests__/usVisaSponsor.test.mjs pins it with keys the
// Python produced). Order, strongest evidence first:
//   1. exact key                      "Google" = "Google LLC"
//   2. brand + generic words only     "Meta" -> "Meta Platforms, Inc"
//   3. spaced brand written as one    "JP Morgan" -> "JPMorgan Chase & Co."
//   4. a short alias table for brands that file under another name
//      ("Chase" -> JPMorgan Chase, "AWS" -> Amazon Web Services)

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { ProfileModel } from "../Schema_Models/ProfileModel.js";
import { resolveClientCountry } from "./ukVisaSponsor.js";
import { detectNoSponsorship } from "./noSponsorshipText.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const US_SPONSOR_FILE = process.env.US_SPONSOR_FILE || path.resolve(HERE, "../data/us-h1b-sponsors.json.gz");
export const US_SPONSOR_SINCE = process.env.US_SPONSOR_SINCE || "2024-10-01";

// Same set as build.py LEGAL. Change both together.
const LEGAL = new Set([
  "inc", "incorporated", "llc", "l", "lc", "llp", "lp", "ltd", "limited", "corp", "corporation",
  "co", "company", "pc", "pllc", "plc", "pa", "psc", "sc", "na", "the", "dba", "gmbh", "ag", "sa",
  "bv", "nv", "srl", "pvt", "private", "holdings", "usa", "us",
]);

// Words a filer's name may add after the brand without becoming a different
// employer ("Meta" -> "meta platforms", "Walmart" -> "walmart associates").
// Industry and geography only: a noun like "tree" or "care" changes the business.
const GENERIC = new Set([
  "services", "service", "solutions", "technologies", "technology", "tech", "systems", "software",
  "consulting", "consultancy", "consultants", "financial", "finance", "international", "global",
  "worldwide", "america", "americas", "north", "operations", "management", "digital", "group",
  "partners", "associates", "enterprises", "enterprise", "industries", "platforms", "platform",
  "labs", "research", "development", "center", "web", "data", "networks", "communications",
  "health", "healthcare", "bank", "banking", "securities", "capital", "markets", "investments",
  "advisory", "engineering", "products", "media", "studios", "retail", "stores", "commerce",
  "national", "association", "and", "of", "corporate", "information", "it", "infotech",
  "united", "states",
]);

// Brands that job boards use but the H-1B filer never contains. Key is the
// normalised job-board name, value the normalised filer key to try.
const ALIASES = new Map([
  ["chase", ["jpmorgan chase", "jpmorgan chase bank"]],
  ["jp morgan chase", ["jpmorgan chase"]],
  ["aws", ["amazon web services"]],
  ["amazon", ["amazoncom services", "amazon web services"]],
  ["facebook", ["meta platforms"]],
  ["instagram", ["meta platforms"]],
  ["youtube", ["google"]],
  ["alphabet", ["google"]],
  ["bytedance", ["bytedance", "tiktok"]],
  ["ey", ["ernst and young"]],
  ["pwc", ["pricewaterhousecoopers", "pwc consulting"]],
  ["kpmg", ["kpmg"]],
  ["bofa", ["bank of america"]],
]);

const MIN_PREFIX_LEN = 3;

// How much filing makes a "sponsor". One H-1B since the cutoff used to be
// enough, which let through employers like Brighton Collectibles (1 filing,
// ever) whose postings say "no sponsorship". An employer passes when it filed
// since US_SPONSOR_SINCE AND has either a recent habit (US_SPONSOR_MIN_RECENT
// work-visa LCAs in the last four quarters) or a long one
// (US_SPONSOR_MIN_FILINGS all time). Green card (PERM) filing counts the same
// way: an employer that certified US_SPONSOR_MIN_PERM PERM cases and filed one
// since the cutoff is sponsoring someone.
const envInt = (name, fallback) => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
export const US_SPONSOR_MIN_RECENT = envInt("US_SPONSOR_MIN_RECENT", 2);
export const US_SPONSOR_MIN_FILINGS = envInt("US_SPONSOR_MIN_FILINGS", 5);
export const US_SPONSOR_MIN_PERM = envInt("US_SPONSOR_MIN_PERM", 2);

// A job name with its generic tail trimmed ("Scale Media" -> "scale") is weak
// evidence: "scale" + "labs" found Ava Labs (filed as "Scale Labs"). Such a
// match only counts for a big filer, where the brand is unambiguous
// ("Walmart Global Tech" -> WAL-MART ASSOCIATES).
const TRIMMED_PREFIX_MIN_FILINGS = 100;

// "US Ignite" and "U.S. Bank" lose their leading "US" in the key ("us" is a
// legal word, so "Amazon US" = "Amazon"). A name that starts with it is a
// different employer from one that does not: "Ignite Digital" is not US
// Ignite, and "US Bank" is not Bank of America.
const LEADING_US = /^\s*u\.?\s?s\.?(?:a\.?)?\s+/i;
const leadsWithUs = (name) => LEADING_US.test(String(name ?? ""));

/** build.py name_key(), in JS. Pinned by tests against the Python output. */
export function usNameKey(raw) {
  let s = String(raw ?? "");
  // clean(): encoding junk, stray quotes / leading "?", whitespace
  s = s.replace(/[¿�]/g, "")
    .replace(/^[\s?"'`]+|[\s"'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  s = s.normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.'’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!s) return "";
  const words = s.split(" ");
  const core = words.filter((w) => !LEGAL.has(w));
  return (core.length ? core : words).join(" ").replace(/(?: and)+$/, "");
}

/** The keys a job-board company name is looked up under: as is, hyphens
 *  joined, and without a parenthetical ("Amazon Web Services (AWS)"). */
export function usQueryKeys(raw) {
  const name = String(raw ?? "");
  const bare = name.replace(/\([^)]*\)/g, " ");
  return [...new Set([name, name.replace(/-/g, ""), bare, bare.replace(/-/g, "")].map(usNameKey))].filter(Boolean);
}

// ---- the in-memory index ----------------------------------------------------

// { byKey: Map<key, entry>, sorted: key[] (for prefix scans), meta, since, ... }
let index = null;

const weight = (e) => e.recentH1b * 10 + e.h1bFilings + e.permFilings;

/** Build the maps from the decoded file. Exported for tests. Rows written
 *  before 2026-11 stop at domain; the PERM and E-3/H-1B1 columns are optional. */
export function buildUsSponsorIndex(data, { since = US_SPONSOR_SINCE } = {}) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const byKey = new Map();
  for (const [name, keys, last, recentH1b, h1bFilings, domain, lastPerm, permFilings] of rows) {
    const entry = {
      name, last: last || null, recentH1b: recentH1b || 0, h1bFilings: h1bFilings || 0, domain: domain || null,
      lastPerm: lastPerm || null, permFilings: permFilings || 0,
    };
    for (const key of keys || []) {
      const prev = byKey.get(key);
      if (prev && weight(prev) >= weight(entry)) continue;
      byKey.set(key, entry);
    }
  }
  // One sorted key array instead of a per-word index: a prefix scan is a
  // binary search plus a short walk, and it costs no extra objects.
  const sorted = [...byKey.keys()].sort();
  return { byKey, sorted, meta: data?.meta || {}, since, employers: rows.length, keys: byKey.size, loadedAt: new Date() };
}

/**
 * Read data/us-h1b-sponsors.json.gz into memory. Called once at server start.
 * Throws when the file is missing or empty, so the caller can log it; the
 * gate then refuses pushes for opted-in clients (503) instead of guessing.
 */
export function loadUsSponsors({ file = US_SPONSOR_FILE, since = US_SPONSOR_SINCE } = {}) {
  const t0 = Date.now();
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
  const built = buildUsSponsorIndex(data, { since });
  if (!built.employers) throw new Error(`${file} has no sponsor rows`);
  index = built;
  console.log(`[usVisaSponsor] loaded ${built.employers} H-1B employers (${built.keys} keys, sponsor = filed since ${since}) in ${Date.now() - t0}ms`);
  return usSponsorStatus();
}

/** For tests: install an index built from fixture rows (or null to unload). */
export function setUsSponsorIndex(built) { index = built; }

export function usSponsorStatus() {
  return index
    ? { loaded: true, employers: index.employers, keys: index.keys, since: index.since, builtAt: index.meta.builtAt || null, loadedAt: index.loadedAt }
    : { loaded: false, employers: 0, keys: 0, since: US_SPONSOR_SINCE, builtAt: null, loadedAt: null };
}

function assertLoaded() {
  if (index) return index;
  // A script or a test that never ran the startup hook: try once, lazily.
  try {
    loadUsSponsors();
    return index;
  } catch (e) {
    const err = new Error(`US H-1B sponsor data is not loaded (${e.message})`);
    err.code = "US_SPONSOR_DATA_NOT_LOADED";
    throw err;
  }
}

const allGeneric = (rest) => rest.split(" ").every((w) => GENERIC.has(w));
const best = (entries) => entries.reduce((a, b) => (weight(b) > weight(a) ? b : a));

/**
 * Is this employer a sponsor, from its filing record alone?
 *   basis "H1B"   a work-visa LCA since the cutoff, and enough of them
 *   basis "PERM"  a green card filing since the cutoff, and enough of them
 * reason when not: TOO_FEW_FILINGS (filed since the cutoff, but once or
 * twice) or NO_RECENT_H1B (nothing since the cutoff).
 */
function verdictOf(e, since) {
  const lcaLive = !!e.last && e.last >= since;
  const permLive = !!e.lastPerm && e.lastPerm >= since;
  if (lcaLive && (e.recentH1b >= US_SPONSOR_MIN_RECENT || e.h1bFilings >= US_SPONSOR_MIN_FILINGS)) {
    return { sponsor: true, basis: "H1B", reason: null };
  }
  if (permLive && e.permFilings >= US_SPONSOR_MIN_PERM) return { sponsor: true, basis: "PERM", reason: null };
  return { sponsor: false, basis: null, reason: lcaLive || permLive ? "TOO_FEW_FILINGS" : "NO_RECENT_H1B" };
}

/** Every [key, entry] whose key starts with `prefix`. */
function* withPrefix(idx, prefix) {
  const keys = idx.sorted;
  let lo = 0, hi = keys.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (keys[mid] < prefix) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < keys.length && keys[i].startsWith(prefix); i++) yield [keys[i], idx.byKey.get(keys[i])];
}

function findEntry(idx, company) {
  const keys = usQueryKeys(company);
  if (!keys.length) return { entry: null, match: null, reason: "NO_COMPANY_NAME" };
  const live = (e) => verdictOf(e, idx.since).sponsor;
  const wantsUs = leadsWithUs(company);
  const sameUs = (e) => leadsWithUs(e.name) === wantsUs;

  // Each tier is a list of candidate employers, strongest evidence first. The
  // first tier holding a live sponsor wins. An exact hit on a dead filer must
  // not stop the search: "Meta" is also "META Company" (last H-1B 2017), and
  // "Amazon" is also "Amazon CORP LLC" (2017).
  const tiers = [];

  // 1. exact
  tiers.push(["exact", keys.map((k) => idx.byKey.get(k)).filter(Boolean)]);

  // 2. brand + generic words. Also try the job's name with ITS trailing
  //    generic words trimmed ("Walmart Global Tech" -> "walmart"), which only
  //    counts for a big filer (TRIMMED_PREFIX_MIN_FILINGS).
  const heads = new Map(keys.map((k) => [k, false]));
  for (const k of keys) {
    const w = k.split(" ");
    while (w.length > 1 && GENERIC.has(w[w.length - 1])) w.pop();
    const h = w.join(" ");
    if (!heads.has(h)) heads.set(h, true);
  }
  const prefixHits = [];
  for (const [h, trimmed] of heads) {
    if (h.replace(/ /g, "").length < MIN_PREFIX_LEN) continue;
    const ok = (e) => !trimmed || e.h1bFilings >= TRIMMED_PREFIX_MIN_FILINGS;
    if (trimmed && idx.byKey.has(h) && ok(idx.byKey.get(h))) prefixHits.push(idx.byKey.get(h));
    const head = `${h} `;
    for (const [key, entry] of withPrefix(idx, head)) {
      if (allGeneric(key.slice(head.length)) && ok(entry)) prefixHits.push(entry);
    }
  }
  tiers.push(["prefix", prefixHits]);

  // 3. "JP Morgan" -> "jpmorgan ...": only for multi-word names, where joining
  //    is a deliberate spelling of one brand, and only 5+ letters.
  const compactHits = [];
  for (const k of keys) {
    if (!k.includes(" ")) continue;
    const joined = k.replace(/ /g, "");
    if (joined.length < 5) continue;
    if (idx.byKey.has(joined)) compactHits.push(idx.byKey.get(joined));
    for (const [, entry] of withPrefix(idx, `${joined} `)) compactHits.push(entry);
  }
  tiers.push(["prefix", compactHits]);

  // 4. brands that file under another name
  tiers.push(["alias", keys.flatMap((k) => (ALIASES.get(k) || []).map((t) => idx.byKey.get(t)).filter(Boolean))]);

  for (const t of tiers) t[1] = t[1].filter(sameUs);
  for (const [match, hits] of tiers) {
    const good = hits.filter(live);
    if (good.length) return { entry: best(good), match };
  }
  // No live sponsor anywhere: report the strongest other one, for the reason.
  for (const [match, hits] of tiers) {
    if (hits.length) return { entry: best(hits), match };
  }
  return { entry: null, match: null, reason: "NOT_AN_H1B_FILER" };
}

/**
 * Is this employer a US visa sponsor? Synchronous, in-memory.
 * @returns {{sponsor:boolean, basis:"H1B"|"PERM"|null, match:"exact"|"prefix"|"alias"|null,
 *            name:string|null, lastH1bFiling:string|null, recentH1b:number, h1bFilings:number,
 *            lastPermFiling:string|null, permFilings:number, domain:string|null,
 *            reason:"NO_COMPANY_NAME"|"NOT_AN_H1B_FILER"|"NO_RECENT_H1B"|"TOO_FEW_FILINGS"|null}}
 */
export function lookupUsSponsor(company) {
  const idx = assertLoaded();
  const { entry, match, reason } = findEntry(idx, company);
  if (!entry) {
    return {
      sponsor: false, basis: null, match: null, name: null, lastH1bFiling: null, recentH1b: 0, h1bFilings: 0,
      lastPermFiling: null, permFilings: 0, domain: null, reason,
    };
  }
  const v = verdictOf(entry, idx.since);
  return {
    sponsor: v.sponsor,
    basis: v.basis,
    match,
    name: entry.name,
    lastH1bFiling: entry.last,
    recentH1b: entry.recentH1b,
    h1bFilings: entry.h1bFilings,
    lastPermFiling: entry.lastPerm,
    permFilings: entry.permFilings,
    domain: entry.domain,
    reason: v.reason,
  };
}

/** The 403 message for a refused employer. Exported for tests. */
export function usSponsorRefusal(companyName, r, since = index?.since || US_SPONSOR_SINCE) {
  const who = String(companyName || "").trim() || "(no company name)";
  const tail = "Client is set to US H-1B sponsors only.";
  if (r.reason === "NO_RECENT_H1B") {
    const last = [r.lastH1bFiling && `an H-1B on ${r.lastH1bFiling}`, r.lastPermFiling && `a green card case on ${r.lastPermFiling}`]
      .filter(Boolean).join(" and ") || "nothing";
    return `${who} last filed ${last} (${r.name}), before ${since}. ${tail}`;
  }
  if (r.reason === "TOO_FEW_FILINGS") {
    return `${who} (${r.name}) has filed only ${r.h1bFilings} H-1B${r.h1bFilings === 1 ? "" : "s"} ever and ${r.recentH1b} in the last year: too few to count as a sponsor. ${tail}`;
  }
  return `${who} has no H-1B or green card filings in the US Department of Labor data. ${tail}`;
}

// ---- the push gate ----------------------------------------------------------

/**
 * null when the gate does not apply to this client, else
 * { check(companyName, jobDescription?) } where check returns null (allow) or
 * { status: 403, error, message, sponsor, posting }.
 *
 * Two checks, company first:
 *   1. the employer is a sponsor (lookupUsSponsor)
 *   2. the posting itself does not refuse sponsorship (noSponsorshipText.js):
 *      Milliman sponsors hundreds a year, and still posts "we are unable to
 *      sponsor for this role". Skipped when no description is passed.
 * Both refusals use error NOT_US_H1B_SPONSOR, which the extension already
 * files under "blocked" without spending the daily cap.
 *
 * Throws US_SPONSOR_DATA_NOT_LOADED when the client is opted in but the data
 * is missing; callers answer 503 (fail closed).
 */
export async function usSponsorGate({ email, profile }, deps = {}) {
  const prof = profile !== undefined
    ? profile
    : await ProfileModel.findOne({ email: String(email || "").toLowerCase().trim() })
        .select("usSponsorOnly")
        .lean();
  if (!prof?.usSponsorOnly) return null;
  const client = await resolveClientCountry(email, deps);
  // Offered to US clients only; a client re-tagged to another country is not gated.
  if (!client.isUs) return null;
  assertLoaded();
  return {
    check(companyName, jobDescription) {
      const r = lookupUsSponsor(companyName);
      if (!r.sponsor) {
        return { status: 403, error: "NOT_US_H1B_SPONSOR", message: usSponsorRefusal(companyName, r), sponsor: r, posting: null };
      }
      const posting = detectNoSponsorship(jobDescription);
      if (posting.refuses) {
        const who = String(companyName || "").trim();
        const what = { NO_SPONSORSHIP: "says it will not sponsor", CITIZENS_ONLY: "is for US citizens or green card holders only", CLEARANCE: "requires an active US security clearance" }[posting.kind];
        return {
          status: 403,
          error: "NOT_US_H1B_SPONSOR",
          message: `${who} sponsors H-1Bs, but this posting ${what}: "${posting.quote}". Client is set to US H-1B sponsors only.`,
          sponsor: { ...r, sponsor: false, reason: `POSTING_${posting.kind}` },
          posting,
        };
      }
      return null;
    },
  };
}

/** null when the push may go ahead, else { status: 403, error, message, sponsor, posting }. */
export async function usSponsorPushBlock({ email, companyName, jobDescription, profile }, deps = {}) {
  const gate = await usSponsorGate({ email, profile }, deps);
  return gate ? gate.check(companyName, jobDescription) : null;
}
