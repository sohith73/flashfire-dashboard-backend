// Admin HTTP surface for IP → location: diagnose a wrong location, pin a
// network, and re-run the backfill — all from the deployed service.
//
// The equivalent CLI scripts only work with a shell. Render does not give you
// one, so anything an operator must be able to do in production lives here.
//
//   GET    /admin/geo/status              resolver + cache health
//   GET    /admin/geo/top?limit=20        busiest IPs in the activity log
//   GET    /admin/geo/inspect/:ip         what each provider said, and the verdict
//   GET    /admin/geo/overrides           list pinned networks
//   POST   /admin/geo/overrides           pin / update one
//   DELETE /admin/geo/overrides/:cidr     unpin
//   POST   /admin/geo/backfill            start a backfill (async job)
//   GET    /admin/geo/backfill            current / last job status
//   DELETE /admin/geo/backfill            cancel the running job

import { ActivityLog } from "../Schema_Models/ActivityLog.js";
import { IpGeoCache } from "../Schema_Models/IpGeoCache.js";
import { IpGeoOverride } from "../Schema_Models/IpGeoOverride.js";
import { resolveGeo, geoStats, formatLocation } from "../Utils/ipGeo.js";
import {
  invalidateOverrides,
  lookupOverride,
  overrideCount,
  parseCidr,
  refreshOverrides,
} from "../Utils/ipGeoOverrides.js";
import { runLocationBackfill } from "../Utils/locationBackfill.js";
import { isPublicIp, normalizeIp } from "../Utils/clientIp.js";

/** GET /admin/geo/status */
export async function geoStatus(_req, res) {
  try {
    const [cached, pinned] = await Promise.all([
      IpGeoCache.estimatedDocumentCount(),
      IpGeoOverride.estimatedDocumentCount(),
    ]);
    return res.json({
      resolver: geoStats(),
      cachedIps: cached,
      overrides: pinned,
      overrideRulesLoaded: overrideCount(),
      backfill: publicJob(),
    });
  } catch (err) {
    console.error("[geo status]", err?.message || err);
    return res.status(500).json({ error: "Failed to read geo status" });
  }
}

/**
 * GET /admin/geo/top?limit=20&since=2026-07-01
 *
 * Busiest IPs, with the number of DISTINCT accounts behind each. More than one
 * account on an address is the signature of an office, a VPN or a shared
 * operator machine — the location is real, but it is not that client's home.
 */
export async function geoTop(req, res) {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const match = { ip: { $nin: ["", null] } };
    if (req.query.since) match.createdAt = { $gte: new Date(req.query.since) };

    const rows = await ActivityLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$ip",
          events: { $sum: 1 },
          actors: { $addToSet: "$actor.email" },
          location: { $last: "$location" },
          confidence: { $last: "$geo.confidence" },
          source: { $last: "$geo.source" },
          countryCode: { $last: "$geo.countryCode" },
          lastSeen: { $max: "$createdAt" },
        },
      },
      { $sort: { events: -1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          ip: "$_id",
          events: 1,
          location: 1,
          confidence: 1,
          source: 1,
          countryCode: 1,
          lastSeen: 1,
          accountCount: { $size: "$actors" },
          accounts: { $slice: ["$actors", 8] },
        },
      },
    ]);

    return res.json({
      items: rows.map((r) => ({ ...r, shared: r.accountCount > 1 })),
      note:
        "shared=true means several distinct accounts logged in from this address — " +
        "an office, VPN or operator machine, not one client's home location.",
    });
  } catch (err) {
    console.error("[geo top]", err?.message || err);
    return res.status(500).json({ error: "Failed to aggregate IPs" });
  }
}

/** GET /admin/geo/inspect/:ip?refresh=1 */
export async function geoInspect(req, res) {
  try {
    const ip = normalizeIp(req.params.ip);
    if (!ip) return res.status(400).json({ error: "ip is required" });
    if (!isPublicIp(ip)) {
      return res.json({ ip, resolvable: false, reason: "not a routable public address" });
    }

    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    const [pinned, cached] = await Promise.all([
      lookupOverride(ip),
      IpGeoCache.findOne({ ip }).lean(),
    ]);
    const geo = await resolveGeo(ip, { refresh });

    if (!geo) {
      return res.json({ ip, resolvable: false, reason: "no provider could resolve this address" });
    }

    const votes = geo.votes?.length ? geo.votes : cached?.votes || [];
    return res.json({
      ip,
      resolvable: true,
      location: geo.location,
      confidence: geo.confidence,
      source: geo.source,
      pinned: pinned ? { cidr: pinned.cidr, label: pinned.label } : null,
      cache: cached
        ? { resolvedAt: cached.resolvedAt, lookupCount: cached.lookupCount, locked: cached.locked }
        : null,
      // The whole point of this endpoint: show the raw disagreement so a human
      // can judge it rather than trusting one opaque string.
      votes,
      explanation: explain(geo.confidence),
      geo: {
        city: geo.city, region: geo.region, country: geo.country,
        countryCode: geo.countryCode, lat: geo.lat, lon: geo.lon, timezone: geo.timezone,
      },
      suggestedOverride:
        geo.confidence === "high" && geo.source !== "single"
          ? null
          : {
              cidr: `${ip}/32`,
              city: geo.city, region: geo.region,
              country: geo.country, countryCode: geo.countryCode,
              label: "",
            },
    });
  } catch (err) {
    console.error("[geo inspect]", err?.message || err);
    return res.status(500).json({ error: "Inspection failed" });
  }
}

function explain(confidence) {
  if (confidence === "high") return "Independent providers agreed on the city.";
  if (confidence === "medium") {
    return (
      "Providers agreed on the region but named different cities, so the city is " +
      "deliberately omitted rather than guessed."
    );
  }
  if (confidence === "low") return "Only one provider answered; treat this as a guess.";
  return "";
}

// ------------------------------------------------------------------ overrides

/** GET /admin/geo/overrides */
export async function listOverrides(_req, res) {
  try {
    const items = await IpGeoOverride.find({}).sort({ bits: -1, base: 1 }).lean();
    return res.json({
      items: items.map(({ _id, base, ...rest }) => rest),
      count: items.length,
    });
  } catch (err) {
    console.error("[geo overrides list]", err?.message || err);
    return res.status(500).json({ error: "Failed to list overrides" });
  }
}

/** POST /admin/geo/overrides — body: { cidr, city?, region?, country?, countryCode?, label?, note? } */
export async function upsertOverride(req, res) {
  try {
    const body = req.body || {};
    const parsed = parseCidr(body.cidr || body.ip);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const cc = String(body.countryCode || "").trim().toUpperCase();
    if (cc && !/^[A-Z]{2}$/.test(cc)) {
      return res.status(400).json({ error: "countryCode must be an ISO 3166-1 alpha-2 code" });
    }
    // An override with nothing to say would blank the location entirely.
    if (!String(body.label || "").trim() && !String(body.city || "").trim() &&
        !String(body.region || "").trim() && !String(body.country || "").trim()) {
      return res.status(400).json({
        error: "provide at least one of label, city, region or country — an empty override hides the location",
      });
    }

    const doc = {
      cidr: parsed.cidr,
      base: parsed.base,
      bits: parsed.bits,
      city: String(body.city || "").trim(),
      region: String(body.region || "").trim(),
      country: String(body.country || "").trim(),
      countryCode: cc,
      lat: Number.isFinite(body.lat) ? body.lat : null,
      lon: Number.isFinite(body.lon) ? body.lon : null,
      timezone: String(body.timezone || "").trim(),
      label: String(body.label || "").trim(),
      note: String(body.note || "").trim(),
      createdBy: String(req.user?.email || req.user?.username || "").trim(),
      updatedAt: new Date(),
    };

    await IpGeoOverride.updateOne({ cidr: parsed.cidr }, { $set: doc }, { upsert: true });
    // This instance sees the change immediately; the others pick it up on their
    // next refresh tick.
    invalidateOverrides();
    await refreshOverrides();

    const preview = { ...doc, source: "override" };
    return res.status(200).json({
      ok: true,
      override: doc,
      willDisplayAs: formatLocation(preview),
      note: "Existing activity rows keep their old value until you run a backfill with force=true.",
    });
  } catch (err) {
    console.error("[geo overrides upsert]", err?.message || err);
    return res.status(500).json({ error: "Failed to save override" });
  }
}

/** DELETE /admin/geo/overrides/:cidr — the prefix is passed as "10.0.0.0-8" or "10.0.0.0/8". */
export async function deleteOverride(req, res) {
  try {
    // A slash cannot travel in a path segment, so "-" is accepted for it too.
    const parsed = parseCidr(String(req.params.cidr || "").replace("-", "/"));
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const r = await IpGeoOverride.deleteOne({ cidr: parsed.cidr });
    invalidateOverrides();
    await refreshOverrides();
    if (!r.deletedCount) return res.status(404).json({ error: `no override for ${parsed.cidr}` });
    return res.json({ ok: true, removed: parsed.cidr });
  } catch (err) {
    console.error("[geo overrides delete]", err?.message || err);
    return res.status(500).json({ error: "Failed to delete override" });
  }
}

// ------------------------------------------------------------------- backfill
//
// A backfill walks every activity row and can take minutes, so it runs as a
// background job rather than holding an HTTP request open past the proxy's
// timeout. One at a time — two concurrent passes would fight over the same rows
// and double the provider traffic for no benefit.

let JOB = null;

function publicJob() {
  if (!JOB) return null;
  const { controller, promise, ...rest } = JOB;
  return rest;
}

/** POST /admin/geo/backfill — body: { dryRun?, force?, since?, throttleMs?, limit? } */
export async function startBackfill(req, res) {
  try {
    if (JOB && JOB.status === "running") {
      return res.status(409).json({ error: "a backfill is already running", job: publicJob() });
    }
    const body = req.body || {};
    const controller = { aborted: false };

    JOB = {
      id: `bf_${Date.now().toString(36)}`,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      startedBy: String(req.user?.email || req.user?.username || "admin"),
      options: {
        dryRun: Boolean(body.dryRun),
        force: Boolean(body.force),
        since: body.since || null,
        throttleMs: body.throttleMs === undefined ? 1500 : Number(body.throttleMs),
        limit: Number(body.limit) || 0,
      },
      progress: null,
      error: null,
      controller,
    };

    JOB.promise = runLocationBackfill({
      ...JOB.options,
      signal: controller,
      onProgress: (p) => {
        if (JOB) JOB.progress = p;
      },
    })
      .then((result) => {
        if (!JOB) return;
        JOB.progress = result;
        JOB.status = result.aborted ? "cancelled" : "completed";
        JOB.finishedAt = new Date().toISOString();
      })
      .catch((err) => {
        if (!JOB) return;
        JOB.status = "failed";
        JOB.error = String(err?.message || err);
        JOB.finishedAt = new Date().toISOString();
        console.error("[geo backfill]", err?.stack || err);
      });

    // Respond immediately; poll GET /admin/geo/backfill for progress.
    return res.status(202).json({
      ok: true,
      job: publicJob(),
      poll: "GET /admin/geo/backfill",
    });
  } catch (err) {
    console.error("[geo backfill start]", err?.message || err);
    return res.status(500).json({ error: "Failed to start backfill" });
  }
}

/** GET /admin/geo/backfill */
export function backfillStatus(_req, res) {
  const job = publicJob();
  if (!job) return res.json({ job: null, note: "no backfill has been started on this instance" });
  return res.json({ job });
}

/** DELETE /admin/geo/backfill */
export function cancelBackfill(_req, res) {
  if (!JOB || JOB.status !== "running") {
    return res.status(409).json({ error: "no backfill is running" });
  }
  JOB.controller.aborted = true;
  return res.json({ ok: true, note: "cancelling; rows already written are kept" });
}
