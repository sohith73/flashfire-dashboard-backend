// SMTP sender using a Gmail App Password.
//
// Mirrors DASH/clients-tracking/applications_monitor_backend/utils/smtpSender.js
// on purpose: client milestone alerts are sent through the SAME Gmail account
// (same SMTP_USER / SMTP_PASS) so that a copy lands in that account's Sent
// folder — the "proof we sent it" the product needs. Gmail auto-saves every
// message sent through smtp.gmail.com to Sent, so no IMAP append is required.
//
// Required env:
//   SMTP_USER  = full Gmail address (e.g. support@flashfirejobs.com)
//   SMTP_PASS  = 16-char Google App Password (NOT the account password)
// Optional:
//   SMTP_HOST  = smtp.gmail.com   (default)
//   SMTP_PORT  = 465              (default; 587 also works)
//   SMTP_SECURE= true             (default true for 465; false for 587)
//   SMTP_FROM_EMAIL = From address (default SMTP_USER)
//   SMTP_FROM_NAME  = From display name (e.g. "FlashFire Team")

import nodemailer from "nodemailer";

// ============================================================
//  PER-CATEGORY PAUSE — which client-facing streams are stopped.
// ============================================================
// Replaces the old all-or-nothing EMAILS_DISABLED flag. A category named in
// PAUSED_CATEGORIES is hard-stopped: sendViaSmtp() delivers nothing for it and
// returns { ok: false, error: "emails_paused" }. Every other stream sends
// normally. To resume a stream, delete its name from the set.
//
//  client-milestone — the interview / assignment / offer alerts driven by the
//    inbox classifier (src/services/clientMailNotifier.js). Was PAUSED
//    2026-08-12 → 2026-08-24 after the classifier produced a false "you've got
//    an interview" off an Amazon "Thank you for applying" auto-acknowledgement.
//    RESUMED 2026-08-24: every rules-flagged milestone now passes a second-stage
//    AI verification (src/services/mailMilestoneVerifier.js) before the client
//    is emailed; unverified or rejected candidates never send.
//
//  onboarding — the base résumé / cover letter / LinkedIn sequence
//    (src/services/onboardingMailWorker.js). LIVE. It fires off the client's
//    own first application, never off the classifier, so the false positive
//    above cannot reach it.
//
// Sends with no `category` (e.g. the operator-triggered /client-alert/test
// route) are NOT blocked — that route is how you verify SMTP still works while
// a stream is paused.
export const MAIL_CATEGORY = {
  CLIENT_MILESTONE: "client-milestone",
  ONBOARDING: "onboarding"
};

// EMPTY = nothing is hard-stopped at the transport. client-milestone was
// unpaused after the AI verifier shipped; four gates now stand between a
// classified mail and a client, and all four must pass:
//
//   1. mailMilestoneVerifier - second-stage AI check. verifyGenuine must be
//      true, and pre-verifier digests are permanently parked.
//   2. ROLLOUT_ALLOWLIST in src/services/clientMailNotifier.js.
//   3. inboxAlertsEnabled on the client's ClientReminderConfig - opt-in, OFF by
//      default, flipped per client from the Client Reminders tab.
//   4. MAX_ALERT_AGE_HOURS - a milestone older than 48h is never flushed.
//
// To stop the stream without a deploy, switch the clients off in the tab.
// Re-add a category here only as a true emergency stop.
const PAUSED_CATEGORIES = new Set([]);

export function isSmtpConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

/** Whether one outbound mail category is currently paused. */
export function isMailCategoryPaused(category) {
  return PAUSED_CATEGORIES.has(String(category || ""));
}

export function smtpFromEmail() {
  return process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || "";
}

// Singleton transporter — built once, reused for every send.
let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  const port = Number(process.env.SMTP_PORT) || 465;
  const secure =
    process.env.SMTP_SECURE != null
      ? String(process.env.SMTP_SECURE).toLowerCase() === "true"
      : port === 465;
  _transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port,
    secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  return _transporter;
}

// Test-seam: let verification inject a fake transporter without real SMTP.
export function __setTransporter(t) {
  _transporter = t;
}

/**
 * Actually connect + authenticate to the SMTP server (nodemailer verify()).
 * Used by the health route to prove the App Password works. Never throws.
 * @returns {Promise<{ok: boolean, user?: string, from?: string, error?: string}>}
 */
export async function verifySmtp() {
  if (!isSmtpConfigured()) return { ok: false, error: "smtp_not_configured" };
  try {
    await getTransporter().verify();
    return { ok: true, user: process.env.SMTP_USER, from: smtpFromEmail() };
  } catch (err) {
    return { ok: false, user: process.env.SMTP_USER, error: String(err?.message || err).slice(0, 300) };
  }
}

/**
 * Send one email over SMTP. Never throws — returns a result object.
 *
 * @param {Object} a
 * @param {string} a.to
 * @param {string} a.subject
 * @param {string} [a.html]
 * @param {string} [a.text]
 * @param {string} [a.replyTo]
 * @param {Object} [a.attachment] - { filename, mimetype, content (Buffer) }
 * @param {string} [a.category] - one of MAIL_CATEGORY; blocked if paused
 * @param {Object} [a.headers] - extra SMTP headers, e.g. List-Unsubscribe
 * @returns {Promise<{ok: boolean, messageId?: string, from?: string, error?: string}>}
 */
export async function sendViaSmtp({ to, subject, html, text, replyTo, attachment, category, headers }) {
  // Hard stop for a paused stream. Unlabelled sends are allowed through.
  if (isMailCategoryPaused(category)) {
    console.warn(
      `[smtpSender] category '${category}' PAUSED — not sending "${String(subject || "").slice(0, 60)}" to ${to}`
    );
    return { ok: false, error: "emails_paused", paused: true, category };
  }
  if (!isSmtpConfigured()) return { ok: false, error: "smtp_not_configured" };
  if (!to || !subject || (!html && !text)) return { ok: false, error: "missing_required_fields" };

  const fromEmail = smtpFromEmail();
  // Default the display name so a bare SMTP_USER/SMTP_PASS setup still sends
  // from "FlashFire <address>" rather than a naked address.
  const fromName = process.env.SMTP_FROM_NAME || "FlashFire";
  const from = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;

  // `headers` carries List-Unsubscribe / List-Unsubscribe-Post. Spread as a
  // plain object so nodemailer emits them verbatim - Gmail and Yahoo read those
  // exact header names and nothing else.
  const mail = {
    from,
    to,
    subject,
    html,
    text,
    ...(replyTo ? { replyTo } : {}),
    ...(headers && typeof headers === "object" && Object.keys(headers).length ? { headers } : {})
  };
  if (attachment) {
    mail.attachments = [
      { filename: attachment.filename, content: attachment.content, contentType: attachment.mimetype }
    ];
  }

  try {
    const info = await getTransporter().sendMail(mail);
    return { ok: true, messageId: info?.messageId || "", from };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 400) };
  }
}
