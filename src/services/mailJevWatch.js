// mailJevWatch - a per-client Discord view of what the AI second look decided.
//
// Jev (src/services/mailJevTriage.js) reads every client mail the regexes did
// not flag. Its calls are stored on the digest, but nobody sees them unless
// they query Mongo. For a client an operator is watching, this posts ONE
// Discord card per hourly poll that lists every new mail with what the rules
// said, what Jev picked (and how sure it was), and what the pipeline then did:
// verified, client alerted, card auto-rejected.
//
// Off by default. Per client: ClientReminderConfig.jevWatchEnabled === true.
// Posts to MAIL_JEV_WATCH_WEBHOOK when set, else the mail channel
// (Utils/discordMailNotify.js notifyJevWatch). Fail-soft: a lookup or post
// failure is logged and never stops the poll.

import ClientReminderConfig from "../../Schema_Models/ClientReminderConfig.js";
import { notifyJevWatch } from "../../Utils/discordMailNotify.js";

const DESCRIPTION_BUDGET = 3800; // Discord's cap is 4096; leave room for the "+N more" line.
const SUBJECT_MAX = 90;

/** Whether this client's Jev decisions should go to Discord. Never throws. */
export async function isJevWatchOn(ownerEmail) {
  const email = String(ownerEmail || "").toLowerCase().trim();
  if (!email) return false;
  try {
    const doc = await ClientReminderConfig.findOne({ clientEmail: email, jevWatchEnabled: true }).select("_id").lean();
    return Boolean(doc);
  } catch (err) {
    console.warn(`[jev-watch] could not read the client toggle: ${err?.message || err}`);
    return false;
  }
}

const ENGINE_JEV = "jev";
const ENGINE_FALLBACK = "fallback";

/** "jev-1.14.0" -> jev; anything else that ran is the chat-model fallback. */
export function triageEngine(model) {
  return /^jev/i.test(String(model || "")) ? ENGINE_JEV : ENGINE_FALLBACK;
}

/**
 * One mail's outcome, built from what the poll already has in hand.
 * @param {Object} a
 * @param {Object} a.digest       - the saved MailDigest (category, subject, fromEmail, triage + verify fields)
 * @param {string} [a.triageModel] - model id the triage call reported
 * @param {string} [a.autoReject] - autoRejectForDigest outcome, when it ran
 * @param {string} [a.clientNotify] - notifyClientForDigest outcome
 */
export function jevWatchRow({ digest = {}, triageModel = "", autoReject = "", clientNotify = "" }) {
  let triage;
  if (digest.aiTriageSkipped) triage = { kind: "skipped", why: digest.aiTriageSkipped };
  else if (digest.aiTriageRan === true) {
    triage = {
      kind: "ran",
      engine: triageEngine(triageModel),
      category: digest.aiTriageCategory || "none",
      reason: digest.aiTriageReason || "",
      found: digest.aiTriageFound === true
    };
  } else if (digest.aiTriageError) triage = { kind: "error", why: digest.aiTriageError };
  else triage = { kind: "rules", why: digest.rulesCategory || digest.category || "" }; // regexes already flagged it

  return {
    subject: digest.subject || "(no subject)",
    from: digest.fromEmail || "",
    rulesCategory: digest.rulesCategory || "",
    finalCategory: digest.category || "",
    verifyGenuine: digest.verifyRan ? digest.verifyGenuine === true : null,
    rerouted: digest.verifyRerouted || "",
    triage,
    autoReject: autoReject || "",
    clientNotify: clientNotify || ""
  };
}

const md = (s) => String(s ?? "").replace(/([\\`*_~|>])/g, "\\$1").replace(/\s+/g, " ").trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Jev's own reason is "jev: interview (0.93)"; keep just the score. */
function score(reason) {
  const m = /\(([\d.]+)\)/.exec(reason || "");
  return m ? m[1] : "";
}

function triageText(t) {
  switch (t.kind) {
    case "skipped":
      return { icon: "⏭️", text: `skipped (${md(t.why)})` };
    case "error":
      return { icon: "🔴", text: `AI failed: ${md(clip(t.why, 80))}` };
    case "rules":
      return { icon: "📏", text: `regex flagged ${md(t.why)}, no AI read needed` };
    default: {
      const who = t.engine === ENGINE_JEV ? "Jev" : "fallback model (Jev failed)";
      const s = score(t.reason);
      const pick = `${who}: **${md(t.category)}**${s ? ` ${s}` : ""}`;
      if (t.engine !== ENGINE_JEV) return { icon: "🟠", text: pick };
      return { icon: t.found ? "🟢" : "⚪", text: pick };
    }
  }
}

function outcomeText(r) {
  const parts = [];
  if (r.verifyGenuine === true) parts.push("verified real");
  else if (r.verifyGenuine === false) parts.push("verifier said no");
  if (r.rerouted) parts.push(`rerouted ${md(r.rerouted)}`);
  if (r.clientNotify === "sent") parts.push("client alerted");
  if (r.autoReject === "applied") parts.push("card moved to Rejected");
  else if (r.autoReject && !["skipped", "client_off"].includes(r.autoReject)) parts.push(`auto-reject: ${md(r.autoReject)}`);
  return parts.join(" · ");
}

/** Counts for the card's fields. */
export function jevWatchTotals(rows) {
  const t = { mails: rows.length, jev: 0, found: 0, fallback: 0, skipped: 0, errors: 0, alerted: 0, autoRejected: 0 };
  for (const r of rows) {
    if (r.triage.kind === "skipped") t.skipped++;
    else if (r.triage.kind === "error") t.errors++;
    else if (r.triage.kind === "ran") {
      if (r.triage.engine === ENGINE_JEV) t.jev++;
      else t.fallback++;
      if (r.triage.found) t.found++;
    }
    if (r.clientNotify === "sent") t.alerted++;
    if (r.autoReject === "applied") t.autoRejected++;
  }
  return t;
}

/** The Discord embed for one poll of one watched mailbox. */
export function buildJevWatchEmbed({ client = {}, mailbox = "", rows = [], now = new Date() }) {
  const lines = [];
  let used = 0;
  let shown = 0;
  for (const r of rows) {
    const t = triageText(r.triage);
    const out = outcomeText(r);
    const final = r.finalCategory && r.finalCategory !== r.rulesCategory ? ` → **${md(r.finalCategory)}**` : "";
    const line =
      `${t.icon} ${md(clip(r.subject, SUBJECT_MAX))}\n` +
      `↳ ${md(r.from) || "unknown sender"} · regex: ${md(r.rulesCategory) || "-"} · ${t.text}${final}${out ? ` · ${out}` : ""}`;
    if (used + line.length + 2 > DESCRIPTION_BUDGET) break;
    lines.push(line);
    used += line.length + 2;
    shown++;
  }
  if (shown < rows.length) lines.push(`…and ${rows.length - shown} more`);

  const tot = jevWatchTotals(rows);
  const who = client.name || client.email || mailbox || "Client";
  return {
    title: clip(`🔎 Jev watch: ${who}`, 250),
    color: tot.found || tot.alerted || tot.autoRejected ? 0x22c55e : tot.errors || tot.fallback ? 0xf97316 : 0x64748b,
    description: lines.join("\n\n") || "No new mail.",
    fields: [
      { name: "Mailbox", value: md(mailbox) || "-", inline: false },
      { name: "New mails", value: String(tot.mails), inline: true },
      { name: "Read by Jev", value: String(tot.jev), inline: true },
      { name: "Jev found", value: String(tot.found), inline: true },
      { name: "Skipped (promo)", value: String(tot.skipped), inline: true },
      { name: "Fallback / errors", value: `${tot.fallback} / ${tot.errors}`, inline: true },
      { name: "Alerted / auto-rejected", value: `${tot.alerted} / ${tot.autoRejected}`, inline: true }
    ],
    footer: { text: "FlashFire • Jev watch • ⏭️ skipped 📏 regex 🟢 Jev found ⚪ Jev: nothing 🟠 fallback 🔴 failed" },
    timestamp: new Date(now).toISOString()
  };
}

/** Post the card. Never throws; returns the post result. */
export async function postJevWatch({ client, mailbox, rows }) {
  if (!rows?.length) return { ok: true, skipped: true };
  try {
    const res = await notifyJevWatch(buildJevWatchEmbed({ client, mailbox, rows }));
    if (!res.ok) console.warn(`[jev-watch] ${mailbox}: Discord post failed: ${res.error}`);
    return res;
  } catch (err) {
    console.warn(`[jev-watch] ${mailbox}: ${err?.message || err}`);
    return { ok: false, error: String(err?.message || err) };
  }
}

export const __testables = { triageText, outcomeText, md };
