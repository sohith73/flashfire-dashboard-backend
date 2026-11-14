import { unsubscribeUrl, UNSUB_STREAMS } from "./unsubscribe.js";
// Branded templates for the onboarding email sequence that fires on a client's
// first application. FlashFire flame theme, inline CSS, table layout — same look
// as the client milestone alerts. One template per step.

const BRAND = {
  slate: "#1f2937",
  ink: "#111827",
  body: "#374151",
  muted: "#6b7280",
  faint: "#9ca3af",
  line: "#e5e7eb",
  flameFrom: "#f97316",
  flameTo: "#ef4444"
};

// Per-step copy. `key` is what the schedule stores.
const STEPS = {
  base_resume: {
    label: "Base résumé ready",
    subject: "Your base résumé is ready",
    heading: "Your base résumé is made",
    body: "Your base résumé is ready. Please check it in your WhatsApp group for reference."
  },
  cover_letter: {
    label: "Cover letter ready",
    subject: "Your cover letter is ready",
    heading: "Your cover letter is made",
    body: "Your cover letter is ready. Please check it in your WhatsApp group for reference."
  },
  linkedin: {
    label: "LinkedIn optimized",
    subject: "Your LinkedIn optimization is done",
    heading: "Your LinkedIn optimization is done",
    body: "Your LinkedIn optimization is complete. Please check your WhatsApp group for the details."
  }
};

export const ONBOARDING_STEP_KEYS = Object.keys(STEPS);
export function isOnboardingStep(key) {
  return Object.prototype.hasOwnProperty.call(STEPS, key);
}
export function onboardingSubject(key) {
  return STEPS[key]?.subject || "An update from FlashFire";
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function firstName(name, email) {
  const n = String(name || "").trim();
  if (n) return n.split(/\s+/)[0];
  const e = String(email || "");
  return e ? e.split("@")[0] : "there";
}

/**
 * Render one onboarding email.
 * @param {Object} a
 * @param {string} a.key   - base_resume | cover_letter | linkedin
 * @param {string} [a.clientName]
 * @param {string} [a.clientEmail]
 * @returns {{subject:string, html:string, text:string}|null}
 */
export function renderOnboardingEmail({ key, clientName, clientEmail } = {}) {
  // This is a short fixed sequence, but it is still unsolicited automated mail
  // from the client's point of view, so it carries the same opt-out.
  const unsubUrl = unsubscribeUrl(clientEmail, UNSUB_STREAMS.ONBOARDING);
  const step = STEPS[key];
  if (!step) return null;
  const name = firstName(clientName, clientEmail);

  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="light">
<title>${escapeHtml(step.heading)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
        <tr><td style="background:${BRAND.slate};border-radius:14px 14px 0 0;padding:22px 28px;">
          <span style="color:#ffffff;font-size:20px;font-weight:800;vertical-align:middle;letter-spacing:.01em;">FlashFire</span>
        </td></tr>
        <tr><td style="background:#ffffff;padding:30px 28px;">
          <span style="display:inline-block;background:#fff7ed;color:#ea580c;border:1px solid #fed7aa;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:5px 12px;border-radius:999px;">${escapeHtml(step.label)}</span>
          <h1 style="margin:16px 0 10px;color:${BRAND.ink};font-size:23px;line-height:1.3;font-weight:800;">${escapeHtml(step.heading)}, ${escapeHtml(name)}</h1>
          <p style="margin:0 0 18px;color:${BRAND.body};font-size:15px;line-height:1.6;">${escapeHtml(step.body)}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;">
            <tr><td style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 16px;color:#166534;font-size:14px;line-height:1.5;">
              Please check your <strong>WhatsApp group</strong> for the file and reference.
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="background:#ffffff;border-radius:0 0 14px 14px;padding:0 28px 24px;">
          <p style="margin:14px 0 0;color:${BRAND.faint};font-size:12px;line-height:1.6;border-top:1px solid ${BRAND.line};padding-top:16px;text-align:center;">
            © ${new Date().getFullYear()} FlashFire · Your job search team is on it.${
              unsubUrl
                ? `<br><a href="${unsubUrl}" style="color:${BRAND.faint};text-decoration:underline;">Unsubscribe</a>`
                : ""
            }
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `${step.heading}, ${name}`,
    "",
    step.body,
    "",
    "Please check your WhatsApp group for the file and reference.",
    "",
    "— FlashFire"
  ].join("\n");

  return { subject: step.subject, html, text };
}
