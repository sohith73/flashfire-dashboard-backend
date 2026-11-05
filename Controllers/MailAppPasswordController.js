// Operator-only: connect or replace a client's Gmail app password from the
// client's Profile page.
//
//   GET /gmail/app-password  -> { connected, gmailEmail, connectedAt, lastVerifiedAt, needsReplacing }
//   PUT /gmail/app-password  { gmailEmail, appPassword } -> same shape, after a live IMAP + SMTP check
//
// Mounted behind LocalTokenValidator. Only a client session an operator opened
// from Operations (token via === "operations", minted by
// Controllers/operations/GetUserDetails after its managed-client check) may
// call these. The client is always the token's account, never a body field,
// so an operator can only touch the client they opened.
//
// The password is never returned, logged, or echoed in an error.

import { isOperatorView } from "../Utils/AuthToken.js";
import { appPasswordStatus, connectAppPassword, ConnectError } from "../src/services/mailbox/mailboxRegistry.js";

// A connect attempt logs into Gmail twice. Cap attempts per client so a stuck
// form or a script cannot hammer Google (which can lock the account).
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const attempts = new Map(); // ownerEmail -> [timestamps]

function allowAttempt(owner, now = Date.now()) {
  const recent = (attempts.get(owner) || []).filter((t) => now - t < ATTEMPT_WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) {
    attempts.set(owner, recent);
    return false;
  }
  recent.push(now);
  attempts.set(owner, recent);
  return true;
}

/** Test seam. */
export function __resetAppPasswordAttempts() {
  attempts.clear();
}

function operatorClient(req, res) {
  const email = String(req.authEmail || "").toLowerCase();
  if (!email) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }
  if (!isOperatorView(req.user)) {
    res.status(403).json({ error: "operators_only", message: "Only operators can manage a client's app password." });
    return null;
  }
  return email;
}

export async function getAppPassword(req, res) {
  const owner = operatorClient(req, res);
  if (!owner) return;
  try {
    return res.json(await appPasswordStatus(owner));
  } catch (err) {
    console.error(`[app-password] status failed for ${owner}: ${err.message}`);
    return res.status(500).json({ error: "status_failed" });
  }
}

export async function putAppPassword(req, res) {
  const owner = operatorClient(req, res);
  if (!owner) return;
  return saveFor(owner, req, res);
}

async function saveFor(owner, req, res) {
  const { gmailEmail, appPassword } = req.body || {};
  if (typeof gmailEmail !== "string" || typeof appPassword !== "string") {
    return res.status(400).json({ error: "invalid_body", message: "Send gmailEmail and appPassword." });
  }
  if (!allowAttempt(owner)) {
    return res.status(429).json({ error: "too_many_attempts", message: "Too many attempts. Wait 15 minutes and try again." });
  }
  try {
    const status = await connectAppPassword({ ownerEmail: owner, gmailEmail, appPassword });
    console.log(`[app-password] connected ${status.gmailEmail} for ${owner}`);
    return res.json(status);
  } catch (err) {
    if (err instanceof ConnectError) {
      console.warn(`[app-password] connect refused for ${owner}: ${err.code}`);
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    console.error(`[app-password] connect failed for ${owner}: ${err.message}`);
    return res.status(500).json({ error: "connect_failed", message: "Could not save the app password." });
  }
}

// ─── Server-to-server: the clients-tracking portal ──────────────────
//
//   GET /gmail/app-password/ops/:email
//   PUT /gmail/app-password/ops/:email  { gmailEmail, appPassword }
//
// Mounted behind requireOpsKey (x-ops-key). Only the clients-tracking
// backend calls these, after checking its own login and role (admin or team
// lead), so Client Job Analysis can connect a client's app password with the
// same verification, encryption and storage as the Profile popup. The key
// never reaches a browser.

const EMAIL_PARAM_RE = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;

function paramClient(req, res) {
  const email = String(req.params.email || "").toLowerCase().trim();
  if (!EMAIL_PARAM_RE.test(email)) {
    res.status(400).json({ error: "invalid_client_email" });
    return null;
  }
  return email;
}

export async function getAppPasswordForOps(req, res) {
  const owner = paramClient(req, res);
  if (!owner) return;
  try {
    return res.json(await appPasswordStatus(owner));
  } catch (err) {
    console.error(`[app-password] ops status failed for ${owner}: ${err.message}`);
    return res.status(500).json({ error: "status_failed" });
  }
}

export async function putAppPasswordForOps(req, res) {
  const owner = paramClient(req, res);
  if (!owner) return;
  return saveFor(owner, req, res);
}
