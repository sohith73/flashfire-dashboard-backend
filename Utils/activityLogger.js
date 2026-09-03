import jwt from "jsonwebtoken";
import { ActivityLog } from "../Schema_Models/ActivityLog.js";
import { resolveGeo } from "./ipGeo.js";
import { extractClientIp, normalizeIp } from "./clientIp.js";

function safeDecodeJwt(req) {
  try {
    const auth = req.headers?.authorization || "";
    if (!auth.startsWith("Bearer ")) return null;
    const token = auth.slice(7);
    return jwt.verify(
      token,
      process.env.JWT_SECRET || process.env.JWT_SECRET_KEY || "flashfire-secret-key-2024"
    );
  } catch {
    return null;
  }
}

// Removed the old leftmost-X-Forwarded-For reader: that header entry is
// client-supplied and therefore forgeable. extractClientIp() resolves through
// Express's `trust proxy` setting instead. See Utils/clientIp.js.

function actorFromReq(req, override = {}) {
  const decoded = safeDecodeJwt(req);
  const hdr = req.headers || {};
  return {
    email: (override.email || decoded?.email || hdr["x-actor-email"] || "").toString(),
    name: (override.name || decoded?.name || hdr["x-actor-name"] || "").toString(),
    role: (override.role || decoded?.role || hdr["user-role"] || hdr["x-actor-role"] || "").toString(),
    source: (override.source || hdr["x-actor-source"] || "dashboard").toString(),
  };
}

/**
 * Fire-and-forget activity logger. Never throws, never blocks the request.
 *
 * @param {import('express').Request|null} req
 * @param {{
 *   action: string,
 *   category?: string,
 *   targetType?: string,
 *   targetId?: string,
 *   targetLabel?: string,
 *   summary?: string,
 *   diff?: any,
 *   context?: any,
 *   actor?: { email?: string, name?: string, role?: string, source?: string },
 *   severity?: 'info'|'warning'|'critical',
 *   ip?: string,
 *   userAgent?: string,
 *   location?: string
 * }} payload  `ip`/`userAgent` are honoured only from trusted callers (the
 *   secret-gated /admin/activity/ingest endpoint), where `req` belongs to the
 *   forwarding service and not to the end user.
 */
export function logActivity(req, payload) {
  try {
    if (!payload || !payload.action) return;
    const doc = {
      action: payload.action,
      category: payload.category || "system",
      targetType: payload.targetType || "",
      targetId: payload.targetId ? String(payload.targetId) : "",
      targetLabel: payload.targetLabel || "",
      summary: payload.summary || "",
      diff: payload.diff ?? null,
      context: payload.context ?? null,
      severity: payload.severity || "info",
      actor: actorFromReq(req || {}, payload.actor || {}),
      // A forwarded event carries the END USER's ip/userAgent in the payload.
      // Deriving them from `req` there records the calling service instead —
      // which is why every optimizer-sourced event used to show one identical
      // location. Payload wins when present; otherwise read the request.
      ip: normalizeIp(payload.ip) || (req ? extractClientIp(req) : ""),
      location: payload.location || "",
      userAgent:
        (payload.userAgent || req?.headers?.["user-agent"] || "").toString().slice(0, 512),
    };
    ActivityLog.create(doc)
      .then((saved) => {
        // Resolve geolocation off the request path and patch it in. Fire-and-forget.
        if (saved && doc.ip && !doc.location) {
          resolveGeo(doc.ip)
            .then((geo) => {
              if (!geo || !geo.location) return;
              // `votes` stays in ip_geo_cache, keyed by IP — copying the raw
              // per-provider answers onto every event row would duplicate the
              // same blob thousands of times for one office IP.
              const { location, votes, ...rest } = geo;
              ActivityLog.updateOne({ _id: saved._id }, { $set: { location, geo: rest } }).catch(() => {});
            })
            .catch(() => {});
        }
      })
      .catch((err) => {
        console.warn("[activityLogger] create failed:", err?.message || err);
      });
  } catch (err) {
    console.warn("[activityLogger] unexpected:", err?.message || err);
  }
}

/**
 * Shallow diff between two objects. Returns [{ field, before, after }].
 * Trims long strings, skips identical primitives, ignores functions.
 */
export function shallowDiff(before, after, opts = {}) {
  const out = [];
  if (!before || !after) return out;
  const maxStr = opts.maxStr || 2000;
  const skip = new Set(opts.skip || []);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (skip.has(key)) continue;
    const b = before[key];
    const a = after[key];
    if (typeof b === "function" || typeof a === "function") continue;
    const bj = typeof b === "string" ? b : JSON.stringify(b ?? null);
    const aj = typeof a === "string" ? a : JSON.stringify(a ?? null);
    if (bj === aj) continue;
    const trim = (v) =>
      typeof v === "string" && v.length > maxStr ? `${v.slice(0, maxStr)}…(${v.length}b)` : v;
    out.push({ field: key, before: trim(b), after: trim(a) });
  }
  return out;
}
