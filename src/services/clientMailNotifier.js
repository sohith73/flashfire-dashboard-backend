// clientMailNotifier — emails the client when their connected inbox receives a
// positive milestone (interview / assignment / offer), using the branded
// flame-theme templates.
//
// Delivery (per product requirement):
//  • Sent over SMTP with the shared Gmail App Password (the same account
//    clients-tracking sends milestone mail from). Gmail auto-saves a copy to
//    that account's Sent folder → durable proof we sent it.
//  • Addressed to the client's stored PAYMENT EMAIL (dashboardtrackings.paymentEmail),
//    NOT the connected mailbox or dashboard login. No payment email on file →
//    the alert is skipped and the reason recorded (never sent to a guessed address).
//
// Design:
//  • Eligibility is decided ONCE from the classification (deriveEligibility),
//    stored on the MailDigest at creation time. Positive milestones only.
//  • Idempotent: clientNotifiedAt is the dedupe guard, flipped only after the
//    send is accepted. A retry can never double-send.
//  • FAIL-SOFT: a send failure is recorded and retried on later ticks (capped),
//    and NEVER blocks the poll or the Discord path.

import { MailDigest } from "../../Schema_Models/MailDigest.js";
import { sendEmail, isSendgridConfigured } from "../../Utils/sendgridClient.js";
import { sendViaSmtp, isSmtpConfigured, isMailCategoryPaused, MAIL_CATEGORY } from "../../Utils/smtpSender.js";
import {
  renderClientMilestoneEmail,
  renderClientMilestoneMattermost,
  NOTIFIABLE_CATEGORIES
} from "../../Utils/clientMailTemplates.js";
import { ClientReminderConfig } from "../../Schema_Models/ClientReminderConfig.js";
import { sendToMattermost, isValidWebhookUrl, normalizeWebhookUrl } from "../../Utils/mattermostSender.js";
import { unsubscribeHeaders, UNSUB_STREAMS } from "../../Utils/unsubscribe.js";

// ─── Fixed config (hard-coded; the only runtime input is SMTP_USER/SMTP_PASS) ──
const ENABLED = true; // gated upstream by the poll's master switch
const CHANNEL = "smtp"; // SMTP only → the send lands in the account's Sent folder as proof
// Positive milestones only. 'assessment' is shown to the client as "Assignment".
const NOTIFY_CATEGORIES = new Set(["interview", "assessment", "offer"]);
// Only email milestones the classifier was confident about (priority ≥ medium).
const MIN_PRIORITY = "medium";
const PRIORITY_RANK = { low: 0, medium: 1, high: 2 };
const MAX_ATTEMPTS = 4; // give up after this many failed sends
const DASHBOARD_URL = "https://portal.flashfirejobs.com"; // email CTA target
const FROM_EMAIL = ""; // SMTP path uses SMTP_FROM_EMAIL / SMTP_USER
const FROM_NAME = "Flashfire";

// ─── Rollout gate (2026-08-24) ─────────────────────────────────────────
// The stream just came back from a 12-day pause behind the new AI verifier.
// While we prove it in production, milestone alerts send ONLY for the clients
// listed here — matched against the client's dashboard email, payment email,
// or connected mailbox, all lowercased. EMPTY SET = everyone. To go live for
// all clients, clear the set.
const ROLLOUT_ALLOWLIST = new Set(["rijuljain17@gmail.com"]);

/** Pure rollout check — exported for tests. */
export function rolloutAllows({ clientEmail, paymentEmail, mailbox }) {
  if (ROLLOUT_ALLOWLIST.size === 0) return true;
  return [clientEmail, paymentEmail, mailbox].some((e) =>
    ROLLOUT_ALLOWLIST.has(String(e || "").trim().toLowerCase())
  );
}

// A milestone alert is time-sensitive; a digest that sat unsent for days
// (rollout gate, long outage, widened allowlist) must not suddenly flush a
// stale "you've got an interview" to a client.
const MAX_ALERT_AGE_HOURS = 48;

/** Pure staleness check — exported for tests. Unknown date → not stale. */
export function isTooOldToNotify(digestDate, now = Date.now()) {
  const t = digestDate ? new Date(digestDate).getTime() : NaN;
  if (Number.isNaN(t)) return false;
  return now - t > MAX_ALERT_AGE_HOURS * 3600 * 1000;
}

function isChannelConfigured() {
  return CHANNEL === "smtp" ? isSmtpConfigured() : isSendgridConfigured();
}

// deriveEligibility: pure, decided at digest-creation time from the classifier
// output. Works for either source:
//   • AI    → pass confident = aiSucceeded
//   • rules → pass confident = matched (a real category rule fired)
// A mail only emails the client when the classification is confident, the
// category is notifiable, and the priority clears the floor.
export function deriveEligibility({ category, priority, confident, aiSucceeded, matched }) {
  const cat = String(category || "").toLowerCase();
  // Back-compat: accept the old aiSucceeded arg, or the rules `matched` flag.
  const trustworthy = confident ?? (aiSucceeded === true || matched === true);
  const eligible =
    trustworthy === true &&
    NOTIFY_CATEGORIES.has(cat) &&
    NOTIFIABLE_CATEGORIES.includes(cat) &&
    (PRIORITY_RANK[priority] ?? 0) >= (PRIORITY_RANK[MIN_PRIORITY] ?? 1);
  return {
    clientNotifyEligible: eligible,
    clientNotifyCategory: eligible ? cat : ""
  };
}

// resolveRecipient: the client's stored PAYMENT email — nothing else. The worker
// attaches client.paymentEmail (from dashboardtrackings). We never fall back to
// the dashboard or connected address: a milestone alert must go to the payment
// email on file or not at all.
function resolveRecipient(client) {
  const pay = (client?.paymentEmail || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pay) ? pay : "";
}

/**
 * Per-client opt-in for inbox milestone forwarding, read from the Client
 * Reminders tab.
 *
 * OFF unless an operator has explicitly switched it on. This is a classifier
 * reading somebody's real mailbox: a false positive here does not send a wrong
 * number, it tells a client they have an offer they do not have. Opt-in is the
 * only safe default, and a missing config document means opt-out.
 *
 * @returns {Promise<{enabled: boolean, webhookUrl: string}>}
 */
export async function readInboxAlertConfig(clientEmail) {
  const email = String(clientEmail || "").trim().toLowerCase();
  if (!email) return { enabled: false, webhookUrl: "" };
  try {
    const cfg = await ClientReminderConfig.findOne({ clientEmail: email })
      .select("inboxAlertsEnabled mattermostWebhookUrl")
      .lean();
    return {
      enabled: cfg?.inboxAlertsEnabled === true,
      webhookUrl: normalizeWebhookUrl(cfg?.mattermostWebhookUrl || "")
    };
  } catch (err) {
    // Fail CLOSED. If we cannot read the opt-in we do not send - the failure
    // mode of guessing "on" is a client-facing false alarm.
    console.error(`[client-notify] inbox-alert config read failed for ${email}:`, err?.message || err);
    return { enabled: false, webhookUrl: "" };
  }
}

/**
 * Post the milestone to the client's Mattermost channel, at most once.
 *
 * Its own stamp (clientMattermostAt), independent of the email half, so a
 * webhook outage never blocks the email and a bounced email never re-posts a
 * channel message that already landed.
 *
 * @returns {Promise<"sent"|"skipped"|"failed"|"already">}
 */
export async function notifyClientMattermostForDigest({ digestDoc, webhookUrl }) {
  if (digestDoc?.clientMattermostAt) return "already";
  if (!isValidWebhookUrl(webhookUrl)) return "skipped";
  if ((digestDoc.clientMattermostAttempts || 0) >= MAX_ATTEMPTS) return "failed";

  const rendered = renderClientMilestoneMattermost({ digest: digestDoc, dashboardUrl: DASHBOARD_URL });
  if (!rendered) return "skipped";

  const res = await sendToMattermost({ webhookUrl, text: rendered.text, username: "FlashFire" });

  if (res.ok) {
    // Same guarded flip as the email half: the update only matches while the
    // stamp is still null, so two racing workers cannot both post-and-count.
    await MailDigest.updateOne(
      { _id: digestDoc._id, clientMattermostAt: null },
      { $set: { clientMattermostAt: new Date(), clientMattermostError: "" }, $inc: { clientMattermostAttempts: 1 } }
    ).catch(() => {});
    return "sent";
  }

  await MailDigest.updateOne(
    { _id: digestDoc._id },
    {
      $set: { clientMattermostError: String(res.error || "unknown").slice(0, 300) },
      $inc: { clientMattermostAttempts: 1 }
    }
  ).catch(() => {});
  return "failed";
}

/**
 * Send the milestone alert for one already-persisted, eligible digest.
 * Records the outcome on the digest. Never throws.
 *
 * @returns {"sent"|"skipped"|"failed"|"disabled"|"already"}
 */
export async function notifyClientForDigest({ digestDoc, client, mailbox }) {
  if (!ENABLED) return "disabled";
  // This stream is paused (classifier false positives) — send nothing, and
  // DON'T burn the attempt counter, so these still deliver cleanly once the
  // 'client-milestone' category is un-paused (see Utils/smtpSender.js).
  if (isMailCategoryPaused(MAIL_CATEGORY.CLIENT_MILESTONE)) return "disabled";
  if (!digestDoc?.clientNotifyEligible) return "skipped";
  // Verification is mandatory on the send path (2026-08-24). Digests created
  // before the verifier existed — including the pause-era backlog whose sends
  // were deferred, false positives among them — carry verifyGenuine=false and
  // must never flush to a client.
  if (digestDoc.verifyGenuine !== true) {
    await MailDigest.updateOne(
      { _id: digestDoc._id },
      { $set: { clientNotifySkippedReason: "unverified_pre_verifier_digest" } }
    ).catch(() => {});
    return "skipped";
  }
  // Per-client opt-in. Read BEFORE the attempt counter so leaving it off never
  // burns retries: flipping the toggle on later must let fresh digests send
  // normally (stale ones are still stopped by the age guard below).
  const inbox = await readInboxAlertConfig(client?.email || mailbox);
  if (!inbox.enabled) {
    await MailDigest.updateOne(
      { _id: digestDoc._id },
      { $set: { clientNotifySkippedReason: "inbox_alerts_off" } }
    ).catch(() => {});
    return "skipped";
  }

  if (digestDoc.clientNotifiedAt) return "already";

  // Give up after repeated failures rather than emailing forever.
  if ((digestDoc.clientNotifyAttempts || 0) >= MAX_ATTEMPTS) {
    return "failed";
  }

  const recordSkip = async (reason) => {
    await MailDigest.updateOne(
      { _id: digestDoc._id },
      { $set: { clientNotifySkippedReason: reason } }
    ).catch(() => {});
  };

  if (!isChannelConfigured()) {
    await recordSkip(CHANNEL === "smtp" ? "smtp_not_configured" : "sendgrid_not_configured");
    return "skipped";
  }

  // Rollout gate: during the staged rollout only allowlisted clients get
  // alerts. Attempts are NOT burned, so widening the list later lets fresh
  // digests send normally (stale ones are stopped by the age guard below).
  if (!rolloutAllows({ clientEmail: client?.email, paymentEmail: client?.paymentEmail, mailbox })) {
    await recordSkip("rollout_allowlist");
    return "skipped";
  }

  // Never flush an old milestone: the mail is only useful near receipt.
  if (isTooOldToNotify(digestDoc.date || digestDoc.createdAt)) {
    await recordSkip("stale_digest");
    return "skipped";
  }

  // Payment email is the ONLY acceptable recipient.
  const to = resolveRecipient(client);
  if (!to) {
    await recordSkip("no_payment_email");
    return "skipped";
  }

  const { subject, html, text } = renderClientMilestoneEmail({
    client,
    digest: digestDoc,
    dashboardUrl: DASHBOARD_URL
  });

  const result =
    CHANNEL === "smtp"
      ? await sendViaSmtp({
          to,
          subject,
          html,
          text,
          category: MAIL_CATEGORY.CLIENT_MILESTONE,
          headers: unsubscribeHeaders(client?.email || to, UNSUB_STREAMS.INBOX_ALERTS)
        })
      : await sendEmail({
          to,
          subject,
          html,
          text,
          fromEmail: FROM_EMAIL || undefined,
          fromName: FROM_NAME,
          categories: ["client-milestone", `milestone-${digestDoc.clientNotifyCategory || "other"}`]
        });

  if (result.ok) {
    // Guard the flip on clientNotifiedAt still being null so two racing workers
    // can't both mark-and-count. Whoever's update matches wins; the loser is a
    // no-op (the mail was already sent by the winner in the same instant — the
    // in-process poll is single-flighted, so a true double-send cannot occur).
    // messageId is the SMTP message-id — the send receipt matching the Sent-folder copy.
    await MailDigest.updateOne(
      { _id: digestDoc._id, clientNotifiedAt: null },
      {
        $set: {
          clientNotifiedAt: new Date(),
          clientNotifyTo: to,
          clientNotifyChannel: CHANNEL,
          clientNotifyMessageId: result.messageId || "",
          clientNotifyError: "",
          clientNotifySkippedReason: ""
        },
        $inc: { clientNotifyAttempts: 1 }
      }
    ).catch(() => {});
    return "sent";
  }

  await MailDigest.updateOne(
    { _id: digestDoc._id },
    {
      $set: { clientNotifyError: String(result.error || "unknown").slice(0, 400) },
      $inc: { clientNotifyAttempts: 1 }
    }
  ).catch(() => {});
  console.warn(
    `[client-notify] ${mailbox}: send failed for ${digestDoc.messageId} (${digestDoc.clientNotifyCategory}): ${result.error}`
  );
  return "failed";
}

/**
 * Deliver one milestone to the client over BOTH configured channels.
 *
 * This is what the poll and the retry sweep call. The two halves are run
 * independently and neither can suppress the other:
 *
 *   - the email half dedupes on clientNotifiedAt
 *   - the Mattermost half dedupes on clientMattermostAt
 *
 * Sharing one "notified" flag would mean a webhook 5xx blocks the email
 * forever, or a retry that re-posts a channel message which already landed.
 * Each channel is at-most-once on its own stamp.
 *
 * @returns {Promise<{email: string, mattermost: string}>} per-channel outcome
 */
export async function notifyClientForDigestAllChannels({ digestDoc, client, mailbox }) {
  const email = await notifyClientForDigest({ digestDoc, client, mailbox });

  // Only post to the channel when the mail actually cleared every gate. A
  // digest skipped as a false positive, stale, or opted-out must not reach
  // Mattermost either - the gates protect the client, not just the inbox.
  if (email === "disabled" || email === "skipped") return { email, mattermost: "skipped" };

  const inbox = await readInboxAlertConfig(client?.email || mailbox);
  if (!inbox.enabled || !inbox.webhookUrl) return { email, mattermost: "skipped" };

  // Re-read: the email half just stamped the document, and posting from a
  // stale in-memory copy would re-run against the wrong dedupe state.
  const fresh = await MailDigest.findById(digestDoc._id).lean().catch(() => null);
  const mattermost = fresh
    ? await notifyClientMattermostForDigest({ digestDoc: fresh, webhookUrl: inbox.webhookUrl })
    : "failed";

  return { email, mattermost };
}

/**
 * Retry sweep: eligible digests not yet emailed (a prior send failed or the
 * worker crashed between claim and send). Bounded per call.
 *
 * @returns {Promise<number>} count actually sent this pass
 */
export async function retryPendingClientNotifications({ gmailEmail, client, limit = 25 }) {
  if (!ENABLED || !isChannelConfigured()) return 0;

  const pending = await MailDigest.find({
    gmailEmail,
    clientNotifyEligible: true,
    // Only AI-verified milestones may retry; pre-verifier backlog stays parked.
    verifyGenuine: true,
    clientNotifiedAt: null,
    clientNotifyAttempts: { $lt: MAX_ATTEMPTS }
  })
    .sort({ date: 1 })
    .limit(limit);

  let sent = 0;
  for (const doc of pending) {
    const outcome = await notifyClientForDigestAllChannels({ digestDoc: doc, client, mailbox: gmailEmail });
    if (outcome.email === "sent") sent++;
  }
  if (sent) console.log(`[client-notify] ${gmailEmail}: recovered ${sent} pending milestone alert(s)`);
  return sent;
}

export const __config = { NOTIFY_CATEGORIES, MIN_PRIORITY, MAX_ATTEMPTS, ENABLED };
