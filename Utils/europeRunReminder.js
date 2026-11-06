// Europe run: the 3 AM weekday Discord reminder, and the relay the Autopilot
// app uses to ping the team while a run needs a human.
//
// Why a reminder and not a fully unattended run: the run happens in the
// operator's own Chrome on a laptop. Chrome asks "Allow" once per connection
// and Indeed/Glassdoor sometimes show a "verify you are human" check. Neither
// can be clicked by a script, so the schedule's job is to get a person to the
// laptop, not to run without one.
//
// Flow, Monday to Friday:
//   03:00 IST  this cron posts the list of Europe clients to Discord.
//   operator   opens Autopilot, presses "Run Europe clients", clicks Allow.
//   Autopilot  posts to POST /autopilot/europe-run/notify when it is waiting
//              for Allow, when a robot check needs solving, and when it is done.
//
// The webhook URL lives only here, in DISCORD_EUROPE_RUN_WEBHOOK_URL, so no
// laptop holds it. Unset means both the reminder and the relay are off and
// say so in the log.

import axios from "axios";
import cron from "node-cron";
import { ProfileModel } from "../Schema_Models/ProfileModel.js";
import { ClientPaymentLookup } from "../Schema_Models/ClientPaymentLookup.js";
import { getEuropeClients, ensureEuropeSources } from "./europeClients.js";

export const EUROPE_RUN_CRON = "0 3 * * 1-5"; // 03:00, Monday-Friday
export const EUROPE_RUN_TZ = "Asia/Kolkata";
const DISCORD_LIMIT = 1900; // Discord caps content at 2000 characters

function webhookUrl() {
  return String(process.env.DISCORD_EUROPE_RUN_WEBHOOK_URL || "").trim();
}

export async function postToDiscord(content, { post = axios.post } = {}) {
  const url = webhookUrl();
  if (!url) return { sent: false, reason: "DISCORD_EUROPE_RUN_WEBHOOK_URL is not set" };
  const text = String(content || "").slice(0, DISCORD_LIMIT);
  await post(url, { content: text, allowed_mentions: { parse: ["everyone"] } }, { timeout: 15000 });
  return { sent: true };
}

/** The reminder text for a list of Europe clients. Pure, for testing. */
export function reminderText(clients) {
  const names = clients.map((c) => `• ${c.name} (${(c.countries || []).join(", ").toUpperCase() || "Europe"})`);
  const head = [
    `@everyone **Europe run: ${clients.length} client${clients.length === 1 ? "" : "s"} today**`,
    "1. Open Flashfire Autopilot on the laptop and press **Run Europe clients**.",
    "2. Click **Allow** in Chrome once (the prompt waits up to 15 minutes).",
    "3. If Indeed or Glassdoor shows **verify you are human**, solve it in that Chrome.",
    "",
  ].join("\n");
  let body = "";
  let shown = 0;
  for (const line of names) {
    if (head.length + body.length + line.length + 30 > DISCORD_LIMIT) break;
    body += line + "\n";
    shown += 1;
  }
  if (shown < names.length) body += `…and ${names.length - shown} more\n`;
  return head + body;
}

export async function sendEuropeRunReminder() {
  const clients = await getEuropeClients({ ProfileModel, ClientPaymentLookup });
  // New Europe clients get Indeed, Glassdoor and HiringCafe before the run.
  try {
    const changed = await ensureEuropeSources({ ProfileModel, clients });
    if (changed) console.log(`[europe-run] enabled Indeed/Glassdoor/HiringCafe for ${changed} client(s)`);
  } catch (error) {
    console.error("[europe-run] could not enable Europe sources:", error.message);
  }
  if (!clients.length) {
    console.log("[europe-run] no active Europe clients today; no reminder sent");
    return { sent: false, reason: "no clients" };
  }
  const r = await postToDiscord(reminderText(clients));
  console.log(`[europe-run] reminder for ${clients.length} client(s): ${r.sent ? "sent" : r.reason}`);
  return { ...r, clients: clients.length };
}

export function startEuropeRunReminder() {
  // Scheduled even without the webhook: the same job keeps every Europe
  // client's sources on. postToDiscord reports the missing webhook itself.
  if (!webhookUrl()) {
    console.log("[europe-run] DISCORD_EUROPE_RUN_WEBHOOK_URL not set; 3 AM job only enables sources");
  }
  cron.schedule(EUROPE_RUN_CRON, async () => {
    try {
      await sendEuropeRunReminder();
    } catch (error) {
      console.error("[europe-run] reminder failed:", error.message);
    }
  }, { timezone: EUROPE_RUN_TZ });
  console.log(`[europe-run] reminder registered (${EUROPE_RUN_CRON} ${EUROPE_RUN_TZ})`);
}
