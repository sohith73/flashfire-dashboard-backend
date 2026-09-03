import { unsubscribeUrl, UNSUB_STREAMS } from "./unsubscribe.js";
// Branded HTML email templates for client milestone alerts.
//
// Design (2026-08-24 redesign, modeled on Mattermost's notification mail):
// one centered white card on a light-gray page, logo + wordmark on top, a big
// centered headline, one quiet sub-line, a single CTA button, then a bordered
// inner card with the source mail's facts. No gradients on surfaces, no
// category tint blocks, no emoji in the body — the only brand color is the
// flame-orange CTA and links.
//
// All CSS is inline and layout is table-based — the only thing email clients
// (Gmail, Outlook, Apple Mail) render reliably. No external assets except the
// hosted logo, no web fonts.

const BRAND = {
  page: "#f4f4f6", // page background
  card: "#ffffff",
  ink: "#24262b", // headings
  body: "#3f4350", // body text
  muted: "#6b7280",
  faint: "#9aa0aa",
  line: "#e3e3e7", // borders
  accent: "#ea580c", // flame orange — buttons and links
  accentDark: "#c2410c"
};

// Hosted FlashFire logo (public/Logo.png on the deployed portal). Email clients
// need an absolute HTTPS URL — data URIs and local files are stripped by Gmail.
const LOGO_URL = "https://portal.flashfirejobs.com/Logo.png";

// Per-category copy. `key` is the classifier category; `assessment` is
// surfaced to the client as "Assignment".
const CATEGORY = {
  interview: {
    label: "Interview invite",
    headline: "You have an interview invite",
    blurb: "A company in your connected inbox wants to schedule an interview with you."
  },
  assessment: {
    label: "Assignment",
    headline: "You have a new assignment",
    blurb: "A company sent you an assessment to complete. Watch the deadline."
  },
  offer: {
    label: "Offer",
    headline: "You have an offer",
    blurb: "An offer just landed in your connected inbox. Congratulations."
  }
};

// Categories that can be surfaced to the client. Exported so the notifier and
// the templates never drift apart.
export const NOTIFIABLE_CATEGORIES = Object.keys(CATEGORY);

export function categoryMeta(category) {
  return CATEGORY[category] || null;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Only allow http(s) links into href attributes — never a javascript: URI.
function safeUrl(u) {
  const s = String(u || "").trim();
  return /^https?:\/\//i.test(s) ? s : "";
}

// "Aug 24, 2026, 2:35 PM ET" — clients are US-based; a labeled zone beats a
// raw ISO timestamp in a client-facing mail.
function formatReceived(date) {
  const d = date instanceof Date ? date : date ? new Date(date) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  try {
    // IST, not ET. Every other timestamp this product shows a client is IST -
    // the dashboard, the scheduled reports, and this alert's own Mattermost
    // message, which already said IST. Stamping the email in Eastern time meant
    // the same mail was announced at two different times depending on which
    // channel the client happened to read first.
    return (
      d.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      }) + " IST"
    );
  } catch {
    return d.toISOString();
  }
}

/**
 * Render a milestone alert email for one classified mail.
 *
 * @param {Object} a
 * @param {Object} a.client   - { name, email }
 * @param {Object} a.digest   - { category, subject, from, fromEmail, summary,
 *                               actionRequired, urls[], date }
 * @param {string} [a.dashboardUrl] - CTA target (defaults to the dashboard root)
 * @returns {{subject: string, html: string, text: string, category: string}}
 */
export function renderClientMilestoneEmail({ client = {}, digest = {}, dashboardUrl }) {
  const meta = CATEGORY[digest.category] || CATEGORY.interview;

  const subjectLine = digest.subject ? String(digest.subject) : "(no subject)";
  const sender = digest.from || digest.fromEmail || "a company";
  const summary = (digest.summary || digest.snippet || "").trim();
  const action = (digest.actionRequired || "").trim();
  const received = formatReceived(digest.date);
  const cta = safeUrl(dashboardUrl) || "https://portal.flashfirejobs.com";
  // Opting out of these stops the inbox alerts only. A client who wants the
  // interview mail but not the daily count should not lose both.
  const unsubUrl = unsubscribeUrl(client?.email, UNSUB_STREAMS.INBOX_ALERTS);

  // ── Subject line of OUR email ──
  const subject = `${meta.headline} - ${subjectLine}`.slice(0, 180);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(meta.headline)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.page};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(meta.label)} from ${escapeHtml(sender)} - ${escapeHtml(subjectLine)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.page};padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:${BRAND.card};border:1px solid ${BRAND.line};border-radius:10px;">
        <tr><td style="padding:36px 40px 32px;">

          <!-- Logo + wordmark -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding-bottom:26px;">
              <img src="${LOGO_URL}" width="28" height="28" alt="" style="display:inline-block;width:28px;height:28px;border-radius:7px;vertical-align:middle;border:0;outline:none;">
              <span style="color:${BRAND.ink};font-size:19px;font-weight:700;letter-spacing:-0.01em;vertical-align:middle;margin-left:9px;">Flashfire</span>
            </td></tr>
          </table>

          <!-- Headline -->
          <h1 style="margin:0 0 10px;color:${BRAND.ink};font-size:26px;line-height:1.3;font-weight:700;text-align:center;">${escapeHtml(meta.headline)}</h1>
          <p style="margin:0 0 24px;color:${BRAND.muted};font-size:15px;line-height:1.5;text-align:center;">See below for a summary of what we found in your inbox.</p>

          <!-- CTA -->
          <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto 30px;">
            <tr><td style="border-radius:8px;background:${BRAND.accent};">
              <a href="${cta}" target="_blank"
                 style="display:inline-block;padding:12px 26px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">Open your dashboard</a>
            </td></tr>
          </table>

          <!-- Source mail card: inline bold labels, one flowing block -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND.line};border-radius:8px;">
            <tr><td style="padding:18px 20px;">
              <p style="margin:0;color:${BRAND.body};font-size:14px;line-height:1.7;">
                <strong style="color:${BRAND.ink};">Category:</strong> ${escapeHtml(meta.label)}
                &nbsp; <strong style="color:${BRAND.ink};">From:</strong> ${escapeHtml(sender)}<br>
                <strong style="color:${BRAND.ink};">Subject:</strong> ${escapeHtml(subjectLine)}${received ? `<br><strong style="color:${BRAND.ink};">Received:</strong> ${escapeHtml(received)}` : ""}
              </p>
              ${
                summary
                  ? `<p style="margin:12px 0 0;color:${BRAND.body};font-size:14px;line-height:1.6;">${escapeHtml(summary.slice(0, 500))}</p>`
                  : ""
              }
              <p style="margin:14px 0 0;">
                <a href="${cta}" target="_blank" style="color:${BRAND.accent};font-size:14px;font-weight:600;text-decoration:none;">Open inbox</a>
              </p>
            </td></tr>
          </table>

        </td></tr>
      </table>

      <!-- Footer -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr><td align="center" style="padding:18px 20px 0;color:${BRAND.faint};font-size:12px;line-height:1.7;">
          © ${new Date().getFullYear()} Flashfire · You're receiving this because your job-search inbox is connected to Flashfire.<br>
          <a href="https://portal.flashfirejobs.com" target="_blank" style="color:${BRAND.faint};text-decoration:underline;">portal.flashfirejobs.com</a>${
            unsubUrl
              ? ` &nbsp;·&nbsp; <a href="${unsubUrl}" target="_blank" style="color:${BRAND.faint};text-decoration:underline;">Unsubscribe</a>`
              : ""
          }
        </td></tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;

  // ── Plaintext fallback ──
  const textLines = [
    meta.headline,
    "",
    meta.blurb,
    "",
    `Category: ${meta.label}`,
    `From: ${sender}`,
    `Subject: ${subjectLine}`
  ];
  if (received) textLines.push(`Received: ${received}`);
  if (summary) textLines.push("", summary.slice(0, 500));
  if (action) textLines.push("", `Next step: ${action}`);
  textLines.push("", `Open your dashboard: ${cta}`);
  textLines.push("", "- Flashfire, flagged from your connected inbox.");
  if (unsubUrl) textLines.push("", `Unsubscribe: ${unsubUrl}`);
  const text = textLines.join("\n");

  return { subject, html, text, category: digest.category };
}

/**
 * The same milestone, rendered for the client's Mattermost channel.
 *
 * Deliberately shorter than the email. A channel post is glanceable: what
 * happened, from whom, when, and one link to the dashboard. Everything the
 * classifier inferred stays out - we state the fact of the mail, not our
 * confidence about it.
 *
 * The subject and sender are scraped from the client's real inbox, so both go
 * through mmEscape. A recruiter signature containing markdown, or a subject
 * crafted to close a link we opened, must not be able to forge anything in a
 * channel our name is on.
 *
 * @param {object} a
 * @param {object} a.digest  the MailDigest document
 * @param {string} [a.dashboardUrl]
 * @returns {{text: string}|null} null when the category is not notifiable
 */
export function renderClientMilestoneMattermost({ digest = {}, dashboardUrl } = {}) {
  const category = String(digest.clientNotifyCategory || digest.category || "").toLowerCase();
  const meta = CATEGORY[category];
  if (!meta) return null;

  const mmEscape = (v) => String(v ?? "").replace(/([\\`*_{}[\]()<>#+\-.!|~])/g, "\\$1");

  const received = digest.date
    ? new Date(digest.date).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      })
    : "";

  const lines = [
    `#### ${meta.label}: ${mmEscape(digest.subject || "(no subject)")}`,
    "",
    meta.blurb
  ];
  if (digest.from) lines.push("", `**From:** ${mmEscape(digest.from)}`);
  if (received) lines.push(`**Received:** ${received} IST`);
  if (dashboardUrl) lines.push("", `[Open your dashboard](${dashboardUrl})`);

  return { text: lines.join("\n") };
}
