// Hand-pinned IP/CIDR → location overrides, backed by the ip_geo_overrides
// collection and managed over /admin/geo/overrides.
//
// Checked before every provider. Longest matching prefix wins, so a /32 entry
// beats the /24 it sits inside.
//
// The compiled rule set is held in process and refreshed on a short TTL. That
// keeps the resolver's hot path free of a Mongo round trip while still letting
// an edit made on one Render instance reach the others within a minute; the
// instance that took the write invalidates itself immediately.

import { IpGeoOverride } from "../Schema_Models/IpGeoOverride.js";
import { normalizeIp } from "./clientIp.js";

const RELOAD_MS = 60 * 1000;

let RULES = []; // sorted narrowest → widest
let loadedAt = 0;
let inflight = null;

/** Dotted-quad → unsigned 32-bit, or null when it is not a valid IPv4 literal. */
export function ipv4ToInt(ip) {
  const m = String(ip).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

const intToIpv4 = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");

// `1 << 32` is 1 in JS and `<<` is signed, so build the mask arithmetically.
export const maskFor = (bits) => (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);

/**
 * Validate and canonicalize a CIDR so "203.0.113.7/24" and "203.0.113.0/24"
 * cannot both exist as separate rows for the same block.
 * @returns {{ cidr: string, base: number, bits: number } | { error: string }}
 */
export function parseCidr(spec) {
  const raw = String(spec || "").trim();
  if (!raw) return { error: "cidr is required" };
  const [addr, prefix] = raw.split("/");
  const parsed = ipv4ToInt(normalizeIp(addr));
  if (parsed === null) {
    return { error: `"${raw}" is not an IPv4 address or block (IPv6 overrides are not supported)` };
  }
  const bits = prefix === undefined ? 32 : Number(prefix);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
    return { error: `"${raw}" has an invalid prefix length; expected /0 to /32` };
  }
  const base = (parsed & maskFor(bits)) >>> 0;
  return { cidr: `${intToIpv4(base)}/${bits}`, base, bits };
}

function compile(docs) {
  return docs
    .map((d) => ({ base: d.base, mask: maskFor(d.bits), bits: d.bits, entry: d }))
    .sort((a, b) => b.bits - a.bits); // narrowest first — first hit is most specific
}

async function load() {
  const docs = await IpGeoOverride.find({}).lean();
  RULES = compile(docs);
  loadedAt = Date.now();
  return RULES;
}

/** Force the next lookup to re-read the collection. */
export function invalidateOverrides() {
  loadedAt = 0;
}

/** Load now and keep the result; called at boot so the first login is warm. */
export async function refreshOverrides() {
  try {
    inflight = load();
    const rules = await inflight;
    if (rules.length) console.log(`[ipGeoOverrides] ${rules.length} override rule(s) active`);
    return rules.length;
  } catch (err) {
    console.warn("[ipGeoOverrides] load failed:", err?.message || err);
    return RULES.length;
  } finally {
    inflight = null;
  }
}

async function ensureFresh() {
  if (Date.now() - loadedAt < RELOAD_MS) return;
  // Collapse concurrent refreshes onto one query.
  if (inflight) {
    await inflight.catch(() => {});
    return;
  }
  await refreshOverrides();
}

/** Number of active rules, for /health. */
export function overrideCount() {
  return RULES.length;
}

/**
 * @param {string} rawIp
 * @returns {Promise<null | { city, region, country, countryCode, lat, lon,
 *   timezone, label, cidr, source: "override", confidence: "high" }>}
 */
export async function lookupOverride(rawIp) {
  const n = ipv4ToInt(normalizeIp(rawIp));
  // Nothing to match against, so skip the refresh entirely for IPv6 and junk.
  if (n === null) return null;
  await ensureFresh();
  for (const r of RULES) {
    if (((n & r.mask) >>> 0) === r.base) {
      const e = r.entry;
      return {
        city: String(e.city || ""),
        region: String(e.region || ""),
        country: String(e.country || ""),
        countryCode: String(e.countryCode || "").toUpperCase(),
        lat: Number.isFinite(e.lat) ? e.lat : null,
        lon: Number.isFinite(e.lon) ? e.lon : null,
        timezone: String(e.timezone || ""),
        label: String(e.label || ""),
        cidr: e.cidr,
        source: "override",
        confidence: "high",
      };
    }
  }
  return null;
}

/** Synchronous match against the already-loaded rule set. For tests. */
export function matchLoaded(rawIp) {
  const n = ipv4ToInt(normalizeIp(rawIp));
  if (n === null) return null;
  for (const r of RULES) {
    if (((n & r.mask) >>> 0) === r.base) return r.entry;
  }
  return null;
}

/** Replace the in-process rule set directly. For tests only. */
export function __setRulesForTest(docs) {
  RULES = compile(docs);
  loadedAt = Date.now();
}
