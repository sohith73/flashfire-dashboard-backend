// Shared-secret gate for the operator-only Client Reminders endpoints.
//
// These routes can email a client and post to a customer Mattermost channel,
// so they must not be reachable with nothing but a URL. The Operations UI
// already asks for the operations key (SecretKeyModal, "flashfire@2025") before
// it will render the tab; this middleware makes that gate real on the server
// instead of decorative in the browser.
//
// The default matches the key the UI ships with so the feature works on a box
// where OPS_SECRET_KEY was never set. Set OPS_SECRET_KEY in production.

import crypto from "crypto";

const DEFAULT_OPS_KEY = "flashfire@2025";

/**
 * Constant-time string comparison.
 *
 * crypto.timingSafeEqual THROWS when the buffers differ in length, so the
 * length check has to come first — and that check itself leaks only the length
 * of the key, which is not the secret. Returning early here is correct, not a
 * timing hole.
 */
function timingSafeEquals(presented, expected) {
  const left = Buffer.from(String(presented), "utf8");
  const right = Buffer.from(String(expected), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Express middleware. Reads the key from `x-ops-key`.
 *
 * Deliberately never logs the submitted value: an operator fat-fingering the
 * key into a shared log file is a credential leak, and the failure is already
 * diagnosable from the 401 plus the route name.
 */
export default function requireOpsKey(req, res, next) {
  const expected = String(process.env.OPS_SECRET_KEY || DEFAULT_OPS_KEY);
  const presented = req?.headers?.["x-ops-key"];

  if (typeof presented !== "string" || !presented || !timingSafeEquals(presented, expected)) {
    console.warn(`[requireOpsKey] rejected ${req?.method || "?"} ${req?.originalUrl || req?.url || "?"}`);
    return res.status(401).json({ success: false, message: "unauthorized" });
  }

  return next();
}

export { requireOpsKey };
