// SendGrid fallback for the Gmail SMTP sender.
//
// Client mail goes out through one Gmail account over SMTP (smtpSender.js) so
// a copy lands in its Sent folder. When that account's app password stops
// working, every client email fails at once (it happened on 19 Nov 2026:
// "535-5.7.8 Username and Password not accepted"). This module is the second
// road: the same message through SendGrid's REST API, from a verified sender
// on an authenticated domain, with Reply-To pointing back at the Gmail
// address so client replies still reach the team.
//
// The dashboard backend and clients-tracking carry the same file. Change both.
//
// Env:
//   SENDGRID_API_KEY (or SENDGRID_API_KEY_1)   required for the fallback
//   MAIL_FALLBACK_FROM_EMAIL   default SENDGRID_FROM_EMAIL, else noreply@flashfirehq.com
//   MAIL_FALLBACK_FROM_NAME    default SMTP_FROM_NAME, else "FlashFire"
//   MAIL_FALLBACK=off          switches the fallback off

const SENDGRID_ENDPOINT = "https://api.sendgrid.com/v3/mail/send";
const TIMEOUT_MS = 15000;

function apiKey(env) {
  return env.SENDGRID_API_KEY || env.SENDGRID_API_KEY_1 || "";
}

export function isMailFallbackEnabled(env = process.env) {
  if (/^(off|0|false|no|disabled)$/i.test(String(env.MAIL_FALLBACK || "").trim())) return false;
  return apiKey(env).length > 0;
}

/** Gmail refusing the login: nothing sends until someone fixes the password. */
export function isSmtpAuthError(message) {
  return /\b535\b|invalid login|username and password not accepted|badcredentials|EAUTH|application-specific password/i.test(
    String(message || "")
  );
}

/**
 * Send one message through SendGrid. Never throws.
 * @returns {Promise<{ok: boolean, messageId?: string, from?: string, error?: string}>}
 */
export async function sendViaSendgridFallback(
  { to, subject, html, text, replyTo, attachment, headers },
  { env = process.env, fetchImpl = fetch } = {}
) {
  if (!isMailFallbackEnabled(env)) return { ok: false, error: "fallback_not_configured" };
  if (!to || !subject || (!html && !text)) return { ok: false, error: "missing_required_fields" };

  const fromEmail = env.MAIL_FALLBACK_FROM_EMAIL || env.SENDGRID_FROM_EMAIL || "noreply@flashfirehq.com";
  const fromName = env.MAIL_FALLBACK_FROM_NAME || env.SMTP_FROM_NAME || "FlashFire";
  // Replies go to the Gmail account the client knows, not to a noreply box.
  const reply = replyTo || env.SMTP_FROM_EMAIL || env.SMTP_USER || "";

  const content = [];
  if (text) content.push({ type: "text/plain", value: String(text) });
  if (html) content.push({ type: "text/html", value: String(html) });

  const body = {
    personalizations: [{ to: [{ email: String(to) }] }],
    from: { email: fromEmail, name: fromName },
    subject: String(subject),
    content,
    ...(reply ? { reply_to: { email: reply } } : {}),
    // List-Unsubscribe and friends. SendGrid rejects a few reserved names, so
    // only plain string headers go through.
    ...(headers && typeof headers === "object" && Object.keys(headers).length
      ? { headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => typeof v === "string")) }
      : {}),
    ...(attachment && attachment.content
      ? {
          attachments: [
            {
              content: Buffer.from(attachment.content).toString("base64"),
              filename: attachment.filename || "attachment",
              type: attachment.mimetype || "application/octet-stream",
              disposition: "attachment"
            }
          ]
        }
      : {})
  };

  try {
    const res = await fetchImpl(SENDGRID_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey(env)}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (res.status === 202 || res.ok) {
      const id = (res.headers?.get && res.headers.get("x-message-id")) || "";
      return { ok: true, messageId: id ? `sendgrid:${id}` : "sendgrid", from: fromEmail };
    }
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch (_) {
      /* body unreadable; the status code is enough */
    }
    return { ok: false, error: `sendgrid_${res.status}${detail ? `: ${detail}` : ""}` };
  } catch (err) {
    return { ok: false, error: `sendgrid_request_failed: ${String(err?.message || err).slice(0, 200)}` };
  }
}
