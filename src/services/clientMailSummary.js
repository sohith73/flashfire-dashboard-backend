// clientMailSummary: how many clients we emailed in the 5 AM summary window,
// and what happened to the interview / assignment / offer mails the header
// counts. Posted as a second card on the same Discord message as the Daily
// Mail Summary header (mailClientMonitor.sendDailySummary).
//
// Read only. Sources, all in this database:
//   reminderdeliveries   daily summary outcomes (sent / below 5 / none added / failed)
//   onboardingmailstates onboarding emails sent (steps[].sentAt)
//   clientemaillogs      plan milestone emails, written by clients-tracking
//   maildigests          the useful mails in the window and whether the client
//                        was emailed about each one
//
// summarizeClientMail() is pure so the counting rules are testable without Mongo.

import mongoose from "mongoose";
import { ReminderDelivery } from "../../Schema_Models/ReminderDelivery.js";
import { OnboardingMailState } from "../../Schema_Models/OnboardingMailState.js";
import { isClientMailOffDay } from "../../Utils/clientMailDays.js";

const lc = (s) => String(s || "").toLowerCase().trim();

/**
 * Read the raw rows for [since, until). Throws on a DB error; the caller
 * decides what the summary says then.
 *
 * @param {object} a
 * @param {Date} a.since
 * @param {Date} a.until
 * @param {Array} a.usefulDocs  the window's verified useful MailDigest docs,
 *                              with the clientNotify* fields selected
 */
export async function collectClientMailRows({ since, until, usefulDocs = [] }) {
  const range = { $gte: since, $lt: until };
  const [reminders, onboarding, milestones] = await Promise.all([
    ReminderDelivery.find({ itemKey: "daily_summary", at: range })
      .select("clientEmail status reason email.ok")
      .lean(),
    OnboardingMailState.find({ "steps.sentAt": range }).select("clientEmail steps.key steps.sentAt").lean(),
    mongoose.connection.db
      .collection("clientemaillogs")
      .find(
        { category: "milestone", type: { $not: /^test_/ }, createdAt: range },
        { projection: { clientEmail: 1, status: 1 } }
      )
      .toArray()
  ]);
  return { reminders, onboarding, milestones, useful: usefulDocs, since, until };
}

/** A legacy "partial" reminder row counts as sent when its email went out. */
function reminderOutcome(r) {
  if (r.status === "sent" || (r.status === "partial" && r.email?.ok === true)) return "sent";
  if (r.status === "failed" || r.status === "partial") return "failed";
  if (r.reason === "below_minimum") return "below5";
  if (r.reason === "nothing_added") return "noneAdded";
  return "otherSkip";
}

/** What happened to the client alert for one useful mail. */
function alertOutcome(d) {
  if (d.clientNotifiedAt) return "emailed";
  if (d.clientNotifyEligible !== true) return "notForClient";
  if (d.clientNotifySkippedReason) return "notSent";
  if (d.clientNotifyError) return "failed";
  return "waiting";
}

/**
 * Pure. Turns the raw rows into the numbers the card prints.
 */
export function summarizeClientMail({ reminders = [], onboarding = [], milestones = [], useful = [], since, until } = {}) {
  const emailed = new Set();
  const inWindow = (t) => t && new Date(t) >= since && new Date(t) < until;

  const daily = { sent: 0, below5: 0, noneAdded: 0, otherSkip: 0, failed: 0 };
  for (const r of reminders) {
    const o = reminderOutcome(r);
    daily[o] += 1;
    if (o === "sent") emailed.add(lc(r.clientEmail));
  }

  const onb = { emails: 0, clients: 0 };
  for (const doc of onboarding) {
    const n = (doc.steps || []).filter((s) => inWindow(s?.sentAt)).length;
    if (!n) continue;
    onb.emails += n;
    onb.clients += 1;
    emailed.add(lc(doc.clientEmail));
  }

  const ms = { sent: 0, failed: 0, clients: 0 };
  const msClients = new Set();
  for (const m of milestones) {
    if (m.status === "success") {
      ms.sent += 1;
      msClients.add(lc(m.clientEmail));
      emailed.add(lc(m.clientEmail));
    } else {
      ms.failed += 1;
    }
  }
  ms.clients = msClients.size;

  const alerts = { useful: useful.length, emailed: 0, waiting: 0, failed: 0, notSent: 0, notForClient: 0, clients: 0, reasons: {} };
  const alertClients = new Set();
  for (const d of useful) {
    const o = alertOutcome(d);
    alerts[o] += 1;
    if (o === "emailed") {
      const who = lc(d.ownerEmail) || lc(d.gmailEmail);
      alertClients.add(who);
      emailed.add(who);
    }
    if (o === "notSent") alerts.reasons[d.clientNotifySkippedReason] = (alerts.reasons[d.clientNotifySkippedReason] || 0) + 1;
  }
  alerts.clients = alertClients.size;
  emailed.delete("");

  // Did the window touch an IST Sunday? Then low numbers are expected.
  let sundayInWindow = false;
  for (let t = since.getTime(); t < until.getTime(); t += 3600 * 1000) {
    if (isClientMailOffDay(new Date(t))) { sundayInWindow = true; break; }
  }

  return { clientsEmailed: emailed.size, daily, onboarding: onb, milestones: ms, alerts, sundayInWindow };
}

const SKIP_LABEL = {
  inbox_alerts_off: "alerts off",
  no_payment_email: "no payment email",
  stale_digest: "too old",
  rollout_allowlist: "not in rollout",
  unverified_pre_verifier_digest: "unverified",
  smtp_not_configured: "mail not configured"
};

const joinParts = (parts) => parts.filter(Boolean).join(" · ") || "none";
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Pure. The Discord embed for a summary, or a short error card when the
 * numbers could not be read.
 */
export function buildClientMailEmbed(s, { error } = {}) {
  if (!s) {
    return {
      title: "📨 Client Emails Sent",
      color: 0xef4444,
      description: `Could not read the client email numbers: ${String(error || "unknown error").slice(0, 300)}`
    };
  }
  const a = s.alerts;
  const notSentWhy = Object.entries(a.reasons)
    .map(([k, n]) => `${n} ${SKIP_LABEL[k] || k.replace(/_/g, " ")}`)
    .join(", ");
  const alertLine =
    a.useful === 0
      ? "No useful mails in this window."
      : joinParts([
          `${a.emailed} of ${a.useful} emailed to ${plural(a.clients, "client")}`,
          a.waiting ? `${a.waiting} waiting to send` : "",
          a.failed ? `${a.failed} failed` : "",
          a.notSent ? `${a.notSent} not sent (${notSentWhy})` : "",
          a.notForClient ? `${a.notForClient} team only` : ""
        ]);
  const d = s.daily;
  const fields = [
    { name: "👥 Clients emailed", value: String(s.clientsEmailed), inline: true },
    { name: "⭐ Clients told about the useful mails", value: alertLine, inline: false },
    {
      name: "📊 Daily activity summary",
      value: joinParts([
        `${plural(d.sent, "client")} emailed`,
        d.below5 ? `${d.below5} below 5` : "",
        d.noneAdded ? `${d.noneAdded} no roles added` : "",
        d.otherSkip ? `${d.otherSkip} other skips` : "",
        d.failed ? `${d.failed} failed` : ""
      ]),
      inline: false
    },
    {
      name: "🧾 Onboarding",
      value: s.onboarding.emails ? `${plural(s.onboarding.emails, "email")} to ${plural(s.onboarding.clients, "client")}` : "none",
      inline: true
    },
    {
      name: "🏁 Plan milestones",
      value: s.milestones.sent || s.milestones.failed
        ? joinParts([`${plural(s.milestones.sent, "email")} to ${plural(s.milestones.clients, "client")}`, s.milestones.failed ? `${s.milestones.failed} failed` : ""])
        : "none",
      inline: true
    }
  ];
  if (s.sundayInWindow) {
    fields.push({ name: "Note", value: "This window includes a Sunday (IST), when no client email goes out.", inline: false });
  }
  const anyFailed = d.failed || s.milestones.failed || a.failed;
  return { title: "📨 Client Emails Sent", color: anyFailed ? 0xf59e0b : 0x6366f1, fields };
}
