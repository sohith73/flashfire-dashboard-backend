// Shared SendGrid transactional sender.
//
// One place that owns the API key + default from-identity, so every
// transactional mail (OTP, client milestone alerts, …) goes through the same
// verified sender and the same error handling.
//
// Key resolution matches the existing OTP path (SENDGRID_API_KEY_1 ||
// SENDGRID_API_KEY) so nothing needs re-configuring.

import sgMail from "@sendgrid/mail";

const API_KEY = process.env.SENDGRID_API_KEY_1 || process.env.SENDGRID_API_KEY || "";
const DEFAULT_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@flashfirehq.com";
const DEFAULT_FROM_NAME = process.env.SENDGRID_FROM_NAME || "FlashFire";

let configured = false;
function ensureConfigured() {
  if (configured) return API_KEY.length > 0;
  if (API_KEY) {
    sgMail.setApiKey(API_KEY);
    configured = true;
  }
  return API_KEY.length > 0;
}

export function isSendgridConfigured() {
  return API_KEY.length > 0;
}

/**
 * Send one transactional email.
 *
 * @param {Object} a
 * @param {string} a.to
 * @param {string} a.subject
 * @param {string} a.html
 * @param {string} [a.text]        - plaintext fallback (recommended for deliverability)
 * @param {string} [a.fromEmail]
 * @param {string} [a.fromName]
 * @param {string} [a.replyTo]
 * @param {Object} [a.categories]  - SendGrid categories for analytics
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}  never throws
 */
export async function sendEmail({ to, subject, html, text, fromEmail, fromName, replyTo, categories }) {
  if (!ensureConfigured()) {
    return { ok: false, error: "sendgrid_not_configured" };
  }
  if (!to || !subject || !html) {
    return { ok: false, error: "missing_required_fields" };
  }

  const msg = {
    to,
    from: { email: fromEmail || DEFAULT_FROM_EMAIL, name: fromName || DEFAULT_FROM_NAME },
    subject,
    html,
    ...(text ? { text } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(Array.isArray(categories) && categories.length ? { categories } : {})
  };

  try {
    const [resp] = await sgMail.send(msg);
    return { ok: true, status: resp?.statusCode };
  } catch (err) {
    // SendGrid puts the useful detail in err.response.body.errors[].message.
    const detail =
      err?.response?.body?.errors?.map((e) => e.message).join("; ") || err?.message || String(err);
    return { ok: false, status: err?.code, error: String(detail).slice(0, 400) };
  }
}
