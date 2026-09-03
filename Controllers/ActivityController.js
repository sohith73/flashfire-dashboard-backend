import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { ActivityLog } from "../Schema_Models/ActivityLog.js";
import { logActivity } from "../Utils/activityLogger.js";
import { ClientPaymentLookup } from "../Schema_Models/ClientPaymentLookup.js";

// Internal team accounts use @flashfirehq addresses and operator-ish roles.
// audience=clients strips them so the view shows CLIENTS only.
const OPERATOR_ROLES = ["operations", "operator", "admin", "manager", "ops", "team", "operations_manager"];
const INTERNAL_EMAIL_RE = /@flashfirehq\.com$/i;

/**
 * Admin gate: verifies the Bearer JWT and checks for an admin role.
 * Frontend forwards the optimizer-issued JWT (issued by gemini-resume backend)
 * which embeds { userId, username, email, role }. JWT_SECRET must match
 * across the two backends for verification to succeed.
 */
function verifyAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided" });
    }
    const decoded = jwt.verify(
      authHeader.slice(7),
      process.env.JWT_SECRET || process.env.JWT_SECRET_KEY || "flashfire-secret-key-2024"
    );
    const role = (decoded?.role || req.headers["user-role"] || "").toString();
    if (role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/** GET /admin/activity — cursor-paginated activity feed. */
export async function listActivity(req, res) {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const filter = {};

    if (req.query.category) filter.category = String(req.query.category);
    if (req.query.action) filter.action = String(req.query.action);
    if (req.query.targetType) filter.targetType = String(req.query.targetType);
    if (req.query.severity) filter.severity = String(req.query.severity);
    if (req.query.source) filter["actor.source"] = String(req.query.source);
    if (req.query.actorEmail) {
      filter["actor.email"] = String(req.query.actorEmail).toLowerCase();
    }
    // Clients-only view: drop the operations team (operator roles + @flashfirehq
    // internal emails). Skip the email exclusion when a specific client is picked.
    if (String(req.query.audience) === "clients") {
      filter["actor.role"] = { $nin: OPERATOR_ROLES };
      if (!req.query.actorEmail) {
        filter["actor.email"] = { $not: INTERNAL_EMAIL_RE };
      }
    }
    if (req.query.ip) {
      // Substring match so a partial IP (e.g. "49.36") narrows results.
      const safeIp = String(req.query.ip).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (safeIp) filter.ip = new RegExp(safeIp, "i");
    }
    if (req.query.since || req.query.until) {
      filter.createdAt = {};
      if (req.query.since) filter.createdAt.$gte = new Date(req.query.since);
      if (req.query.until) filter.createdAt.$lte = new Date(req.query.until);
    }
    if (req.query.q) {
      const q = String(req.query.q).trim();
      if (q) {
        const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const rx = new RegExp(safe, "i");
        filter.$or = [
          { summary: rx },
          { targetLabel: rx },
          { "actor.email": rx },
          { "actor.name": rx },
          { action: rx },
        ];
      }
    }
    if (req.query.cursor) {
      if (!mongoose.Types.ObjectId.isValid(req.query.cursor)) {
        return res.status(400).json({ error: "Invalid cursor" });
      }
      filter._id = { $lt: new mongoose.Types.ObjectId(req.query.cursor) };
    }

    const items = await ActivityLog.find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = items.length > limit;
    const trimmed = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? String(trimmed[trimmed.length - 1]._id) : null;

    // Enrich with each client's PAYMENT email (one batched lookup for the page).
    // Keyed on the actor's email → dashboardtrackings.paymentEmail.
    try {
      const emails = [...new Set(trimmed.map((it) => String(it?.actor?.email || "").toLowerCase()).filter(Boolean))];
      if (emails.length) {
        const clients = await ClientPaymentLookup.find({ email: { $in: emails } })
          .select("email paymentEmail")
          .lean();
        const payByEmail = new Map(clients.map((c) => [String(c.email || "").toLowerCase(), c.paymentEmail || ""]));
        for (const it of trimmed) {
          it.paymentEmail = payByEmail.get(String(it?.actor?.email || "").toLowerCase()) || "";
        }
      }
    } catch (e) {
      // Enrichment is best-effort; the feed still works without payment emails.
      console.warn("[activity] paymentEmail enrich failed:", e?.message || e);
    }

    return res.json({ items: trimmed, nextCursor, hasMore });
  } catch (err) {
    console.error("[activity GET] error:", err?.message || err);
    return res.status(500).json({ error: "Failed to load activity" });
  }
}

/** GET /admin/activity/facets — distinct values for filter dropdowns. */
export async function listActivityFacets(_req, res) {
  try {
    const [categories, actions, sources, actors] = await Promise.all([
      ActivityLog.distinct("category"),
      ActivityLog.distinct("action"),
      ActivityLog.distinct("actor.source"),
      ActivityLog.aggregate([
        { $match: { "actor.email": { $ne: "" } } },
        {
          $group: {
            _id: "$actor.email",
            name: { $last: "$actor.name" },
            role: { $last: "$actor.role" },
          },
        },
        { $sort: { _id: 1 } },
        { $limit: 200 },
      ]),
    ]);
    return res.json({
      categories: categories.filter(Boolean).sort(),
      actions: actions.filter(Boolean).sort(),
      sources: sources.filter(Boolean).sort(),
      actors: actors.map((a) => ({
        email: a._id,
        name: a.name || "",
        role: a.role || "",
      })),
    });
  } catch (err) {
    console.error("[activity facets] error:", err?.message || err);
    return res.status(500).json({ error: "Failed to load facets" });
  }
}

/**
 * POST /admin/activity/ingest — cross-service ingestion endpoint.
 * Other backends (optimizer, scripts) push events here. Auth via shared
 * secret in `x-activity-secret`. Returns 204 on success.
 */
export async function ingestActivity(req, res) {
  try {
    const expected = process.env.ACTIVITY_INGEST_SECRET || "";
    const got = req.headers["x-activity-secret"] || "";
    if (!expected || got !== expected) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const payload = req.body || {};
    if (!payload.action) {
      return res.status(400).json({ error: "action required" });
    }
    // `req` here is the FORWARDING SERVICE's request, not the end user's, so
    // its IP and user-agent describe our own infrastructure. The payload
    // carries the real client's — logActivity() prefers those. Safe because
    // this endpoint is gated on ACTIVITY_INGEST_SECRET above.
    logActivity(req, payload);
    return res.status(204).end();
  } catch (err) {
    console.error("[activity ingest] error:", err?.message || err);
    return res.status(500).json({ error: "ingest failed" });
  }
}

export { verifyAdmin as verifyAdminForActivity };
