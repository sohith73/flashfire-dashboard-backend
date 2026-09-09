// onboardingMattermost - mirrors each onboarding email (base résumé ready,
// cover letter ready, LinkedIn done) into the client's Mattermost channel.
//
// WHERE THE WEBHOOK COMES FROM
// Operations pastes it into Operations > Client Reminders, which stores it on
// ClientReminderConfig.mattermostWebhookUrl keyed by the client's dashboard
// login email. That is the same key OnboardingMailState uses, so no mapping.
//
// FAIL SOFT, ALWAYS. The email is the product promise; the channel post rides
// on top of it. A missing webhook, a dead Mattermost or a Mongo hiccup returns
// a result object and never throws into the worker tick or the manual send.

import { ClientReminderConfig } from "../../Schema_Models/ClientReminderConfig.js";
import { sendToMattermost, isValidWebhookUrl, normalizeWebhookUrl } from "../../Utils/mattermostSender.js";
import { renderOnboardingMattermost } from "../../Utils/onboardingMailTemplates.js";

const LOG = "[onboarding-mattermost]";
const DASHBOARD_URL = "https://portal.flashfirejobs.com";

/**
 * The client's saved webhook, or "" when there is none or the lookup failed.
 * @param {string} clientEmail dashboard login email (lowercased here)
 */
export async function onboardingWebhookForClient(clientEmail) {
  const email = String(clientEmail || "").trim().toLowerCase();
  if (!email) return "";
  try {
    const cfg = await ClientReminderConfig.findOne({ clientEmail: email }).select("mattermostWebhookUrl").lean();
    return normalizeWebhookUrl(cfg?.mattermostWebhookUrl || "");
  } catch (err) {
    console.warn(`${LOG} webhook lookup failed for ${email}:`, err?.message || err);
    return "";
  }
}

/**
 * Post one step to a known webhook. Pure transport: no Mongo, so tests can
 * drive it with an injected fetch.
 *
 * @returns {Promise<{ok: boolean, skipped?: string, error?: string}>}
 */
export async function postOnboardingStepToMattermost({ webhookUrl, key, clientName, clientEmail } = {}) {
  if (!isValidWebhookUrl(webhookUrl)) return { ok: false, skipped: "no_webhook" };
  const rendered = renderOnboardingMattermost({ key, clientName, clientEmail, dashboardUrl: DASHBOARD_URL });
  if (!rendered) return { ok: false, skipped: "unknown_step" };
  const res = await sendToMattermost({ webhookUrl, text: rendered.text, username: "FlashFire" });
  if (res.ok) return { ok: true };
  // sendToMattermost has already redacted the webhook out of the message.
  return { ok: false, error: String(res.error || "mattermost delivery failed").slice(0, 300) };
}

/**
 * Look the webhook up and post. This is what the worker and the manual
 * send-step route call after the email is accepted.
 */
export async function mirrorOnboardingStep({ clientEmail, clientName, key } = {}) {
  const webhookUrl = await onboardingWebhookForClient(clientEmail);
  const res = await postOnboardingStepToMattermost({ webhookUrl, key, clientName, clientEmail });
  if (res.ok) {
    console.log(`${LOG} posted '${key}' for ${String(clientEmail || "").toLowerCase()}`);
  } else if (res.error) {
    console.warn(`${LOG} post '${key}' for ${String(clientEmail || "").toLowerCase()} failed: ${res.error}`);
  }
  return res;
}

/**
 * Stamp a step subdocument with the mirror outcome. Shared by the worker and
 * the manual route so both write the same two fields the same way.
 */
export function recordMirrorOnStep(step, res) {
  if (!step) return;
  if (res?.ok) {
    step.mattermostAt = new Date();
    step.mattermostError = "";
  } else if (res?.error) {
    step.mattermostError = res.error;
  }
  // A skip (no webhook configured) leaves both fields untouched: nothing was
  // attempted, so there is nothing to report on the row.
}
