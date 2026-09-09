// clientReminderWorker - delivers the operator-configured "Client Reminders"
// to a client's payment email and/or their Mattermost channel.
//
// One ClientReminderConfig document per client (Schema_Models/ClientReminderConfig.js),
// one row per catalogue item (Utils/reminderItems.js). Every five minutes this
// worker walks the configs that have at least one enabled item with at least
// one enabled channel, asks the pure scheduling functions below whether each
// row is due, and hands the due ones to deliverReminder().
//
// THE PRODUCT RULE that shapes everything here: an activity-gated report with
// nothing to report is NOT sent. Zero jobs added and zero applications means
// the client hears nothing. Silence beats an empty digest, and decideDelivery()
// is the single place that decision lives.
//
// Design notes worth reading before changing anything:
//
//   • periodKeyFor / reportWindowFor / isItemDue / decideDelivery are PURE.
//     No Mongo, no process.env, no ambient clock - `now` is always an argument.
//     The whole test suite leans on that, and so does the preview route, which
//     needs to show an operator exactly what a given item would render without
//     touching delivery state.
//
//   • Idempotency is by PERIOD KEY, never by timestamp. An item sends when its
//     computed period key differs from the stored lastPeriodKey. See the long
//     comment on persistOutcome() for why a SKIP writes the key too.
//
//   • MISSED WINDOWS DIE QUIETLY. If the process was down over a scheduled
//     time and the period has since rolled over, that period is simply never
//     delivered - the new period computes a different key and the old one is
//     forgotten. This is deliberate. Do not "fix" it into a catch-up queue:
//     coming back from a two-day outage would fire two days of digests at once,
//     and a stale Monday report landing on Wednesday is worse than no report.
//
//   • Nothing in this file throws to its caller. Not the tick, not a delivery,
//     not a persistence failure. A notification path that can crash the process
//     it runs inside is a notification path that gets deleted.

import cron from "node-cron";

import {
  REMINDER_ITEMS,
  REMINDER_ITEM_KEYS,
  QUIET_HOURS_IST,
  reminderItemMeta,
  parseSendAt,
  defaultItemConfig
} from "../../Utils/reminderItems.js";
import {
  ClientReminderConfig,
  mergeWithDefaults,
  HISTORY_LIMIT,
  getCurrentISTTime
} from "../../Schema_Models/ClientReminderConfig.js";
import {
  istParts,
  istDayKey,
  istWeekKey,
  istMonthKey,
  startOfCalendarDayIST,
  endOfCalendarDayIST,
  getClientActivityStats,
  getClientLifetimeStats,
  daysSinceLastActivity,
  nthRoleAddedTodayIST
} from "../../Utils/clientActivityStats.js";
import { renderReminderEmail, renderReminderMattermost } from "../../Utils/reminderTemplates.js";
import { sendViaSmtp, isSmtpConfigured } from "../../Utils/smtpSender.js";
import { sendToMattermost, isValidWebhookUrl, normalizeWebhookUrl } from "../../Utils/mattermostSender.js";
import { resolvePaymentEmail } from "../../Schema_Models/ClientPaymentLookup.js";
import { unsubscribeHeaders, UNSUB_STREAMS } from "../../Utils/unsubscribe.js";

const LOG = "[client-reminders]";

const CRON_EXPR = "*/5 * * * *";

// Ceiling on deliveries attempted in one tick. Bounds the burst when a large
// client base all shares a 21:30 send time, and keeps us clear of the Gmail
// App-Password daily cap. Anything left over is picked up five minutes later,
// still inside its period, so nothing is lost.
const MAX_SENDS_PER_TICK = 50;

const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Reasons that a forced send-now is allowed to override. Force exists so an
// operator can prove a template and a channel work on a quiet day; it must
// never conjure a destination out of nothing, so 'no_channel' and
// 'unknown_item' are absent from this set on purpose.
// Exported so the policy is testable on its own. "Which skip reasons can an
// operator override?" is a product decision, and a decision that only exists
// inside a delivery function that needs Mongo to reach it is a decision nobody
// can regression-test.
export const FORCEABLE_REASONS = new Set([
  "no_activity",
  "client_is_active",
]);

// Enable only on the real Render deploy (or when forced). A developer laptop
// pointed at the production database must not email or ping real clients, and
// "I forgot the worker was running locally" is not a mistake you get to make
// twice with client-facing mail.
const _rawEnabled = process.env.CLIENT_REMINDERS_ENABLED;
const ENABLED = _rawEnabled === "1" ? true : _rawEnabled === "0" ? false : Boolean(process.env.RENDER);
const ENABLED_REASON =
  _rawEnabled === "1"
    ? "forced on (CLIENT_REMINDERS_ENABLED=1)"
    : _rawEnabled === "0"
      ? "forced off (CLIENT_REMINDERS_ENABLED=0)"
      : Boolean(process.env.RENDER)
        ? "auto-on (Render)"
        : "off (not Render, CLIENT_REMINDERS_ENABLED unset)";

let running = false;
let task = null;

/** Whether the cron would run in this process. Exported for the ops GET route. */
export function isReminderWorkerEnabled() {
  return ENABLED;
}

export function reminderWorkerEnabledReason() {
  return ENABLED_REASON;
}

// ---------------------------------------------------------------------------
// Pure scheduling helpers
// ---------------------------------------------------------------------------

const IST_DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  weekday: "long",
  day: "numeric",
  month: "short",
  year: "numeric"
});
const IST_DATE_SHORT_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short"
});
const IST_YEAR_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric" });
const IST_MONTH_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  month: "long",
  year: "numeric"
});

function fmtIstDay(date) {
  // "Saturday, 22 Aug 2026" - en-GB emits "Saturday, 22 Aug 2026" already.
  return IST_DATE_FMT.format(date);
}

function fmtIstRange(from, to) {
  const fy = IST_YEAR_FMT.format(from);
  const ty = IST_YEAR_FMT.format(to);
  return fy === ty
    ? `${IST_DATE_SHORT_FMT.format(from)} - ${IST_DATE_SHORT_FMT.format(to)} ${ty}`
    : `${IST_DATE_SHORT_FMT.format(from)} ${fy} - ${IST_DATE_SHORT_FMT.format(to)} ${ty}`;
}

/** IST calendar day `n` days before the IST day containing `date`. */
function istDayShift(date, n) {
  // Anchor on IST midnight before shifting: adding whole days to an arbitrary
  // instant can land either side of a boundary, adding them to a midnight
  // cannot (India has no DST, so every IST day is exactly 24h long).
  return new Date(startOfCalendarDayIST(date).getTime() - n * DAY_MS);
}

/**
 * The once-per-period idempotency token for an item.
 *
 * Format is "<itemKey>:<period>" so two items sharing a cadence never collide
 * and so a stored value is self-describing when an operator reads the raw doc.
 *
 *   daily   → "daily_summary:2026-08-22"
 *   monthly → "monthly_report:2026-08"
 *   event   → ""                            (no catalogue item uses this today)
 *
 * PURE. Depends on nothing but its arguments.
 *
 * @param {string} itemKey
 * @param {Date} now
 * @returns {string}
 */
export function periodKeyFor(itemKey, now = new Date()) {
  const meta = reminderItemMeta(itemKey);
  if (!meta) return "";
  switch (meta.cadence) {
    case "daily":
      return `${meta.key}:${istDayKey(now)}`;
    case "weekly":
      return `${meta.key}:${istWeekKey(now)}`;
    case "monthly":
      return `${meta.key}:${istMonthKey(now)}`;
    case "event":
    default:
      // Event items are not period-bounded: their idempotency token is derived
      // from the event itself, not from the calendar. No catalogue item uses
      // this cadence today.
      return "";
  }
}

/**
 * The reporting window an item covers, as UTC instants bounding IST calendar
 * days, plus a human label that goes verbatim into the email and the
 * Mattermost post.
 *
 * The label matters more than it looks: "your daily summary" is ambiguous the
 * moment a send slips past midnight, so every reminder states the exact dates
 * it is describing.
 *
 * PURE. Depends on nothing but its arguments.
 *
 * @param {string} itemKey
 * @param {Date} now
 * @returns {{from: Date, to: Date, label: string}}
 */
export function reportWindowFor(itemKey, now = new Date()) {
  const meta = reminderItemMeta(itemKey);
  const key = meta?.key || "";

  if (key === "daily_summary") {
    // A summary scheduled for the evening reports the day it is sent. One
    // scheduled for the morning is a wrap-up of YESTERDAY - nobody wants a
    // 09:00 digest of the four hours since midnight. Noon is the pivot, taken
    // from `now` because isItemDue only lets us run at or after sendAtIST, so
    // the hour we are running at IS the scheduled hour for all practical
    // purposes (and for a manual send-now, "the day you clicked it" is right).
    const anchor = istParts(now).hour >= 12 ? now : istDayShift(now, 1);
    const from = startOfCalendarDayIST(anchor);
    const to = endOfCalendarDayIST(anchor);
    return { from, to, label: fmtIstDay(from) };
  }

  if (key === "monthly_report") {
    // The PREVIOUS IST calendar month in full. Built from the first IST day of
    // the current month minus one day, so month lengths and year rollover fall
    // out for free.
    const { year, month } = istParts(now);
    // Noon UTC on the 1st is 17:30 IST the same day, so this instant is
    // unambiguously "the 1st, in IST" without hand-rolling the offset.
    const firstOfThisMonth = startOfCalendarDayIST(new Date(Date.UTC(year, month - 1, 1, 12, 0, 0, 0)));
    const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - DAY_MS);
    const p = istParts(lastOfPrevMonth);
    const from = startOfCalendarDayIST(new Date(Date.UTC(p.year, p.month - 1, 1, 12, 0, 0, 0)));
    const to = endOfCalendarDayIST(lastOfPrevMonth);
    return { from, to, label: IST_MONTH_FMT.format(lastOfPrevMonth) };
  }

  if (key === "inactivity_alert") {
    // Not a report window - this item is driven by daysSinceLastActivity. The
    // range exists only so the alert can quote real "0 added / 0 applied"
    // figures for recent history instead of an empty placeholder. A fixed
    // seven days keeps it to one cheap indexed read regardless of the
    // configured inactivityDays.
    const from = startOfCalendarDayIST(istDayShift(now, 6));
    const to = endOfCalendarDayIST(now);
    return { from, to, label: `Last 7 days to ${fmtIstDay(to)}` };
  }

  // Anything unrecognised. The window is pinned to today rather than to the
  // epoch on purpose: a literal lifetime range would make
  // getClientActivityStats scan every card the client has ever had.
  const from = startOfCalendarDayIST(now);
  const to = endOfCalendarDayIST(now);
  return { from, to, label: "Lifetime to date" };
}

/** Minutes past IST midnight for `date`. */
function istMinuteOfDay(date) {
  const { hour, minute } = istParts(date);
  return hour * 60 + minute;
}

/**
 * Is this item due right now?
 *
 * Three conditions, all of which must hold:
 *   1. the cadence's calendar condition (weekday / day-of-month / any day)
 *   2. IST clock is at or past sendAtIST
 *   3. the period key for `now` is not the one we already delivered
 *
 * Event-cadence items have no calendar and no period key; they are "due"
 * whenever we are inside quiet hours, and the real gate is decideDelivery().
 *
 * Deliberately does NOT check item.enabled. Enablement is a config question
 * answered by the tick's Mongo query and by the send-now route; keeping it out
 * of here means the preview and test paths can ask "would this be due?" about
 * a row an operator has switched off.
 *
 * PURE. Depends on nothing but its arguments.
 *
 * @param {object} item  a merged config row
 * @param {object} meta  the catalogue entry for that row
 * @param {Date} now
 * @returns {boolean}
 */
export function isItemDue(item, meta, now = new Date()) {
  if (!item || !meta) return false;

  const parts = istParts(now);

  if (meta.cadence === "event") {
    // Never ping a client at 03:00 because a counter happened to tick over.
    return parts.hour >= QUIET_HOURS_IST.startHour && parts.hour < QUIET_HOURS_IST.endHour;
  }

  if (meta.cadence === "weekly") {
    const want = Number.isInteger(item.dayOfWeek) ? item.dayOfWeek : 1;
    if (parts.weekday !== want) return false;
  } else if (meta.cadence === "monthly") {
    const want = Number.isInteger(item.dayOfMonth) ? item.dayOfMonth : 1;
    if (parts.day !== want) return false;
  }

  // A malformed sendAtIST would otherwise make the item fire at midnight or
  // never at all. sanitizeItemsInput should have prevented it; fail closed on
  // the "never" side rather than surprising a client at 00:05.
  const at = parseSendAt(item.sendAtIST);
  if (!at) return false;
  if (istMinuteOfDay(now) < at.hour * 60 + at.minute) return false;

  const key = periodKeyFor(meta.key, now);
  if (!key) return false;
  return key !== String(item.lastPeriodKey || "");
}

/**
 * The threshold auto-send: "once N roles are added, mail an hour later".
 *
 * An ALTERNATIVE way for a daily item to become due, never a replacement. The
 * period key is still the plain daily one, so whichever trigger fires first
 * consumes the day and the other becomes a no-op. That is what stops a client
 * getting the summary twice - once at 15:40 because five roles landed, and
 * again at 21:30 because the clock came round.
 *
 * The delay is measured from the Nth add, not the newest one. Measuring from
 * the newest would let a trickle of roles reset the timer all afternoon and the
 * mail would never go out.
 *
 * PURE. Depends on nothing but its arguments.
 *
 * @param {object} a
 * @param {object} a.item      merged config row
 * @param {object} a.meta      catalogue entry
 * @param {number} a.addedCount roles added today, removals already excluded
 * @param {Date|null} a.nthAt  when the Nth role was added
 * @param {Date} [a.now]
 * @returns {boolean}
 */
export function isThresholdAutoDue({ item, meta, addedCount, nthAt, now = new Date() }) {
  if (!item || !meta) return false;
  if (meta.cadence !== "daily") return false;
  if (item.autoOnThreshold !== true) return false;

  const need = Number.isInteger(item.autoThresholdCount) && item.autoThresholdCount > 0
    ? item.autoThresholdCount
    : 5;
  if (!Number.isFinite(addedCount) || addedCount < need) return false;
  if (!(nthAt instanceof Date) || Number.isNaN(nthAt.getTime())) return false;

  const delayMin = Number.isInteger(item.autoDelayMinutes) && item.autoDelayMinutes >= 0
    ? item.autoDelayMinutes
    : 60;
  if (now.getTime() < nthAt.getTime() + delayMin * 60 * 1000) return false;

  // Same once-per-period guard the scheduled path uses.
  const key = periodKeyFor(meta.key, now);
  if (!key) return false;
  return key !== String(item.lastPeriodKey || "");
}

function hasEnabledChannel(channels) {
  return channels?.mattermost === true || channels?.email === true;
}

/**
 * Should this item actually go out, given what the data says?
 *
 * THE EMPTY-SKIP RULE LIVES HERE and nowhere else. Every caller - the cron,
 * the send-now button, the preview route - asks this one function, so there is
 * exactly one definition of "there was nothing to report".
 *
 * `extra` is returned even when shouldSend is false wherever it is computable,
 * so a forced send-now can still render a coherent message instead of falling
 * back to placeholder numbers.
 *
 * PURE. Depends on nothing but its arguments.
 *
 * @param {object} a
 * @param {object} a.meta            catalogue entry
 * @param {object} a.item            merged config row
 * @param {object} a.stats           getClientActivityStats() shape
 * @param {object} a.lifetime        getClientLifetimeStats() shape
 * @param {number} a.inactivityDays  configured threshold for inactivity_alert
 * @param {number} a.daysIdle        measured idle days
 * @returns {{shouldSend: boolean, reason: string, extra?: object}}
 */
export function decideDelivery({ meta, item, stats, lifetime, inactivityDays, daysIdle } = {}) {
  if (!meta || !item) return { shouldSend: false, reason: "unknown_item" };

  // Checked first and never forceable: with no channel there is no delivery to
  // make, only a history row claiming one happened.
  if (!hasEnabledChannel(item.channels)) return { shouldSend: false, reason: "no_channel" };

  const lt = lifetime || {};
  const st = stats || {};

  if (meta.key === "inactivity_alert") {
    // INVERTED against every other item: this one fires precisely BECAUSE
    // there was no activity. Do not let the generic empty-skip rule near it.
    const threshold = Number.isFinite(Number(inactivityDays))
      ? Math.max(1, Math.floor(Number(inactivityDays)))
      : Number(item.inactivityDays) || 3;
    const idle = Number(daysIdle) || 0;
    const extra = { days: idle };
    if (idle < threshold) return { shouldSend: false, reason: "client_is_active", extra };
    return { shouldSend: true, reason: "ok", extra };
  }

  if (meta.key === "plan_usage") {
    // Not activityGated (a client mid-plan with a quiet week still wants to
    // know where their quota stands), but a client with literally zero cards
    // has nothing to show and is almost certainly mid-onboarding.
    if ((Number(lt.totalJobs) || 0) === 0) return { shouldSend: false, reason: "no_activity" };
    return { shouldSend: true, reason: "ok" };
  }

  if (meta.activityGated && st.isEmpty === true) {
    return { shouldSend: false, reason: "no_activity" };
  }

  return { shouldSend: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

function blankResult(itemKey, extraFields = {}) {
  return {
    status: "skipped",
    reason: "",
    itemKey,
    email: { attempted: false, ok: false, to: "", error: "" },
    mattermost: { attempted: false, ok: false, error: "" },
    stats: { added: 0, applied: 0 },
    periodKey: "",
    subject: "",
    ...extraFields
  };
}

function trim300(value) {
  return String(value || "").slice(0, 300);
}

/**
 * Resolve where the email half of a reminder goes.
 *
 * Order is override-first by explicit instruction: the ops route only writes
 * paymentEmailOverride when dashboardtrackings has no row to write to, so in
 * practice at most one of the two is populated. When an operator has gone out
 * of their way to type an address into the tab, that address wins.
 */
/**
 * Where an INTERNAL item's email goes: the SMTP account itself, so we mail
 * ourselves. No dedicated env var - the account we send FROM is the account we
 * send TO, which means there is nothing extra to configure and nothing that can
 * be left unset in one environment and not another.
 *
 * Returns "" when SMTP is not configured, and the caller then reports
 * no_internal_email rather than falling back to anything else. That direction
 * matters: an inactivity alert landing in a paying client's inbox reads as "we
 * went quiet on your account", which is the one message this must never send.
 */
export function resolveInternalAlertEmail() {
  const smtpUser = String(process.env.SMTP_USER || "").toLowerCase().trim();
  return EMAIL_RE.test(smtpUser) ? smtpUser : "";
}

async function resolveDestinationEmail(config) {
  const override = String(config?.paymentEmailOverride || "").toLowerCase().trim();
  if (EMAIL_RE.test(override)) return { to: override, source: "override", clientName: "" };

  try {
    const found = await resolvePaymentEmail(config?.clientEmail);
    if (EMAIL_RE.test(found?.paymentEmail || "")) {
      return { to: found.paymentEmail, source: "tracking", clientName: found.clientName || "" };
    }
    return { to: "", source: "none", clientName: found?.clientName || "" };
  } catch (err) {
    console.error(`${LOG} payment-email lookup failed for ${config?.clientEmail}:`, err?.message || err);
    return { to: "", source: "none", clientName: "" };
  }
}

/**
 * Write the delivery outcome back to the config document.
 *
 * TWO TRAPS THIS AVOIDS, both worth the extra round trip:
 *
 * 1. NO READ-MODIFY-WRITE. A cron delivery and an operator's send-now can land
 *    milliseconds apart. Loading the document, mutating items[] and calling
 *    save() would have the loser of that race write back a stale items array
 *    and erase the winner's lastPeriodKey - re-arming an item that has already
 *    gone out. So: a targeted $set through arrayFilters, touching only the four
 *    bookkeeping fields on the one item, plus a $push that Mongo caps itself.
 *
 * 2. A SKIP STILL BURNS THE PERIOD KEY (for cron). Without that, an item whose
 *    period was empty would be re-evaluated on every single tick for the rest
 *    of the day: 288 activity queries per client per day to arrive at the same
 *    "nothing to report" answer. Writing the key says "this period has been
 *    decided" - the decision just happened to be silence.
 *
 * A manual skip does NOT burn the key, because an operator poking the button
 * at 10:00 must not cancel the real 21:30 send. A FORCED send does not burn it
 * either: force is the "prove the template works" button, and consuming the
 * period to prove it would cost the client the real message.
 */
async function persistOutcome({ clientEmail, itemKey, periodKey, writePeriodKey, result, sentAt }) {
  const historyRow = {
    at: sentAt || new Date(),
    itemKey,
    periodKey,
    status: result.status,
    email: {
      attempted: result.email.attempted,
      ok: result.email.ok,
      to: result.email.to,
      error: trim300(result.email.error)
    },
    mattermost: {
      attempted: result.mattermost.attempted,
      ok: result.mattermost.ok,
      error: trim300(result.mattermost.error)
    },
    stats: { added: result.stats.added, applied: result.stats.applied },
    trigger: result.trigger || "cron"
  };

  // lastError is what the tab shows next to a red item. `reason` is already the
  // most specific thing we know by the time we get here (it names the channel
  // that failed, or the skip rule that fired), so it goes through verbatim.
  // A clean send clears it.
  const lastError = result.status === "sent" ? "" : trim300(result.reason);

  const set = {
    "items.$[it].lastStatus": result.status,
    "items.$[it].lastError": lastError,
    updatedAt: getCurrentISTTime()
  };
  if (writePeriodKey && periodKey) set["items.$[it].lastPeriodKey"] = periodKey;
  if (result.status === "sent" || result.status === "partial") set["items.$[it].lastSentAt"] = historyRow.at;

  try {
    // The item row may not exist yet on a document saved before this item
    // joined the catalogue. arrayFilters silently matches nothing in that case
    // and the $set evaporates, so seed the row first. Both writes are
    // idempotent and safe to race.
    await ClientReminderConfig.updateOne(
      { clientEmail, "items.key": { $ne: itemKey } },
      { $push: { items: defaultItemConfig(itemKey) } }
    );

    const res = await ClientReminderConfig.updateOne(
      { clientEmail },
      {
        $set: set,
        // $position: 0 prepends, $slice: 50 then keeps the FIRST fifty, i.e.
        // the newest fifty. Mongo enforces the cap server-side, so concurrent
        // pushes cannot grow the array past it.
        $push: { history: { $each: [historyRow], $position: 0, $slice: HISTORY_LIMIT } }
      },
      { arrayFilters: [{ "it.key": itemKey }] }
    );

    if (!res?.matchedCount) {
      // Send-now against a client whose config has never been saved. The
      // delivery itself already happened; we just have nowhere to record it.
      console.warn(`${LOG} no config document for ${clientEmail} - outcome for '${itemKey}' not persisted`);
    }
  } catch (err) {
    // A bookkeeping failure must never turn a successful send into a thrown
    // error. Worst case we re-send this period once; that is strictly better
    // than a crashed tick.
    console.error(`${LOG} persist failed for ${clientEmail}/${itemKey}:`, err?.message || err);
  }
}

/**
 * Deliver one reminder. THE single delivery implementation - the cron and the
 * operator's "Send now" button both come through here, so there is no way for
 * the two paths to drift apart in what they send or what they record.
 *
 * @param {object} a
 * @param {object} a.config             a ClientReminderConfig doc, lean object, or merged plain object
 * @param {string} a.itemKey
 * @param {string} [a.trigger]          'cron' | 'manual' | anything the caller wants in the audit row
 * @param {boolean} [a.force]           bypass the empty-skip decision only
 * @param {object|null} [a.channelsOverride]  {mattermost, email} for a one-off test send
 * @param {Date} [a.now]
 * @returns {Promise<{status:string, reason:string, email:object, mattermost:object, stats:object, periodKey:string, subject:string}>}
 *          Never throws.
 */
export async function deliverReminder({
  config,
  itemKey,
  trigger = "cron",
  force = false,
  channelsOverride = null,
  now = new Date()
} = {}) {
  const key = String(itemKey || "");
  const out = blankResult(key, { trigger });

  const meta = reminderItemMeta(key);
  if (!meta) {
    out.reason = "unknown_item";
    return out;
  }

  const merged = mergeWithDefaults(config);
  const clientEmail = merged.clientEmail;
  if (!EMAIL_RE.test(clientEmail)) {
    out.reason = "invalid_client_email";
    return out;
  }

  const item = merged.items.find((i) => i.key === key) || defaultItemConfig(key);

  // A channel override applies to THIS delivery only; it is never written back.
  const channels = channelsOverride
    ? { mattermost: channelsOverride.mattermost === true, email: channelsOverride.email === true }
    : { mattermost: item.channels?.mattermost === true, email: item.channels?.email === true };
  const effectiveItem = { ...item, channels };

  const window = reportWindowFor(key, now);

  let stats;
  let lifetime;
  let daysIdle = 0;
  try {
    // Sequential rather than Promise.all: both hit the same Mongo connection
    // pool and a tick can have fifty of these in flight, so we would rather be
    // slow than queue-starve the request path this process is also serving.
    stats = await getClientActivityStats(clientEmail, { from: window.from, to: window.to });
    lifetime = await getClientLifetimeStats(clientEmail);
    if (key === "inactivity_alert") {
      daysIdle = await daysSinceLastActivity(clientEmail, Math.max(1, Number(item.inactivityDays) || 3) + 1);
    }
  } catch (err) {
    // getClientActivityStats and friends already swallow their own errors; this
    // is belt-and-braces so an unexpected shape cannot take the tick down.
    console.error(`${LOG} stats read failed for ${clientEmail}/${key}:`, err?.message || err);
    out.status = "failed";
    out.reason = "stats_unavailable";
    return out;
  }

  out.stats = { added: Number(stats?.addedCount) || 0, applied: Number(stats?.appliedCount) || 0 };

  const decision = decideDelivery({
    meta,
    item: effectiveItem,
    stats,
    lifetime,
    inactivityDays: item.inactivityDays,
    daysIdle
  });
  const extra = decision.extra || {};

  const periodKey = periodKeyFor(key, now);
  out.periodKey = periodKey;

  // Which triggers consume the day. The scheduled tick does, and so does the
  // threshold auto-send - if the auto-send did NOT burn the key, the client
  // would get the summary at 15:40 because five roles landed AND again at
  // 21:30 when the clock came round. A manual send-now never consumes it, so
  // an operator testing the template cannot cancel the real send.
  const consumesPeriod = trigger === "cron" || trigger === "auto-threshold";

  const forcedThrough = force && !decision.shouldSend && FORCEABLE_REASONS.has(decision.reason);
  if (!decision.shouldSend && !forcedThrough) {
    out.status = "skipped";
    out.reason = decision.reason;
    // See persistOutcome: a cron skip consumes the period so we stop asking.
    await persistOutcome({
      clientEmail,
      itemKey: key,
      periodKey,
      writePeriodKey: consumesPeriod,
      result: out,
      sentAt: now
    });
    return out;
  }
  if (forcedThrough) out.reason = `forced_over_${decision.reason}`;

  const client = { name: merged.clientName || "", email: clientEmail };
  const period = { label: window.label, from: window.from, to: window.to };

  // ── Email ──
  if (channels.email) {
    // Internal items mail the TEAM, full stop. The client's payment address is
    // never even looked up for them, so no code path below this line can leak
    // an internal alert into a client inbox - not a bad override, not a
    // mislinked tracking row, nothing.
    const dest = meta.internal === true
      ? { to: resolveInternalAlertEmail(), source: "internal", clientName: "" }
      : await resolveDestinationEmail(merged);
    if (!client.name && dest.clientName) client.name = dest.clientName;

    if (!dest.to) {
      // Not forceable and not a failure of ours: there is simply no address on
      // file. Reported, logged, and the Mattermost half still goes out.
      out.email = {
        attempted: false,
        ok: false,
        to: "",
        error: meta.internal === true ? "no_internal_email" : "no_payment_email"
      };
    } else if (!isSmtpConfigured()) {
      out.email = { attempted: false, ok: false, to: dest.to, error: "smtp_not_configured" };
    } else {
      const rendered = renderReminderEmail({ kind: key, client, stats, lifetime, period, extra });
      if (!rendered) {
        out.email = { attempted: false, ok: false, to: dest.to, error: "template_unavailable" };
      } else {
        out.subject = rendered.subject;
        // NO category on purpose. Reminders are an independent,
        // operator-controlled stream: they are stopped by switching the item
        // off in the tab, never by the transport-level pause list in
        // Utils/smtpSender.js. Tagging them with a category that later gets
        // paused would have this whole feature silently deliver nothing while
        // the history rows cheerfully logged "emails_paused".
        // List-Unsubscribe turns the provider's own Unsubscribe button into a
        // one-click opt-out. Gmail and Yahoo have required it on bulk mail
        // since Feb 2024, and its absence costs deliverability for everyone
        // sending from this account. Internal items get no header - the team
        // does not unsubscribe from its own alerts.
        const res = await sendViaSmtp({
          to: dest.to,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          headers:
            meta.internal === true
              ? undefined
              : unsubscribeHeaders(clientEmail, UNSUB_STREAMS.REMINDERS)
        });
        out.email = {
          attempted: true,
          ok: res?.ok === true,
          to: dest.to,
          error: res?.ok === true ? "" : trim300(res?.error || "send_failed")
        };
      }
    }
  }

  // ── Mattermost ──
  if (channels.mattermost) {
    const webhook = normalizeWebhookUrl(merged.mattermostWebhookUrl);
    if (!isValidWebhookUrl(webhook)) {
      out.mattermost = { attempted: false, ok: false, error: "no_webhook_url" };
    } else {
      const rendered = renderReminderMattermost({ kind: key, client, stats, lifetime, period, extra });
      if (!rendered?.text) {
        out.mattermost = { attempted: false, ok: false, error: "template_unavailable" };
      } else {
        const res = await sendToMattermost({ webhookUrl: webhook, text: rendered.text, username: "FlashFire" });
        out.mattermost = {
          attempted: true,
          ok: res?.ok === true,
          error: res?.ok === true ? "" : trim300(res?.error || "post_failed")
        };
      }
    }
  }

  const attempted = [out.email.attempted, out.mattermost.attempted].filter(Boolean).length;
  const succeeded = [out.email.attempted && out.email.ok, out.mattermost.attempted && out.mattermost.ok].filter(
    Boolean
  ).length;

  // The reason must name why a channel that WAS tried failed. Reading
  // out.email.error unconditionally would report "no_payment_email" for a run
  // whose only real problem was a 404 from the webhook, which sends an
  // operator chasing the wrong thing.
  const attemptedErrors = [
    out.email.attempted && !out.email.ok ? `email: ${out.email.error}` : "",
    out.mattermost.attempted && !out.mattermost.ok ? `mattermost: ${out.mattermost.error}` : ""
  ].filter(Boolean);
  const unusableErrors = [
    !out.email.attempted && out.email.error ? `email: ${out.email.error}` : "",
    !out.mattermost.attempted && out.mattermost.error ? `mattermost: ${out.mattermost.error}` : ""
  ].filter(Boolean);

  if (attempted === 0) {
    // Every enabled channel was unusable (no address, no webhook, no SMTP).
    out.status = "skipped";
    out.reason = unusableErrors.join("; ") || "no_destination";
  } else if (succeeded === 0) {
    out.status = "failed";
    out.reason = attemptedErrors.join("; ") || "delivery_failed";
  } else if (succeeded < attempted) {
    out.status = "partial";
    out.reason = attemptedErrors.join("; ") || "partial_delivery";
  } else {
    out.status = "sent";
    if (!forcedThrough) out.reason = "ok";
  }

  await persistOutcome({
    clientEmail,
    itemKey: key,
    periodKey,
    // A forced send is a test. It records history but never consumes the real
    // period.
    writePeriodKey: !force,
    result: out,
    sentAt: now
  });

  if (out.status === "sent" || out.status === "partial") {
    console.log(
      `${LOG} ${out.status} '${key}' for ${clientEmail} (${periodKey || "event"}) ` +
        `email=${out.email.attempted ? (out.email.ok ? "ok" : "fail") : "-"} ` +
        `mm=${out.mattermost.attempted ? (out.mattermost.ok ? "ok" : "fail") : "-"}`
    );
  } else if (out.status === "failed") {
    console.warn(`${LOG} failed '${key}' for ${clientEmail}: ${out.reason}`);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

/**
 * One pass over every client whose config could possibly deliver something.
 *
 * The Mongo filter does the first cut so we never pull the whole collection:
 * a config only qualifies if it holds at least one item that is enabled AND
 * has at least one channel switched on. Everything else is decided in memory
 * by the pure functions above.
 *
 * One client's failure never aborts the pass - the loop body is fully wrapped.
 *
 * @returns {Promise<{evaluated:number, sent:number, skipped:number, failed:number}>}
 */
export async function runReminderTick({ now = new Date() } = {}) {
  const summary = { evaluated: 0, sent: 0, skipped: 0, failed: 0 };

  let configs = [];
  try {
    configs = await ClientReminderConfig.find({
      items: {
        $elemMatch: {
          enabled: true,
          $or: [{ "channels.mattermost": true }, { "channels.email": true }]
        }
      }
    })
      .lean();
  } catch (err) {
    console.error(`${LOG} config query failed:`, err?.message || err);
    return summary;
  }

  let deliveries = 0;

  for (const raw of configs) {
    if (deliveries >= MAX_SENDS_PER_TICK) break;

    try {
      const merged = mergeWithDefaults(raw);
      if (!EMAIL_RE.test(merged.clientEmail)) continue;

      // Catalogue order, so a client whose daily summary and weekly report are
      // both due gets them in the order the tab lists them.
      for (const meta of REMINDER_ITEMS) {
        if (deliveries >= MAX_SENDS_PER_TICK) break;

        const item = merged.items.find((i) => i.key === meta.key);
        if (!item || item.enabled !== true) continue;
        if (!hasEnabledChannel(item.channels)) continue;

        summary.evaluated += 1;

        // Two ways a daily item becomes due: the clock, or the threshold
        // auto-send. Both consume the SAME period key, so whichever fires first
        // wins the day and the other is a no-op - the client never gets the
        // summary twice.
        //
        // The threshold path costs an extra query, so it is only reached when
        // the scheduled time has not arrived and the operator actually switched
        // the automation on.
        let due = isItemDue(item, meta, now);
        let trigger = "cron";
        if (!due && item.autoOnThreshold === true && meta.cadence === "daily") {
          const need = Number.isInteger(item.autoThresholdCount) ? item.autoThresholdCount : 5;
          const { count, nthAt } = await nthRoleAddedTodayIST(merged.clientEmail, need, now);
          if (isThresholdAutoDue({ item, meta, addedCount: count, nthAt, now })) {
            due = true;
            trigger = "auto-threshold";
          }
        }
        if (!due) continue;

        deliveries += 1;
        const res = await deliverReminder({ config: raw, itemKey: meta.key, trigger, now });
        if (res.status === "sent" || res.status === "partial") summary.sent += 1;
        else if (res.status === "failed") summary.failed += 1;
        else summary.skipped += 1;
      }
    } catch (err) {
      // Per-client isolation: a corrupt document or an unexpected template
      // shape costs that client this tick, not everyone else's.
      console.error(`${LOG} client ${raw?.clientEmail || "?"} failed this tick:`, err?.message || err);
    }
  }

  if (deliveries >= MAX_SENDS_PER_TICK) {
    console.warn(`${LOG} hit MAX_SENDS_PER_TICK (${MAX_SENDS_PER_TICK}) - remainder drains next tick`);
  }

  return summary;
}

/** Cron entry point. Swallows everything; re-entrancy guarded. */
async function tickSafely() {
  if (!ENABLED) return { disabled: true, reason: ENABLED_REASON };
  // A tick that overruns five minutes (a slow SMTP host, fifty clients) must
  // not have a second copy start on top of it and double-send the overlap.
  if (running) {
    console.warn(`${LOG} previous tick still running - skipping this one`);
    return { skipped: "already_running" };
  }
  running = true;
  const startedAt = Date.now();
  try {
    const out = await runReminderTick({ now: new Date() });
    if (out.sent || out.failed) {
      console.log(
        `${LOG} tick - evaluated=${out.evaluated} sent=${out.sent} skipped=${out.skipped} failed=${out.failed} (${Date.now() - startedAt}ms)`
      );
    }
    return out;
  } catch (err) {
    console.error(`${LOG} tick crashed:`, err);
    return { error: String(err?.message || err) };
  } finally {
    running = false;
  }
}

/**
 * Register the five-minute cron. Idempotent, and a no-op when the worker is
 * disabled for this process - the log line always states which, because
 * "why did the client not get their report" is the first question anyone asks.
 */
export function startClientReminderWorker() {
  if (!ENABLED) {
    console.log(`${LOG} disabled (${ENABLED_REASON})`);
    return;
  }
  if (task) return;
  task = cron.schedule(CRON_EXPR, () => tickSafely(), { timezone: "Asia/Kolkata" });
  console.log(
    `${LOG} worker registered (${ENABLED_REASON}, cron='${CRON_EXPR}' Asia/Kolkata, ` +
      `max ${MAX_SENDS_PER_TICK} deliveries/tick, items=${REMINDER_ITEM_KEYS.length}, ` +
      `smtp=${isSmtpConfigured() ? "configured" : "NOT configured"})`
  );
}

export default {
  periodKeyFor,
  reportWindowFor,
  isItemDue,
  decideDelivery,
  deliverReminder,
  runReminderTick,
  startClientReminderWorker,
  isReminderWorkerEnabled,
  reminderWorkerEnabledReason
};
