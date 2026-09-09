// Re-resolve activity_logs.location through the consensus resolver.
//
// Shared by the CLI (scripts/backfill-activity-location.mjs) and the HTTP route
// (POST /admin/geo/backfill) so both behave identically — there is exactly one
// implementation of what a backfill does.
//
// Resolution is grouped by distinct IP, so N rows cost one lookup per unique
// address, and every answer lands in ip_geo_cache for the live server to reuse.

import { ActivityLog } from "../Schema_Models/ActivityLog.js";
import { resolveGeo, geoStats } from "./ipGeo.js";
import { isPublicIp, normalizeIp } from "./clientIp.js";

/**
 * @param {{
 *   dryRun?: boolean, force?: boolean, since?: string|Date,
 *   throttleMs?: number, batch?: number, limit?: number,
 *   onProgress?: (p: object) => void, signal?: { aborted: boolean }
 * }} opts
 */
export async function runLocationBackfill(opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const force = Boolean(opts.force);
  const batch = Math.max(1, Number(opts.batch) || 500);
  // Providers are free and rate limited. Pause between NEW lookups so a large
  // backfill cannot trip ip-api's ~45/min ceiling and cache a wall of misses.
  const throttleMs = opts.throttleMs === undefined ? 1500 : Math.max(0, Number(opts.throttleMs));
  const limit = Math.max(0, Number(opts.limit) || 0);
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};

  const filter = { ip: { $nin: ["", null] } };
  // Default pass touches only rows that never got a structured fix.
  if (!force) filter.$or = [{ geo: null }, { geo: { $exists: false } }, { location: "" }];
  if (opts.since) filter.createdAt = { $gte: new Date(opts.since) };

  const total = await ActivityLog.countDocuments(filter);

  const state = {
    total,
    scanned: 0,
    resolved: 0,
    unresolvable: 0,
    changed: 0,
    written: 0,
    distinctIps: 0,
    samples: [], // first 50 display-string rewrites, for review
    dryRun,
    force,
  };
  if (!total) return { ...state, done: true };

  const geoByIp = new Map();
  let ops = [];

  const flush = async () => {
    if (!ops.length) return;
    if (!dryRun) {
      const res = await ActivityLog.bulkWrite(ops, { ordered: false });
      state.written += res.modifiedCount || 0;
    }
    ops = [];
  };

  const cursor = ActivityLog.find(filter)
    .select({ _id: 1, ip: 1, location: 1 })
    .sort({ _id: -1 })
    .lean()
    .cursor();

  try {
    for await (const doc of cursor) {
      if (opts.signal?.aborted) break;
      if (limit && state.scanned >= limit) break;
      state.scanned++;

      const ip = normalizeIp(doc.ip);
      if (!isPublicIp(ip)) {
        state.unresolvable++;
        continue;
      }

      if (!geoByIp.has(ip)) {
        const before = geoStats().resolved;
        geoByIp.set(ip, await resolveGeo(ip));
        state.distinctIps = geoByIp.size;
        // Only sleep when we actually went out to the providers; cached and
        // pinned addresses cost nothing and must not slow the run down.
        if (throttleMs && geoStats().resolved > before) {
          await new Promise((r) => setTimeout(r, throttleMs));
        }
      }

      const geo = geoByIp.get(ip);
      if (!geo || !geo.location) {
        state.unresolvable++;
        continue;
      }
      state.resolved++;

      if (doc.location && doc.location !== geo.location) {
        state.changed++;
        if (state.samples.length < 50) {
          state.samples.push({ ip, from: doc.location, to: geo.location, confidence: geo.confidence });
        }
      }

      // `votes` stays in ip_geo_cache keyed by IP; copying the raw provider
      // answers onto every row would duplicate one blob thousands of times.
      const { location, votes, ...rest } = geo;
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { location, geo: rest } } } });
      if (ops.length >= batch) await flush();
      if (state.scanned % 100 === 0) onProgress({ ...state });
    }
    await flush();
  } finally {
    await cursor.close().catch(() => {});
  }

  const result = { ...state, done: true, aborted: Boolean(opts.signal?.aborted) };
  onProgress(result);
  return result;
}
