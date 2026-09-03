#!/usr/bin/env node
// End-to-end proof for the Client Reminders chain, run against REAL data.
//
//   npm run verify:client-reminders
//       list every client that has a saved reminder config, with their enabled
//       items and last-sent status, then exit. Reads nothing else.
//
//   npm run verify:client-reminders -- --client=someone@gmail.com
//       READ-ONLY report for one client: resolved payment email + its source,
//       the stored config, the real activity window for the item, the live
//       stat block, the decideDelivery verdict and the subject line that WOULD
//       go out. Sends nothing, writes nothing.
//
//   ... -- --client=x@y.com --item=weekly_report   pick the catalogue item (default daily_summary)
//   ... -- --client=x@y.com --all                  verdict table for every catalogue item
//   ... -- --client=x@y.com --render               also dump the rendered email + Mattermost post to ./tmp-reminder-preview/
//   ... -- --client=x@y.com --now=2026-04-24T18:00:00+05:30
//                                                  evaluate as if it were this instant (window/due/period maths only)
//   ... -- --client=x@y.com --mattermost           REALLY post to the client's stored webhook
//   ... -- --client=x@y.com --email                REALLY send via SMTP to the resolved payment email
//   ... -- --client=x@y.com --email --force        push a send through even when the period was empty
//   ... -- --client=x@y.com --mattermost --yes     skip the 5-second confirmation pause
//
// Every layer this touches is the production one: Utils/clientActivityStats.js
// for the numbers, src/services/clientReminderWorker.js for the window, the
// due check, the empty-skip decision and the delivery itself, and
// Utils/reminderTemplates.js for the copy. Nothing is re-implemented here, so
// a green run means the cron would behave the same way.
//
// Why the send flags go through deliverReminder() rather than calling
// sendViaSmtp/sendToMattermost directly: that function is the single delivery
// implementation shared with the cron and the operator's "Send now" button. A
// script with its own send path would prove a code path nobody else runs.
//
// SIDE EFFECT WORTH KNOWING: a send WITHOUT --force consumes the item's period
// key, exactly as a cron delivery would, so the real scheduled send for that
// period will not fire again. --force records history but never burns the
// period or a one-shot milestone threshold. The confirmation banner says which
// of the two you are about to do.

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import mongoose from "mongoose";

import {
  REMINDER_ITEMS,
  REMINDER_ITEM_KEYS,
  reminderItemMeta,
  isReminderItemKey,
  QUIET_HOURS_IST
} from "../Utils/reminderItems.js";
import { ClientReminderConfig, mergeWithDefaults } from "../Schema_Models/ClientReminderConfig.js";
import { resolvePaymentEmail } from "../Schema_Models/ClientPaymentLookup.js";
import {
  getClientActivityStats,
  getClientLifetimeStats,
  daysSinceLastActivity,
  istParts
} from "../Utils/clientActivityStats.js";
import {
  periodKeyFor,
  reportWindowFor,
  isItemDue,
  decideDelivery,
  deliverReminder,
  isReminderWorkerEnabled,
  reminderWorkerEnabledReason
} from "../src/services/clientReminderWorker.js";
import { renderReminderEmail, renderReminderMattermost } from "../Utils/reminderTemplates.js";
import { normalizeWebhookUrl, isValidWebhookUrl } from "../Utils/mattermostSender.js";
import { isSmtpConfigured, smtpFromEmail } from "../Utils/smtpSender.js";

dotenv.config();

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (name) => {
  // Accepts both --k=v and --k v so the script behaves the same whether it is
  // invoked directly or through `npm run ... --`.
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const OPT = {
  client: String(valueOf("--client") || "").toLowerCase().trim(),
  item: String(valueOf("--item") || "daily_summary").trim(),
  now: valueOf("--now"),
  all: has("--all"),
  render: has("--render"),
  mattermost: has("--mattermost"),
  email: has("--email"),
  force: has("--force"),
  yes: has("--yes"),
  help: has("--help") || has("-h")
};

const SENDING = OPT.mattermost || OPT.email;

// Reasons decideDelivery() can return that --force is allowed to override.
// Mirrors FORCEABLE_REASONS in the worker; kept here only so the read-only
// report can tell an operator whether --force would change the outcome.
const FORCEABLE = new Set(["no_activity", "client_is_active", "no_milestone", "milestone_already_sent"]);

const PREVIEW_DIR = path.resolve(process.cwd(), "tmp-reminder-preview");

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const problems = [];
const notes = [];

const section = (n, title) => console.log(`\n[${n}] ${title}`);
const good = (line) => console.log(`  ✓ ${line}`);
const info = (line) => console.log(`  • ${line}`);
const warn = (line) => {
  notes.push(line);
  console.log(`  ! ${line}`);
};
const bad = (line) => {
  problems.push(line);
  console.log(`  ✗ ${line}`);
};

/** Fixed-width table. Rows are arrays of strings; the first row is the header. */
function table(rows, indent = "  ") {
  if (!rows.length) return;
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c] ?? "").length)));
  rows.forEach((row, i) => {
    const line = row.map((cell, c) => String(cell ?? "").padEnd(widths[c])).join("  ").trimEnd();
    console.log(indent + line);
    if (i === 0) console.log(indent + widths.map((w) => "-".repeat(w)).join("  "));
  });
}

const IST_STAMP = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});
const istStamp = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? `${IST_STAMP.format(d)} IST` : "-");

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Host + a short masked tail of the secret path segment. A Mattermost incoming
 * webhook URL IS the credential: anyone holding it can post into the channel,
 * so it must never reach a terminal, a CI log or a pasted bug report intact.
 */
function maskWebhook(url) {
  const raw = String(url || "").trim();
  if (!raw) return "(none)";
  try {
    const u = new URL(raw);
    const tail = u.pathname.replace(/\/+$/, "").split("/").pop() || "";
    const shown = tail.length > 4 ? tail.slice(-4) : "";
    return `${u.protocol}//${u.host}/…${shown ? `••••${shown}` : "••••"}`;
  } catch {
    return "(unparseable URL)";
  }
}

/** Cluster host only. The URI carries the database password. */
function maskMongoUri(uri) {
  const m = String(uri || "").match(/^mongodb(?:\+srv)?:\/\/(?:[^@]*@)?([^/?]+)/i);
  return m ? m[1] : "(unrecognised URI form)";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Loud banner before anything leaves this machine, naming the exact
 * destination, followed by a five-second window to Ctrl-C out of it. Skipped
 * with --yes so the script stays usable from a runbook.
 */
async function confirmBanner(lines) {
  const all = ["OUTBOUND SEND — this leaves the machine", ...lines];
  const inner = Math.max(58, ...all.map((l) => l.length));
  const bar = "!".repeat(inner + 6);
  console.log(`\n${bar}`);
  for (const l of all) console.log(`!! ${l.padEnd(inner)} !!`);
  console.log(bar);
  if (OPT.yes) {
    console.log("  (--yes given, not pausing)");
    return;
  }
  process.stdout.write("  Ctrl-C to abort — sending in ");
  for (let i = 5; i > 0; i -= 1) {
    process.stdout.write(`${i} `);
    await sleep(1000);
  }
  process.stdout.write("go\n");
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`
verify-client-reminders — end-to-end proof for the Client Reminders chain.

  node scripts/verify-client-reminders.mjs [options]
  npm run verify:client-reminders -- [options]

  (no options)          List every client with a saved reminder config, their
                        enabled items and last-sent status. Read-only.

  --client=<email>      Full read-only report for one client. Resolves the
                        payment email, prints the stored config, computes the
                        real activity window, prints the stat block, the
                        decideDelivery verdict and the subject that would go
                        out. Sends nothing.

  --item=<key>          Catalogue item to evaluate. Default: daily_summary.
                        One of: ${REMINDER_ITEM_KEYS.join(", ")}
  --all                 Verdict for every catalogue item instead of one.
  --now=<iso>           Evaluate as if it were this instant. Affects the window,
                        the due check and the period key only; the idle-days
                        lookup always measures from the real clock.
  --render              Also write the rendered email HTML and the Mattermost
                        markdown to ./tmp-reminder-preview/ and print the paths.

  --mattermost          REALLY post to the client's stored webhook.
                        Refuses when no webhook is stored.
  --email               REALLY send via SMTP to the resolved payment email.
                        Refuses when SMTP is unconfigured or no address resolves.
  --force               Bypass the empty-period skip for the send flags only.
                        Also stops the send from consuming the period key.
  --yes                 Skip the five-second confirmation pause.
  --help, -h            This text.

Exit code is 0 when the run completed and nothing hard-failed, 1 otherwise.
`);
}

// ---------------------------------------------------------------------------
// Listing mode
// ---------------------------------------------------------------------------

async function listConfigs() {
  section(2, "Saved reminder configs");

  const docs = await ClientReminderConfig.find({}).lean();
  if (!docs.length) {
    info("no client has a saved reminder config yet (the collection is empty)");
    info("nothing is scheduled — the tab writes a document on the first Save");
    return;
  }

  const rows = [["client", "enabled items", "last item", "last status", "last sent"]];
  for (const raw of docs.sort((a, b) => String(a.clientEmail).localeCompare(String(b.clientEmail)))) {
    const merged = mergeWithDefaults(raw);
    const enabled = merged.items.filter((i) => i.enabled && (i.channels.mattermost || i.channels.email));
    // The most recent delivery across all items is what an operator scans for,
    // so surface that rather than one arbitrary item's bookkeeping.
    const latest = merged.items
      .filter((i) => i.lastSentAt || i.lastStatus)
      .sort((a, b) => new Date(b.lastSentAt || 0) - new Date(a.lastSentAt || 0))[0];
    rows.push([
      merged.clientEmail,
      enabled.length ? enabled.map((i) => i.key).join(",") : "(none)",
      latest?.key || "-",
      latest?.lastStatus || "-",
      latest?.lastSentAt ? istStamp(new Date(latest.lastSentAt)) : "-"
    ]);
  }
  table(rows);
  info(`${docs.length} config${docs.length === 1 ? "" : "s"} on file`);
}

// ---------------------------------------------------------------------------
// Per-client report
// ---------------------------------------------------------------------------

/** Everything the report and the send paths need, gathered once. */
async function loadClient(clientEmail) {
  const stored = await ClientReminderConfig.findOne({ clientEmail }).lean();
  const pay = await resolvePaymentEmail(clientEmail).catch(() => ({
    paymentEmail: "",
    matched: false,
    clientName: ""
  }));

  // mergeWithDefaults on a null document is exactly what the GET route returns
  // for an unsaved client, so the report describes what WOULD run rather than
  // an empty shell.
  const config = mergeWithDefaults(stored || { clientEmail, clientName: pay.clientName || "" });
  if (!config.clientEmail) config.clientEmail = clientEmail;
  if (!config.clientName) config.clientName = pay.clientName || "";

  const override = String(config.paymentEmailOverride || "");
  const destination = EMAIL_RE.test(override)
    ? { to: override, source: "override" }
    : EMAIL_RE.test(pay.paymentEmail || "")
      ? { to: pay.paymentEmail, source: "tracking" }
      : { to: "", source: "none" };

  return { stored, pay, config, destination, saved: Boolean(stored) };
}

function printConfigTable(config) {
  const rows = [["item", "on", "channels", "schedule", "last status", "last period", "last sent"]];
  for (const meta of REMINDER_ITEMS) {
    const item = config.items.find((i) => i.key === meta.key);
    if (!item) continue;
    const channels =
      [item.channels.email ? "email" : "", item.channels.mattermost ? "mattermost" : ""]
        .filter(Boolean)
        .join("+") || "(none)";
    let schedule;
    if (meta.cadence === "daily" && meta.key === "inactivity_alert") {
      schedule = `daily ${item.sendAtIST} after ${item.inactivityDays}d idle`;
    } else if (meta.cadence === "daily") {
      schedule = `daily ${item.sendAtIST}`;
    } else if (meta.cadence === "weekly") {
      schedule = `${WEEKDAYS[item.dayOfWeek] || "?"} ${item.sendAtIST}`;
    } else if (meta.cadence === "monthly") {
      schedule = `day ${item.dayOfMonth} ${item.sendAtIST}`;
    } else {
      schedule = `event (${QUIET_HOURS_IST.startHour}:00-${QUIET_HOURS_IST.endHour}:00 IST)`;
    }
    rows.push([
      meta.key,
      item.enabled ? "yes" : "no",
      channels,
      schedule,
      item.lastStatus || "-",
      item.lastPeriodKey || "-",
      item.lastSentAt ? istStamp(new Date(item.lastSentAt)) : "-"
    ]);
  }
  table(rows);
}

/**
 * Run the real window + stats + decision chain for one item and print it.
 * Returns everything the render and send steps need, so they never recompute
 * (and so they can never disagree with what was just printed).
 */
async function evaluateItem({ config, itemKey, now, verbose }) {
  const meta = reminderItemMeta(itemKey);
  const item = config.items.find((i) => i.key === itemKey);
  const window = reportWindowFor(itemKey, now);

  const stats = await getClientActivityStats(config.clientEmail, { from: window.from, to: window.to });
  const lifetime = await getClientLifetimeStats(config.clientEmail);
  const daysIdle =
    itemKey === "inactivity_alert"
      ? await daysSinceLastActivity(config.clientEmail, Math.max(1, Number(item?.inactivityDays) || 3) + 1)
      : 0;

  const decision = decideDelivery({
    meta,
    item,
    stats,
    lifetime,
    inactivityDays: item?.inactivityDays,
    daysIdle
  });
  const extra = decision.extra || {};
  const due = isItemDue(item, meta, now);
  const periodKey =
    itemKey === "milestone" && extra.threshold ? `milestone:${extra.threshold}` : periodKeyFor(itemKey, now);

  const client = { name: config.clientName || "", email: config.clientEmail };
  const period = { label: window.label, from: window.from, to: window.to };
  const rendered = renderReminderEmail({ kind: itemKey, client, stats, lifetime, period, extra });
  const mmRendered = renderReminderMattermost({ kind: itemKey, client, stats, lifetime, period, extra });

  if (verbose) {
    info(`item:        ${meta.key} — ${meta.label}`);
    info(`cadence:     ${meta.cadence}${meta.activityGated ? " (activity-gated: an empty period is never sent)" : ""}`);
    info(`window:      ${window.label}`);
    info(`             ${istStamp(window.from)}  →  ${istStamp(window.to)}`);
    console.log("");
    table(
      [
        ["added", "applied", "interview", "offer", "rejected", "removed", "isEmpty"],
        [
          String(stats.addedCount),
          String(stats.appliedCount),
          String(stats.interviewCount),
          String(stats.offerCount),
          String(stats.rejectedCount),
          String(stats.removedCount),
          String(stats.isEmpty)
        ]
      ],
      "    "
    );
    console.log("");
    if (stats.topCompanies?.length) {
      info(`top companies: ${stats.topCompanies.map((c) => `${c.name} (${c.count})`).join(", ")}`);
    }
    if (stats.appliedJobs?.length) {
      info("applied sample:");
      for (const j of stats.appliedJobs.slice(0, 5)) {
        console.log(`      - ${j.jobTitle || "(no title)"} @ ${j.companyName || "(no company)"}`);
      }
    }
    info(
      `lifetime:    totalJobs=${lifetime.totalJobs} applied=${lifetime.totalApplied} ` +
        `interviews=${lifetime.totalInterviews} offers=${lifetime.totalOffers}`
    );
    info(
      `plan:        ${lifetime.planType || "(unknown)"} cap=${lifetime.effectiveCap ?? "n/a"} ` +
        `remaining=${lifetime.remaining ?? "n/a"} used=${lifetime.percentUsed ?? "n/a"}%`
    );
    if (itemKey === "inactivity_alert") {
      info(`idle days:   ${daysIdle} (threshold ${item?.inactivityDays}) — measured from the real clock, not --now`);
    }
  }

  return { meta, item, window, stats, lifetime, daysIdle, decision, extra, due, periodKey, rendered, mmRendered, client, period };
}

function printVerdict(ev, { destination, webhook }) {
  const { meta, item, decision, due, periodKey, rendered } = ev;

  const enabledChannels =
    [item.channels.email ? "email" : "", item.channels.mattermost ? "mattermost" : ""].filter(Boolean).join("+") ||
    "(none)";

  info(`enabled:     ${item.enabled ? "yes" : "no"}   channels: ${enabledChannels}`);
  info(`due now:     ${due ? "YES" : "no"}${due ? "" : `   (${dueExplanation(ev)})`}`);
  info(`period key:  ${periodKey || "(event — no calendar period)"}`);

  if (decision.shouldSend) {
    good(`decision:    SEND — ${decision.reason}`);
  } else if (OPT.force && FORCEABLE.has(decision.reason)) {
    warn(`decision:    SKIP — ${decision.reason}   (--force WOULD push this through)`);
  } else {
    info(`decision:    SKIP — ${decision.reason}${FORCEABLE.has(decision.reason) ? "   (--force could override)" : "   (not forceable)"}`);
  }

  if (item.channels.email) {
    if (!destination.to) info("email dest:  (none) — no paymentEmail on the tracking doc and no override");
    else info(`email dest:  ${destination.to}   (source: ${destination.source})`);
    if (!isSmtpConfigured()) info("email would be skipped: SMTP is not configured in this environment");
  }
  if (item.channels.mattermost) {
    info(`mattermost:  ${webhook ? maskWebhook(webhook) : "(none stored) — this channel cannot deliver"}`);
  }

  info(`subject:     ${rendered ? `"${rendered.subject}"` : "(template returned null)"}`);
  if (meta.cadence !== "event" && !decision.shouldSend && decision.reason === "no_activity") {
    info("            (nothing would actually be sent — the hard rule: silence beats an empty digest)");
  }
}

/** Why isItemDue said no, in words an operator can act on. */
function dueExplanation(ev) {
  const { meta, item, periodKey } = ev;
  const parts = istParts(new Date(NOW));
  if (meta.cadence === "event") {
    return `outside quiet-hours window ${QUIET_HOURS_IST.startHour}:00-${QUIET_HOURS_IST.endHour}:00 IST`;
  }
  if (meta.cadence === "weekly" && parts.weekday !== item.dayOfWeek) {
    return `scheduled for ${WEEKDAYS[item.dayOfWeek] || "?"}, today is ${WEEKDAYS[parts.weekday]}`;
  }
  if (meta.cadence === "monthly" && parts.day !== item.dayOfMonth) {
    return `scheduled for day ${item.dayOfMonth}, today is day ${parts.day}`;
  }
  const clock = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  if (clock < String(item.sendAtIST)) return `before sendAt ${item.sendAtIST} IST (now ${clock})`;
  if (periodKey && periodKey === item.lastPeriodKey) return `period ${periodKey} already decided`;
  return "schedule conditions not met";
}

// ---------------------------------------------------------------------------
// Render to disk
// ---------------------------------------------------------------------------

function writePreviews(clientEmail, itemKey, ev) {
  const slug = `${clientEmail.replace(/[^a-z0-9]+/gi, "-")}.${itemKey}`;
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });

  const written = [];
  if (ev.rendered) {
    const htmlPath = path.join(PREVIEW_DIR, `${slug}.html`);
    fs.writeFileSync(htmlPath, ev.rendered.html, "utf8");
    written.push(htmlPath);

    const textPath = path.join(PREVIEW_DIR, `${slug}.txt`);
    fs.writeFileSync(textPath, `Subject: ${ev.rendered.subject}\n\n${ev.rendered.text}`, "utf8");
    written.push(textPath);
  }
  if (ev.mmRendered?.text) {
    const mdPath = path.join(PREVIEW_DIR, `${slug}.mattermost.md`);
    fs.writeFileSync(mdPath, ev.mmRendered.text, "utf8");
    written.push(mdPath);
  }
  return written;
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

async function doSend({ config, itemKey, destination, webhook, now }) {
  const item = config.items.find((i) => i.key === itemKey);

  // Refuse before the banner, not after: an operator should never see a
  // countdown for a send that was never going to happen.
  if (OPT.mattermost && !isValidWebhookUrl(webhook)) {
    bad(
      webhook
        ? `--mattermost refused: the stored webhook is not a valid https URL (${maskWebhook(webhook)})`
        : "--mattermost refused: no Mattermost webhook is stored for this client"
    );
    return null;
  }
  if (OPT.email && !isSmtpConfigured()) {
    bad("--email refused: SMTP is not configured in this environment (SMTP_USER / SMTP_PASS unset)");
    return null;
  }
  if (OPT.email && !destination.to) {
    bad("--email refused: no payment email resolves for this client (no tracking paymentEmail, no override)");
    return null;
  }

  const lines = [];
  lines.push(`client:   ${config.clientEmail}`);
  lines.push(`item:     ${itemKey}`);
  if (OPT.email) lines.push(`EMAIL ->  ${destination.to}   (via SMTP as ${smtpFromEmail() || "(unknown sender)"})`);
  if (OPT.mattermost) lines.push(`POST  ->  ${maskWebhook(webhook)}`);
  lines.push(
    OPT.force
      ? "force:    ON — empty-period skip bypassed, period key NOT consumed"
      : "force:    off — a successful send CONSUMES this period's key"
  );
  await confirmBanner(lines);

  // channelsOverride keeps the send to exactly the flags given, regardless of
  // what the saved config has switched on, and is never written back.
  const result = await deliverReminder({
    config,
    itemKey,
    trigger: "verify-script",
    force: OPT.force,
    channelsOverride: { mattermost: OPT.mattermost, email: OPT.email },
    now
  });

  console.log("");
  info(`status:      ${result.status}   reason: ${result.reason || "-"}`);
  info(`period key:  ${result.periodKey || "(event)"}`);
  info(`stats:       added=${result.stats.added} applied=${result.stats.applied}`);
  if (OPT.email) {
    const e = result.email;
    const line = `email:       attempted=${e.attempted} ok=${e.ok} to=${e.to || "-"}${e.error ? ` error=${e.error}` : ""}`;
    e.ok ? good(line) : bad(line);
  }
  if (OPT.mattermost) {
    const m = result.mattermost;
    const line = `mattermost:  attempted=${m.attempted} ok=${m.ok}${m.error ? ` error=${m.error}` : ""}`;
    m.ok ? good(line) : bad(line);
  }
  if (result.status === "skipped") {
    warn(`nothing was sent — ${result.reason}${FORCEABLE.has(result.reason) ? " (re-run with --force to override)" : ""}`);
  }
  if (!item?.enabled) {
    info("note: this item is switched OFF in the saved config — the cron would not have sent it");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let NOW = new Date();

async function main() {
  if (OPT.help) {
    printUsage();
    return 0;
  }

  console.log("verify-client-reminders — Client Reminders end-to-end check");

  // ── 1. Environment ──
  section(1, "Environment");

  if (OPT.now !== undefined) {
    const parsed = new Date(OPT.now);
    if (Number.isNaN(parsed.getTime())) {
      bad(`--now is not a parseable date: ${OPT.now}`);
      return 1;
    }
    NOW = parsed;
    warn(`evaluating as if it were ${istStamp(NOW)} (--now override; idle-days still uses the real clock)`);
  }

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    bad("MONGODB_URI is not set — nothing can be verified against real data");
    return 1;
  }
  good(`MONGODB_URI present (${maskMongoUri(uri)})`);

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  } catch (err) {
    bad(`mongo connect failed: ${err?.message || err}`);
    return 1;
  }
  good(`mongo connected (db: ${mongoose.connection.name})`);

  if (isSmtpConfigured()) good(`SMTP configured (sends as ${smtpFromEmail()})`);
  else warn("SMTP not configured here (SMTP_USER / SMTP_PASS unset) — the email channel cannot deliver from this shell");

  info(`worker cron: ${isReminderWorkerEnabled() ? "ENABLED" : "disabled"} — ${reminderWorkerEnabledReason()}`);
  const p = istParts(NOW);
  info(`clock:       ${istStamp(NOW)}  (${WEEKDAYS[p.weekday]}, day ${p.day})`);

  // ── Listing mode ──
  if (!OPT.client) {
    await listConfigs();
    info("pass --client=<email> for the full per-client report");
    return problems.length ? 1 : 0;
  }

  if (!EMAIL_RE.test(OPT.client)) {
    bad(`--client is not a valid email address: ${OPT.client}`);
    return 1;
  }
  const itemKeys = OPT.all ? [...REMINDER_ITEM_KEYS] : [OPT.item];
  for (const k of itemKeys) {
    if (!isReminderItemKey(k)) {
      bad(`unknown --item '${k}'. Valid keys: ${REMINDER_ITEM_KEYS.join(", ")}`);
      return 1;
    }
  }
  if (SENDING && OPT.all) {
    bad("--all is a read-only survey; refusing to fan a real send out across every catalogue item");
    return 1;
  }

  // ── 2. Client ──
  section(2, "Client");
  const { pay, config, destination, saved } = await loadClient(OPT.client);

  if (pay.matched) good(`tracking doc matched: ${config.clientName || "(no name)"} <${OPT.client}>`);
  else warn(`no dashboardtrackings row matches ${OPT.client} — payment email can only come from an override`);

  if (destination.to) good(`payment email: ${destination.to}  (source: ${destination.source})`);
  else warn("payment email: none resolves — every email-channel reminder would skip");

  if (saved) good("reminder config: saved document found");
  else info("reminder config: none saved — showing catalogue defaults (this is what the tab would open with)");

  const webhook = normalizeWebhookUrl(config.mattermostWebhookUrl);
  if (!webhook) info("mattermost webhook: (none stored)");
  else if (isValidWebhookUrl(webhook)) good(`mattermost webhook: ${maskWebhook(webhook)}`);
  else bad(`mattermost webhook stored but unusable (must be https): ${maskWebhook(webhook)}`);

  // ── 3. Config ──
  section(3, "Reminder config");
  printConfigTable(config);

  // ── 4/5. Per-item evaluation ──
  if (OPT.all) {
    section(4, "Verdict for every catalogue item");
    const rows = [["item", "on", "window", "added", "applied", "due", "decision", "subject"]];
    const previewFiles = [];
    for (const key of itemKeys) {
      const ev = await evaluateItem({ config, itemKey: key, now: NOW, verbose: false });
      rows.push([
        key,
        ev.item.enabled ? "yes" : "no",
        ev.window.label,
        String(ev.stats.addedCount),
        String(ev.stats.appliedCount),
        ev.due ? "yes" : "no",
        ev.decision.shouldSend ? "SEND" : `skip:${ev.decision.reason}`,
        ev.rendered ? ev.rendered.subject.slice(0, 60) : "(none)"
      ]);
      if (OPT.render) {
        try {
          previewFiles.push(...writePreviews(config.clientEmail, key, ev));
        } catch (err) {
          bad(`could not write previews for '${key}': ${err?.message || err}`);
        }
      }
    }
    table(rows);
    if (OPT.render) {
      section(5, "Rendered previews");
      if (!previewFiles.length) warn("nothing written — every template returned null");
      for (const f of previewFiles) good(f);
    }
    return problems.length ? 1 : 0;
  }

  const itemKey = itemKeys[0];
  section(4, `Activity — ${reminderItemMeta(itemKey).label}`);
  const ev = await evaluateItem({ config, itemKey, now: NOW, verbose: true });

  section(5, "Verdict");
  printVerdict(ev, { destination, webhook });

  let n = 6;
  if (OPT.render) {
    section(n++, "Rendered previews");
    try {
      const files = writePreviews(config.clientEmail, itemKey, ev);
      if (!files.length) warn("nothing to render — both templates returned null for this item");
      for (const f of files) good(f);
    } catch (err) {
      bad(`could not write previews: ${err?.message || err}`);
    }
  }

  if (SENDING) {
    section(n++, "Outbound send");
    await doSend({ config, itemKey, destination, webhook, now: NOW });
  } else {
    section(n++, "Read-only");
    info("no --email / --mattermost flag given: nothing was sent and nothing was written to Mongo");
  }

  return problems.length ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  // A crash here is itself the finding, so print it whole rather than a
  // one-line message that hides which layer blew up.
  console.error(`\n  ✗ unhandled failure: ${err?.stack || err}`);
  problems.push(`unhandled failure: ${err?.message || err}`);
  code = 1;
}

try {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
} catch {}

const summary = problems.length
  ? `FAILED — ${problems.length} problem${problems.length === 1 ? "" : "s"}: ${problems[0]}`
  : SENDING
    ? "OK — outbound run completed, see the status lines above"
    : "OK — read-only check completed, nothing was sent";
console.log(`\n${summary}\n`);
process.exit(code);
