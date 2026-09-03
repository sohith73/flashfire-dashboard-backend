// IP → location resolution for activity logs. Entirely in-house: no API key,
// no bundled database, no build step.
//
// The old implementation asked ip-api.com and printed whatever came back. Two
// things were wrong with that:
//
//   1. One provider was treated as ground truth. Free city-level geolocation
//      genuinely disagrees — for 24.168.231.87 ip-api says Marion SC, ipwho.is
//      says Charlotte NC, ipinfo says North Myrtle Beach SC. Printing the first
//      answer as fact is how a log ends up confidently wrong.
//   2. The only cache was an in-process Map, lost on restart and not shared
//      between instances, against a provider capped at ~45 req/min. A burst of
//      logins hit the cap and those rows kept location: "" forever.
//
// This resolver instead:
//   - checks hand-pinned CIDR overrides first (ip_geo_overrides collection,
//     managed over /admin/geo/overrides)
//   - asks several keyless providers in parallel and takes the CONSENSUS
//   - reports region-only when providers agree on the state but not the city,
//     rather than inventing precision it does not have
//   - persists every answer in Mongo (ip_geo_cache) so each distinct IP is
//     resolved once, ever, across restarts and instances
//
// Never throws; returns null / "" when it cannot resolve.

import { isPublicIp, normalizeIp } from "./clientIp.js";
import { lookupOverride, overrideCount } from "./ipGeoOverrides.js";
import { IpGeoCache } from "../Schema_Models/IpGeoCache.js";

const MEM = new Map(); // ip -> { geo: object|null, at: number }
const MEM_TTL_MS = 60 * 60 * 1000; // in-process hot path; Mongo is the real cache
const MEM_MISS_TTL_MS = 5 * 60 * 1000;
const MAX_MEM = 5000;
// Providers change their minds as they re-survey. Re-resolve after this long.
const STALE_MS = 180 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;

const STATS = { overrideHits: 0, memHits: 0, dbHits: 0, resolved: 0, failed: 0 };

export { isPublicIp, normalizeIp };

/** Snapshot for /health. */
export function geoStats() {
  return { ...STATS, memEntries: MEM.size, overrideRules: overrideCount() };
}

// ---------------------------------------------------------------- providers
//
// All keyless. Each returns null on any failure — one provider being down or
// rate limited must never sink the lookup, it just removes a vote.

async function getJson(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

const PROVIDERS = [
  {
    // Listed first: it breaks the tie when exactly two providers answer and
    // disagree, and it is the most generous of the three on volume.
    name: "ip-api",
    async fetch(ip, signal) {
      const d = await getJson(
        `http://ip-api.com/json/${encodeURIComponent(ip)}` +
          `?fields=status,country,countryCode,regionName,city,lat,lon,timezone`,
        signal
      );
      if (!d || d.status !== "success") return null;
      return {
        city: d.city, region: d.regionName, country: d.country,
        countryCode: d.countryCode, lat: d.lat, lon: d.lon, timezone: d.timezone,
      };
    },
  },
  {
    name: "ipwho.is",
    async fetch(ip, signal) {
      const d = await getJson(`https://ipwho.is/${encodeURIComponent(ip)}`, signal);
      if (!d || d.success !== true) return null;
      return {
        city: d.city, region: d.region, country: d.country,
        countryCode: d.country_code, lat: d.latitude, lon: d.longitude,
        timezone: d.timezone?.id,
      };
    },
  },
  {
    name: "ipinfo",
    async fetch(ip, signal) {
      const d = await getJson(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, signal);
      if (!d || d.error || !d.country) return null;
      const [lat, lon] = String(d.loc || "").split(",");
      return {
        city: d.city, region: d.region, country: "",
        countryCode: d.country, lat: Number(lat), lon: Number(lon), timezone: d.timezone,
      };
    },
  },
];

// ----------------------------------------------------------------- consensus

const clean = (v) => String(v ?? "").trim();

// "Sānchor" and "Sanchore" are the same place spelled two ways. Strip
// diacritics and punctuation so votes for one town actually land together.
function normName(s) {
  return clean(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// Treat one name as a match for another when it is a prefix of it — catches the
// Sanchor/Sanchore and Bengaluru/Bengaluru style splits without pulling in a
// fuzzy-match dependency. Guarded at 4 chars so short names never collide.
function sameName(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.startsWith(short);
}

/** Most-voted value among `items`, ties broken by provider order (index 0 wins). */
function tally(items, pick) {
  const groups = [];
  items.forEach((it, idx) => {
    const val = pick(it);
    if (!clean(val)) return;
    const g = groups.find((x) => sameName(x.value, val));
    if (g) g.count++;
    else groups.push({ value: val, count: 1, firstIdx: idx });
  });
  groups.sort((a, b) => b.count - a.count || a.firstIdx - b.firstIdx);
  return groups[0] || null;
}

/**
 * Reduce per-provider answers to one location plus a confidence rating.
 *
 * A city is only asserted when at least two providers agree on it. When they
 * agree on the region but not the city we return the region alone — "South
 * Carolina, United States" is a true statement, "Marion, South Carolina" is a
 * coin flip between three towns.
 */
export function reachConsensus(answers) {
  const votes = answers.filter(Boolean);
  if (!votes.length) return null;

  const country = tally(votes, (v) => v.countryCode);
  if (!country) return null;
  // Only providers that agree on the country get a say in region and city.
  const inCountry = votes.filter((v) => sameName(v.countryCode, country.value));

  const region = tally(inCountry, (v) => v.region);
  const inRegion = region ? inCountry.filter((v) => sameName(v.region, region.value)) : inCountry;

  const city = tally(inRegion, (v) => v.city);
  // A single provider answering at all is weak evidence, whatever it claims.
  const lone = votes.length === 1;
  // Two independent providers naming the same city is what earns the right to
  // print one. With only ONE provider there is nothing to cross-check against,
  // so report what it said but flag it low rather than silently dropping the
  // only information we have.
  const cityAgreed = Boolean(city && (city.count >= 2 || lone));

  // Take coordinates from a provider that backed the winning answer, so the
  // point matches the text rather than averaging disagreeing providers into a
  // spot none of them named.
  const anchor =
    (cityAgreed ? inRegion.find((v) => sameName(v.city, city.value)) : null) ||
    inRegion[0] ||
    inCountry[0];

  return {
    city: cityAgreed ? clean(city.value) : "",
    region: region ? clean(region.value) : "",
    country: clean(inCountry.find((v) => clean(v.country))?.country || ""),
    countryCode: clean(country.value).toUpperCase(),
    lat: Number.isFinite(anchor?.lat) ? anchor.lat : null,
    lon: Number.isFinite(anchor?.lon) ? anchor.lon : null,
    timezone: clean(inRegion.find((v) => clean(v.timezone))?.timezone || ""),
    source: lone ? "single" : "consensus",
    confidence: lone ? "low" : cityAgreed ? "high" : "medium",
    votes: votes.map((v) => ({
      provider: v.provider,
      city: clean(v.city),
      region: clean(v.region),
      countryCode: clean(v.countryCode).toUpperCase(),
    })),
  };
}

/** "City, Region, Country", skipping blanks and names that repeat. */
export function formatLocation(geo) {
  if (!geo) return "";
  if (clean(geo.label)) return clean(geo.label);
  const parts = [];
  for (const p of [geo.city, geo.region, geo.country]) {
    const v = clean(p);
    if (v && !parts.some((x) => sameName(x, v))) parts.push(v);
  }
  return parts.join(", ");
}

// -------------------------------------------------------------------- lookup

async function askProviders(ip) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const results = await Promise.all(
      PROVIDERS.map(async (p) => {
        try {
          const r = await p.fetch(ip, ctrl.signal);
          return r && (clean(r.countryCode) || clean(r.country))
            ? { ...r, provider: p.name }
            : null;
        } catch {
          return null; // one provider failing costs a vote, not the lookup
        }
      })
    );
    return results.filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

function remember(ip, geo) {
  if (MEM.size >= MAX_MEM) MEM.clear();
  MEM.set(ip, { geo, at: Date.now() });
  return geo;
}

function fromCacheDoc(doc) {
  const geo = {
    city: doc.city || "",
    region: doc.region || "",
    country: doc.country || "",
    countryCode: doc.countryCode || "",
    lat: doc.lat ?? null,
    lon: doc.lon ?? null,
    timezone: doc.timezone || "",
    source: doc.source || "",
    confidence: doc.confidence || "",
    votes: doc.votes || [],
  };
  return { ...geo, location: formatLocation(geo) };
}

/**
 * Resolve an IP to structured geo. Never throws.
 * @param {string} rawIp
 * @param {{ refresh?: boolean }} [opts] refresh: ignore cached rows (never
 *   overrides or rows pinned with locked:true)
 */
export async function resolveGeo(rawIp, opts = {}) {
  const ip = normalizeIp(rawIp);
  if (!isPublicIp(ip)) return null;

  const pinned = await lookupOverride(ip);
  if (pinned) {
    STATS.overrideHits++;
    return { ...pinned, votes: [], location: formatLocation(pinned) };
  }

  if (!opts.refresh) {
    const hit = MEM.get(ip);
    if (hit && Date.now() - hit.at < (hit.geo ? MEM_TTL_MS : MEM_MISS_TTL_MS)) {
      STATS.memHits++;
      return hit.geo;
    }
  }

  // Shared cache. Wrapped because activity logging must never fail on a Mongo
  // hiccup — we fall through to the providers instead.
  let doc = null;
  try {
    doc = await IpGeoCache.findOne({ ip }).lean();
  } catch {
    doc = null;
  }
  if (doc) {
    const fresh = Date.now() - new Date(doc.resolvedAt || 0).getTime() < STALE_MS;
    if (doc.locked || (fresh && !opts.refresh)) {
      STATS.dbHits++;
      IpGeoCache.updateOne({ ip }, { $inc: { lookupCount: 1 } }).catch(() => {});
      return remember(ip, fromCacheDoc(doc));
    }
  }

  const answers = await askProviders(ip);
  const consensus = reachConsensus(answers);
  if (!consensus) {
    STATS.failed++;
    return remember(ip, null);
  }
  STATS.resolved++;

  try {
    await IpGeoCache.updateOne(
      { ip },
      {
        $set: { ...consensus, resolvedAt: new Date() },
        $setOnInsert: { ip, locked: false },
        $inc: { lookupCount: 1 },
      },
      { upsert: true }
    );
  } catch (err) {
    // A duplicate-key race just means another request won; not worth retrying.
    if (err?.code !== 11000) console.warn("[ipGeo] cache write failed:", err?.message || err);
  }

  return remember(ip, { ...consensus, location: formatLocation(consensus) });
}

/**
 * Back-compat string form.
 * @returns {Promise<string>} e.g. "San Jose, California, United States" or ""
 */
export async function resolveLocation(rawIp) {
  const geo = await resolveGeo(rawIp);
  return geo ? geo.location : "";
}

/** Test hook. */
export function clearGeoCache() {
  MEM.clear();
}
