// Mattermost incoming-webhook transport for the client-reminder stream.
//
// Deliberately dependency-free: no axios, no node-fetch. It talks to
// globalThis.fetch through the __setFetch seam so a unit test can inject a fake
// and never touch the network.
//
// SECURITY: a Mattermost incoming-webhook URL is a bearer credential. Anyone
// holding it can post into the client's channel as us. It must therefore never
// reach a log line, an HTTP response body or a persisted history row. Every
// string this module hands back is run through redact() first, because the
// platform's own network errors happily embed the full request URL
// ("request to https://mm.example.com/hooks/abc123 failed, reason: ...").
//
// Nothing in here throws. The reminder worker treats a Mattermost failure as a
// partial delivery, not as an exception to unwind through the cron tick.

const DEFAULT_TIMEOUT_MS = 10000;
const RETRY_DELAY_MS = 1500;
const MAX_ERROR_CHARS = 300;

// Injectable so tests can run with no network. Resolved lazily on every call so
// that a fetch polyfill installed after this module is imported still wins.
let fetchImpl = null;

/** Test seam. Pass null to fall back to globalThis.fetch. */
export function __setFetch(fn) {
  fetchImpl = typeof fn === "function" ? fn : null;
}

function resolveFetch() {
  if (typeof fetchImpl === "function") return fetchImpl;
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);
  return null;
}

/** Trimmed webhook URL, or "" when there is nothing usable to send to. */
export function normalizeWebhookUrl(url) {
  const s = String(url ?? "").trim();
  if (!s) return "";
  // A stray trailing slash is harmless, but surrounding quotes are not: people
  // paste `"https://..."` out of a config file more often than you would hope.
  return s.replace(/^['"]+|['"]+$/g, "").trim();
}

/**
 * True only for a parseable https URL. Plain http is rejected on purpose:
 * the webhook token travels in the path, so it must not cross the wire in the
 * clear.
 */
export function isValidWebhookUrl(url) {
  const s = normalizeWebhookUrl(url);
  if (!s) return false;
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Strip anything that could be the webhook out of a message we are about to
 * return. Two passes: the literal URL (and its origin, in case the platform
 * truncated the path) and then any surviving absolute URL.
 */
function redact(message, webhookUrl) {
  let out = String(message ?? "");
  const raw = normalizeWebhookUrl(webhookUrl);
  if (raw) {
    out = out.split(raw).join("[webhook-redacted]");
    try {
      const u = new URL(raw);
      out = out.split(u.origin).join("[webhook-redacted]");
      // The token is the last path segment on a Mattermost hook URL.
      const token = u.pathname.split("/").filter(Boolean).pop();
      if (token && token.length >= 8) out = out.split(token).join("[redacted]");
    } catch {
      // A malformed URL cannot leak an origin we failed to parse.
    }
  }
  out = out.replace(/https?:\/\/\S+/gi, "[webhook-redacted]");
  return out.length > MAX_ERROR_CHARS ? `${out.slice(0, MAX_ERROR_CHARS - 3)}...` : out;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 429 and 5xx are worth one more shot; every other 4xx is a permanent no. */
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

async function postOnce({ fetchFn, webhookUrl, payload, timeoutMs }) {
  const controller = new AbortController();
  // The timer MUST be cleared in the finally below. A dangling 10s timer keeps
  // the event loop alive and makes `node --test` hang after the last assertion.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const status = Number(res?.status) || 0;
    if (status >= 200 && status <= 299) {
      return { ok: true, status };
    }

    // Mattermost answers "ok" as plain text on success and a small JSON blob on
    // failure, so never JSON.parse blindly. Read text, keep it short.
    let body = "";
    try {
      body = String(await res.text()).trim().slice(0, 200);
    } catch {
      body = "";
    }
    return {
      ok: false,
      status,
      error: `mattermost responded ${status}${body ? `: ${body}` : ""}`,
      retryable: isRetryableStatus(status)
    };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    return {
      ok: false,
      status: 0,
      error: aborted ? `request timed out after ${timeoutMs}ms` : String(err?.message || err),
      // A network fault or a timeout is exactly the case a single retry fixes.
      retryable: true
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Post one message to a Mattermost incoming webhook.
 *
 * @param {object}  a
 * @param {string}  a.webhookUrl
 * @param {string}  a.text            markdown body
 * @param {string} [a.username]       overrides the webhook's display name
 * @param {string} [a.iconEmoji]      e.g. "fire" or ":fire:"
 * @param {object} [a.props]          extra Mattermost post props
 * @param {number} [a.timeoutMs]
 * @returns {Promise<{ok: boolean, status?: number, error?: string, attempts: number}>}
 *          Never throws. `error` is always redacted.
 */
export async function sendToMattermost({
  webhookUrl,
  text,
  username = "FlashFire",
  iconEmoji,
  props,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const url = normalizeWebhookUrl(webhookUrl);
  if (!isValidWebhookUrl(url)) {
    return { ok: false, status: 0, error: "invalid or missing mattermost webhook url (https required)", attempts: 0 };
  }

  const body = String(text ?? "").trim();
  if (!body) {
    return { ok: false, status: 0, error: "refusing to post an empty message", attempts: 0 };
  }

  const fetchFn = resolveFetch();
  if (!fetchFn) {
    return { ok: false, status: 0, error: "no fetch implementation available in this runtime", attempts: 0 };
  }

  const payload = { text: body, username: String(username || "FlashFire").slice(0, 60) };
  if (iconEmoji) {
    const e = String(iconEmoji).replace(/^:|:$/g, "");
    if (e) payload.icon_emoji = `:${e}:`;
  }
  if (props && typeof props === "object") payload.props = props;

  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 60000) : DEFAULT_TIMEOUT_MS;

  let attempts = 0;
  let last = null;
  // Two passes at most: the contract is "retry ONCE", not "retry until it works".
  for (let i = 0; i < 2; i += 1) {
    attempts += 1;
    last = await postOnce({ fetchFn, webhookUrl: url, payload, timeoutMs: effectiveTimeout });
    if (last.ok) return { ok: true, status: last.status, attempts };
    if (!last.retryable || i === 1) break;
    await sleep(RETRY_DELAY_MS);
  }

  return {
    ok: false,
    status: last?.status ?? 0,
    error: redact(last?.error || "mattermost delivery failed", url),
    attempts
  };
}

export default { sendToMattermost, normalizeWebhookUrl, isValidWebhookUrl, __setFetch };
