import mongoose from "mongoose";
import { verifyAuthToken, extractToken, normalizeEmail, isOperatorView } from "../Utils/AuthToken.js";

// Human-speed limit for a client's own writes (add job, change or remove a
// job, save the profile).
//
// Some clients point AI agents (Claude in Chrome, ChatGPT agent, scripts that
// Codex or Claude Code wrote) at the portal. A person drags a few cards a
// minute; an agent does dozens. Past these limits the request gets a 429.
//
// Only a client's OWN session is counted: a valid token with no operator-view
// marker whose email is the account being changed. Operators (their own token,
// or an operator view), the extensions and autopilot either send no client
// token or act on someone else's account, so they are never slowed down.
//
// Counters live in MongoDB, not memory, because PM2 runs one process per core
// and an in-memory count would multiply the limit by the core count.

const intFromEnv = (name, fallback) => {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const WINDOWS = Object.freeze([
  { key: "m", ms: 60 * 1000, max: intFromEnv("HUMAN_SPEED_PER_MINUTE", 15), label: "minute" },
  { key: "h", ms: 60 * 60 * 1000, max: intFromEnv("HUMAN_SPEED_PER_HOUR", 150), label: "hour" },
]);

const counterSchema = new mongoose.Schema(
  {
    _id: String, // `${email}|${windowKey}|${bucketStart}`
    n: { type: Number, default: 0 },
    // TTL index: MongoDB deletes the counter once its window has passed.
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { versionKey: false }
);

export const HumanSpeedCounter =
  mongoose.models.humanspeedcounters || mongoose.model("humanspeedcounters", counterSchema);

/** The client email this request is limited as, or null when it is not a
 *  client acting on their own account. */
export function clientSelf(req) {
  const decoded = verifyAuthToken(extractToken(req));
  if (!decoded?.email || isOperatorView(decoded)) return null;
  const self = normalizeEmail(decoded.email);
  const target = normalizeEmail(req.body?.userDetails?.email || req.body?.email);
  if (target && target !== self) return null;
  return self;
}

/** Count one write for `email` in every window. Returns the first window that
 *  is over its limit, with seconds until it resets, or null. */
export async function recordWrite(email, now = Date.now()) {
  const counts = await Promise.all(
    WINDOWS.map((w) => {
      const start = Math.floor(now / w.ms) * w.ms;
      return HumanSpeedCounter.findOneAndUpdate(
        { _id: `${email}|${w.key}|${start}` },
        { $inc: { n: 1 }, $setOnInsert: { expiresAt: new Date(start + w.ms) } },
        { upsert: true, new: true, lean: true }
      ).then((doc) => ({ w, n: doc.n, resetsAt: start + w.ms }));
    })
  );
  const over = counts.find(({ w, n }) => n > w.max);
  if (!over) return null;
  return {
    window: over.w.label,
    max: over.w.max,
    retryAfterSeconds: Math.max(1, Math.ceil((over.resetsAt - now) / 1000)),
  };
}

export default async function HumanSpeedLimit(req, res, next) {
  const email = clientSelf(req);
  if (!email) return next();

  let over;
  try {
    over = await recordWrite(email);
  } catch (err) {
    // A counter outage must not lock clients out of their own dashboard.
    console.error("[human-speed] counter failed, letting the request through:", err?.message || err);
    return next();
  }
  if (!over) return next();

  console.warn(`[human-speed] ${email} over ${over.max} writes per ${over.window} on ${req.method} ${req.path}`);
  res.set("Retry-After", String(over.retryAfterSeconds));
  return res.status(429).json({
    message: `Too many changes too quickly. Please wait ${over.retryAfterSeconds} seconds and try again.`,
    code: "TOO_FAST",
    retryAfterSeconds: over.retryAfterSeconds,
  });
}
