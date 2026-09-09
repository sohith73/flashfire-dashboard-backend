// One-click unsubscribe for every client-facing mail stream.
//
// WHY THIS EXISTS
//
// Until now the only way for a client to stop a mail was the footer line
// "Reply to this email to change what we send" - a human reading an inbox and
// remembering to act. That is not an opt-out mechanism:
//
//   - Gmail and Yahoo have required List-Unsubscribe and one-click
//     List-Unsubscribe-Post on bulk mail since February 2024. Without them,
//     delivery to those providers degrades, and between them they are most of
//     any client list.
//   - CAN-SPAM requires a working opt-out on commercial mail. Some of what we
//     send is arguably transactional (it reports on a service the client is
//     paying for) but the daily summary is close enough to the line that
//     arguing the point in a complaint is a worse position than just having
//     the link.
//   - A client who wants out and cannot find a button marks us as spam
//     instead, which damages the sending reputation of the whole account.
//
// HOW THE LINK IS SAFE WITHOUT A LOGIN
//
// The link has to work from an email client with no session, so it cannot ask
// who you are. It carries an HMAC over (email + stream) signed with the app
// secret. That means:
//
//   - the link cannot be forged, so nobody can unsubscribe another client
//   - the address is not a bare query parameter anyone can edit to enumerate
//     or unsubscribe our whole client list
//   - it never expires, because a mail sitting in an inbox for six months must
//     still have a working opt-out
//
// Deliberately NOT single-use: mail clients and security scanners prefetch
// links, and a token that burned on first fetch would either unsubscribe
// clients who never clicked, or stop working before they did.

import crypto from "crypto";

/**
 * Streams a client can opt out of, independently.
 *
 * Separate rather than one global flag because they are different promises:
 * somebody may want the interview alerts (their actual job search) while
 * having no interest in a daily count. `all` is the escape hatch the footer
 * link uses, since a client clicking "unsubscribe" means all of it.
 */
export const UNSUB_STREAMS = {
  REMINDERS: "reminders",
  INBOX_ALERTS: "inbox-alerts",
  ONBOARDING: "onboarding",
  ALL: "all"
};

const VALID_STREAMS = new Set(Object.values(UNSUB_STREAMS));

export function isUnsubStream(stream) {
  return VALID_STREAMS.has(String(stream || ""));
}

/**
 * The signing key. Reuses the app's existing JWT secret rather than adding
 * another env var to forget in one environment. Returns "" when unset, and
 * every caller then degrades to "no unsubscribe link" rather than emitting an
 * unsigned link that anyone could forge.
 */
function signingKey() {
  return String(process.env.JWT_SECRET || process.env.JWT_SECRET_KEY || "").trim();
}

export function isUnsubscribeConfigured() {
  return signingKey().length > 0;
}

/** Public base URL of the dashboard API, used to build the link. */
export function unsubscribeBaseUrl() {
  const raw = String(process.env.PUBLIC_API_URL || process.env.BACKEND_PUBLIC_URL || "").trim();
  return raw.replace(/\/+$/, "");
}

function normalise(email, stream) {
  return `${String(email || "").trim().toLowerCase()}:${String(stream || "")}`;
}

/** HMAC-SHA256, url-safe base64, truncated to 32 chars - 128 bits of tag. */
export function unsubscribeToken(email, stream = UNSUB_STREAMS.ALL) {
  const key = signingKey();
  if (!key) return "";
  return crypto
    .createHmac("sha256", key)
    .update(normalise(email, stream))
    .digest("base64url")
    .slice(0, 32);
}

/**
 * Verify a token against the address it claims to be for.
 *
 * timingSafeEqual on equal-length buffers, with the length check first so a
 * short token cannot throw instead of returning false.
 */
export function verifyUnsubscribeToken(email, stream, token) {
  const expected = unsubscribeToken(email, stream);
  const given = String(token || "");
  if (!expected || expected.length !== given.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
  } catch {
    return false;
  }
}

/**
 * The full unsubscribe URL for one client and stream, or "" when it cannot be
 * built (no signing key, no public URL, no address). Callers MUST treat "" as
 * "render no link" rather than emitting a broken one - a dead unsubscribe link
 * is worse than none, because it reads as deliberate.
 */
export function unsubscribeUrl(email, stream = UNSUB_STREAMS.ALL) {
  const addr = String(email || "").trim().toLowerCase();
  const base = unsubscribeBaseUrl();
  const token = unsubscribeToken(addr, stream);
  if (!addr || !base || !token || !isUnsubStream(stream)) return "";
  const q = new URLSearchParams({ e: addr, s: stream, t: token });
  return `${base}/unsubscribe?${q.toString()}`;
}

/**
 * The headers Gmail and Yahoo look for.
 *
 * List-Unsubscribe-Post is what turns the provider's own "Unsubscribe" button
 * into a one-click action: the provider POSTs to the URL itself and the user
 * never leaves their inbox. It must only be sent alongside an https URL, which
 * is why both are built from the same helper.
 *
 * @returns {object} headers to spread into the message, or {} when unavailable
 */
export function unsubscribeHeaders(email, stream = UNSUB_STREAMS.ALL) {
  const url = unsubscribeUrl(email, stream);
  if (!url) return {};
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
  };
}
