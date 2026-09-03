// clientActivityStats: the ONLY place the client-reminder stack is allowed to
// ask "what actually happened for this client between A and B".
//
// Everything here exists because JobDB stores time in two hostile shapes:
//
//   1. dateAdded / createdAt / updatedAt / appliedDate are LOCALE STRINGS,
//      produced by new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'}).
//      They are not Dates, they are not sortable, they are not queryable, and
//      depending on which server wrote them they are either en-IN DD/MM/YYYY or
//      en-US MM/DD/YYYY. Any range query against them is a lie.
//   2. The only trustworthy machine timestamp on a card is the one embedded in
//      its _id. That is what "added in window" is measured against, exactly the
//      way Utils/dailyCapGuard.js todayLowBoundObjectId and
//      Controllers/Get24HourJobs.js already do it.
//
// So the shape of every function below is: pull the client's cards with ONE
// bounded query on an indexed field (userID + _id), then classify in JS. Never
// a query per day, never a range filter on a locale string.
//
// Second trap this module isolates: currentStatus carries an attribution
// suffix. Real values in the collection look like "applied by Sathya",
// "saved by Ops", "removed by AI". Equality comparison against "applied"
// silently reports zero activity for a client who applied to forty jobs, which
// with the reminder empty-skip rule means we quietly stop mailing them. Every
// status read in this file goes through classifyStatus().
//
// Nothing here throws. A reminder worker that crashes on a malformed date
// stops delivering for every client, so a DB failure logs under
// [client-reminders] and returns a zeroed shape with isEmpty:true - which the
// empty-skip rule then turns into silence rather than a wrong report.

import mongoose from "mongoose";
import { JobModel } from "../Schema_Models/JobModel.js";
import { readPlanCap } from "./dailyCapGuard.js";
import { parseLocaleDateMs, objectIdTimeMs } from "./jobActivityTime.js";

/** IST is a fixed UTC+05:30. India has never observed DST, so plain arithmetic
 *  is exact here and we never have to round-trip through toLocaleString for a
 *  boundary. Formatting still uses Intl (see istDayKey's siblings) because that
 *  is what Intl is good at; boundaries are computed, not parsed. */
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const LOG_PREFIX = "[client-reminders]";

/**
 * How far BEFORE the report window we still pull cards.
 *
 * "Applied in window" is decided by appliedDate, which is a string we cannot
 * filter on in Mongo - so the only server-side bound available is the card's
 * _id (creation time). A card created long ago can be applied today, so the
 * query has to reach back past the window start. 400 days is the compromise:
 * it comfortably covers the whole lifetime of any live plan (the largest plan
 * cap is 1200 applications and clients churn well inside a year) while keeping
 * the read bounded for the handful of ancient accounts that were never closed.
 * A card created more than 400 days before the window and applied inside it
 * would be missed; that has not happened in this dataset and the alternative
 * is an unbounded collection scan on every cron tick.
 */
const LOOKBACK_DAYS_BEFORE_WINDOW = 400;

/** Hard ceiling on documents pulled for one window report. Sorted _id
 *  descending, so if a client somehow exceeds this we keep the NEWEST cards,
 *  which are the ones any report window cares about. */
const MAX_WINDOW_SCAN = 5000;

/** Hard ceiling on the lifetime status scan. Only one field is projected, so
 *  this is a few tens of KB even at the limit. */
const MAX_LIFETIME_SCAN = 20000;

/** List caps, per the reminder-template contract. */
const LIST_CAP_PRIMARY = 25; // added / applied
const LIST_CAP_SECONDARY = 15; // interview / offer
const TOP_COMPANIES = 5;

/** Safety valve on byDay so a nonsense range cannot build a million rows. */
const MAX_BYDAY_ROWS = 400;

// ---------------------------------------------------------------------------
// IST calendar primitives
// ---------------------------------------------------------------------------

/** Coerce anything date-ish to a valid Date, or null. Accepts Date, epoch ms,
 *  and ISO strings; rejects Invalid Date rather than letting NaN propagate
 *  into an ObjectId or a day key. */
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Calendar fields of `date` as seen in IST.
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,weekday:number}}
 *   month is 1-12, weekday is 0=Sunday..6=Saturday.
 */
export function istParts(date = new Date()) {
  const d = toDate(date) || new Date();
  // Shift into a pseudo-UTC frame where the UTC accessors read out IST fields.
  const shifted = new Date(d.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay()
  };
}

/** UTC instant of 00:00:00.000 IST on the IST calendar day containing `date`. */
export function startOfCalendarDayIST(date = new Date()) {
  const { year, month, day } = istParts(date);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0) - IST_OFFSET_MS);
}

/** UTC instant of 23:59:59.999 IST on the IST calendar day containing `date`. */
export function endOfCalendarDayIST(date = new Date()) {
  const { year, month, day } = istParts(date);
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999) - IST_OFFSET_MS);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** "YYYY-MM-DD" for the IST calendar day containing `date`. */
export function istDayKey(date = new Date()) {
  const { year, month, day } = istParts(date);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** "YYYY-MM" for the IST calendar month containing `date`. */
export function istMonthKey(date = new Date()) {
  const { year, month } = istParts(date);
  return `${year}-${pad2(month)}`;
}

/**
 * ISO-8601 week key, "YYYY-Www", computed on the IST calendar date.
 *
 * ISO weeks start Monday and week 1 is the week containing the year's first
 * Thursday, which means the ISO year is NOT always the calendar year: IST
 * 2025-12-29 (a Monday) is 2026-W01, and IST 2026-01-01 (a Thursday) is also
 * 2026-W01. The worker uses this string as the once-per-period idempotency
 * key, so getting the year-boundary wrong would either double-send or skip a
 * week entirely.
 */
export function istWeekKey(date = new Date()) {
  const { year, month, day } = istParts(date);
  // Work in a plain UTC frame on the IST calendar date; no time component, so
  // no offset can push us across a day boundary mid-calculation.
  const target = new Date(Date.UTC(year, month - 1, day));
  const dayNum = (target.getUTCDay() + 6) % 7; // Monday = 0
  // Move to the Thursday of this ISO week: that day's calendar year IS the ISO
  // week-numbering year, by definition.
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const isoYear = target.getUTCFullYear();
  // Jan 4th is always in ISO week 1; walk it back to its own Thursday to get
  // the anchor, then count whole weeks.
  const anchor = new Date(Date.UTC(isoYear, 0, 4));
  const anchorDayNum = (anchor.getUTCDay() + 6) % 7;
  anchor.setUTCDate(anchor.getUTCDate() - anchorDayNum + 3);
  const week = 1 + Math.round((target.getTime() - anchor.getTime()) / (7 * DAY_MS));
  return `${isoYear}-W${pad2(week)}`;
}

/**
 * Low-bound ObjectId for `_id: { $gte: ... }` range queries.
 *
 * Same construction as Utils/dailyCapGuard.js todayLowBoundObjectId: the first
 * 4 bytes of an ObjectId are the creation time in unix seconds, so an id built
 * from `seconds` followed by 16 zero nibbles sorts at-or-before every document
 * created at that second. This is the only reliable creation-time filter we
 * have, because dateAdded/createdAt are locale strings.
 */
export function objectIdAtOrAfter(date = new Date()) {
  const d = toDate(date) || new Date();
  let seconds = Math.floor(d.getTime() / 1000);
  // ObjectId timestamps are an unsigned 32-bit second count. Clamp rather than
  // emitting a malformed hex string that would throw inside the driver.
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  if (seconds > 0xffffffff) seconds = 0xffffffff;
  const hex = seconds.toString(16).padStart(8, "0") + "0000000000000000";
  return new mongoose.Types.ObjectId(hex);
}

// ---------------------------------------------------------------------------
// Stored-date parsing
// ---------------------------------------------------------------------------

/**
 * Faithful port of parseStoredDate in Controllers/FixAppliedDates.js, widened
 * to also accept a real Date and a bare ISO string.
 *
 * The DB holds two mutually incompatible formats written by different code
 * paths, and "03/04/2026" is genuinely ambiguous. The rule below is copied
 * verbatim from the existing parser so that reminders and the applied-date fix
 * agree on what a row means - two different readings of the same string would
 * put a job in a different week in the report than in the dashboard.
 *
 * @returns {Date|null} null when unparseable. Never throws.
 */
export function parseStoredISTDate(dateString) {
  // Delegates to Utils/jobActivityTime.js so there is exactly ONE set of rules
  // for reading these strings.
  //
  // This function used to carry its own copy that read an ambiguous date as
  // MM/DD "to match backend logic". Both copies were wrong in different ways,
  // and the writer locale changed around Oct 2025: everything since is en-IN
  // (D/M, lowercase meridiem) while Jul-Sep 2025 is largely en-US (M/D,
  // UPPERCASE meridiem). Reading "1/5/2026" as 5 January instead of 1 May
  // moves a card four months, which for a digest means an application simply
  // is not counted and the report skips itself as "no activity".
  //
  // The shared parser settles the format on an out-of-range number first, then
  // on the meridiem case, and also handles the date-only shapes ("24/3/2026",
  // "2026-08-22") that this one returned null for - 644 applied cards were
  // invisible to every window query because of that.
  const ms = parseLocaleDateMs(dateString);
  if (ms == null) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Status classification
// ---------------------------------------------------------------------------

/**
 * Map a raw currentStatus onto one bucket.
 *
 * currentStatus is free text with an attribution suffix ("applied by Sathya",
 * "removed by AI"), so never compare it with ===.
 *
 * Precedence matters and is deliberate:
 *   removed   first, anchored - a removed card is out of every count, whatever
 *             the rest of the string says.
 *   offer / interview / rejected next, LOOSE, because these arrive as phrases
 *             ("interview scheduled", "offer received by Ops"). Offer beats
 *             interview so a card that reached both is counted at its furthest
 *             stage; rejected is checked after them so "rejected" alone still
 *             lands in its own bucket.
 *   applied / saved last, ANCHORED, so "applied" cannot swallow a phrase that
 *             merely mentions applying.
 *
 * @returns {'applied'|'saved'|'interview'|'offer'|'rejected'|'removed'|'other'}
 */
export function classifyStatus(currentStatus) {
  const s = String(currentStatus || "").trim();
  if (!s) return "other";
  if (/^(deleted|removed)/i.test(s)) return "removed";
  if (/offer/i.test(s)) return "offer";
  if (/interview/i.test(s)) return "interview";
  if (/reject/i.test(s)) return "rejected";
  if (/^appl/i.test(s)) return "applied";
  if (/^saved/i.test(s)) return "saved";
  return "other";
}

/** Buckets that mean "this card was submitted at some point". */
const APPLIED_OR_BEYOND = new Set(["applied", "interview", "offer", "rejected"]);

// ---------------------------------------------------------------------------
// Window stats
// ---------------------------------------------------------------------------

function normaliseEmail(raw) {
  return String(raw || "").trim().toLowerCase();
}

function emptyStats(from, to) {
  return {
    from,
    to,
    addedCount: 0,
    appliedCount: 0,
    interviewCount: 0,
    offerCount: 0,
    rejectedCount: 0,
    removedCount: 0,
    addedJobs: [],
    appliedJobs: [],
    interviewJobs: [],
    offerJobs: [],
    topCompanies: [],
    byDay: [],
    isEmpty: true
  };
}

function jobRow(job, at) {
  return {
    jobTitle: String(job?.jobTitle || "").trim() || "Untitled role",
    companyName: String(job?.companyName || "").trim() || "Unknown company",
    joblink: String(job?.joblink || "").trim(),
    // ISO string rather than a Date: this payload is JSON-serialised by the
    // preview route and interpolated into email/markdown templates, and a raw
    // Date stringifies differently in each of those paths.
    at: at instanceof Date && !Number.isNaN(at.getTime()) ? at.toISOString() : null
  };
}

/**
 * Activity for one client inside [from, to], inclusive on both ends.
 *
 * Costs exactly one Mongo read (userID + _id range, both covered by the
 * { userID: 1, _id: -1 } index) and does all bucketing in JS. See
 * LOOKBACK_DAYS_BEFORE_WINDOW for why the read reaches back past `from`.
 *
 * Timestamp choice per bucket, stated once so the whole stack agrees:
 *   added      → the _id creation timestamp. The only machine time we have.
 *   applied    → appliedDate, falling back to updatedAt. Rows written before
 *                appliedDate existed have it null while sitting in an applied
 *                status; without the fallback those clients report zero
 *                applications and the empty-skip rule silences their report.
 *   interview /
 *   offer /
 *   rejected /
 *   removed    → updatedAt, falling back to appliedDate, falling back to the
 *                _id time. There is no dedicated "reached interview" stamp, so
 *                the last touch is the best available proxy for "moved into
 *                this stage during the window".
 */
export async function getClientActivityStats(clientEmail, range = {}) {
  const from = toDate(range?.from) || startOfCalendarDayIST(new Date());
  const to = toDate(range?.to) || endOfCalendarDayIST(new Date());
  const email = normaliseEmail(clientEmail);
  if (!email || !email.includes("@")) {
    console.warn(`${LOG_PREFIX} getClientActivityStats called without a usable clientEmail`);
    return emptyStats(from, to);
  }
  if (from.getTime() > to.getTime()) {
    console.warn(`${LOG_PREFIX} getClientActivityStats got an inverted window for ${email}`);
    return emptyStats(from, to);
  }

  let jobs = [];
  try {
    const scanFrom = new Date(from.getTime() - LOOKBACK_DAYS_BEFORE_WINDOW * DAY_MS);
    jobs = await JobModel.find({
      userID: email,
      _id: { $gte: objectIdAtOrAfter(scanFrom) }
    })
      .select("jobTitle companyName joblink currentStatus appliedDate updatedAt _id")
      .sort({ _id: -1 })
      .limit(MAX_WINDOW_SCAN)
      .lean();
  } catch (err) {
    console.error(`${LOG_PREFIX} getClientActivityStats read failed for ${email}:`, err?.message || err);
    return emptyStats(from, to);
  }

  const fromMs = from.getTime();
  const toMs = to.getTime();
  const inWindow = (d) => d instanceof Date && d.getTime() >= fromMs && d.getTime() <= toMs;

  const addedJobs = [];
  const appliedJobs = [];
  const interviewJobs = [];
  const offerJobs = [];
  let rejectedCount = 0;
  let removedCount = 0;
  const companyTally = new Map();
  // Zero-filled day buckets are built after the loop; this only records hits.
  const dayAdded = new Map();
  const dayApplied = new Map();

  for (const job of Array.isArray(jobs) ? jobs : []) {
    let bucket;
    let addedAt = null;
    try {
      bucket = classifyStatus(job?.currentStatus);
      // ObjectId.getTimestamp() is the creation time; guard because a lean doc
      // from an aggregation-shaped source could carry a plain string _id.
      addedAt =
        job?._id && typeof job._id.getTimestamp === "function" ? job._id.getTimestamp() : null;
    } catch (err) {
      console.warn(`${LOG_PREFIX} skipping an unreadable card for ${email}:`, err?.message || err);
      continue;
    }

    const appliedAt =
      parseStoredISTDate(job?.appliedDate) || parseStoredISTDate(job?.updatedAt) || null;
    const touchedAt =
      parseStoredISTDate(job?.updatedAt) || parseStoredISTDate(job?.appliedDate) || addedAt;

    // ---- added ----------------------------------------------------------
    // A card the client removed never counted as delivered work, so it is out
    // of the added figure even when it was created inside the window.
    if (bucket !== "removed" && inWindow(addedAt)) {
      addedJobs.push(jobRow(job, addedAt));
      const key = istDayKey(addedAt);
      dayAdded.set(key, (dayAdded.get(key) || 0) + 1);
    }

    // ---- applied --------------------------------------------------------
    if (APPLIED_OR_BEYOND.has(bucket) && inWindow(appliedAt)) {
      appliedJobs.push(jobRow(job, appliedAt));
      const key = istDayKey(appliedAt);
      dayApplied.set(key, (dayApplied.get(key) || 0) + 1);
      const company = String(job?.companyName || "").trim() || "Unknown company";
      companyTally.set(company, (companyTally.get(company) || 0) + 1);
    }

    // ---- stage buckets --------------------------------------------------
    if (inWindow(touchedAt)) {
      if (bucket === "interview") interviewJobs.push(jobRow(job, touchedAt));
      else if (bucket === "offer") offerJobs.push(jobRow(job, touchedAt));
      else if (bucket === "rejected") rejectedCount += 1;
      else if (bucket === "removed") removedCount += 1;
    }
  }

  const byTimeDesc = (a, b) => String(b.at || "").localeCompare(String(a.at || ""));
  addedJobs.sort(byTimeDesc);
  appliedJobs.sort(byTimeDesc);
  interviewJobs.sort(byTimeDesc);
  offerJobs.sort(byTimeDesc);

  const topCompanies = [...companyTally.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, TOP_COMPANIES);

  // byDay only makes sense for a multi-day window; a daily digest already IS
  // one row and a single-row breakdown table is noise in the email.
  const byDay = [];
  if (istDayKey(from) !== istDayKey(to)) {
    const firstDay = startOfCalendarDayIST(from).getTime();
    const lastDay = startOfCalendarDayIST(to).getTime();
    let rows = 0;
    for (let t = firstDay; t <= lastDay && rows < MAX_BYDAY_ROWS; t += DAY_MS, rows += 1) {
      const key = istDayKey(new Date(t));
      byDay.push({ date: key, added: dayAdded.get(key) || 0, applied: dayApplied.get(key) || 0 });
    }
  }

  const addedCount = addedJobs.length;
  const appliedCount = appliedJobs.length;

  return {
    from,
    to,
    addedCount,
    appliedCount,
    interviewCount: interviewJobs.length,
    offerCount: offerJobs.length,
    rejectedCount,
    removedCount,
    addedJobs: addedJobs.slice(0, LIST_CAP_PRIMARY),
    appliedJobs: appliedJobs.slice(0, LIST_CAP_PRIMARY),
    interviewJobs: interviewJobs.slice(0, LIST_CAP_SECONDARY),
    offerJobs: offerJobs.slice(0, LIST_CAP_SECONDARY),
    topCompanies,
    byDay,
    // THE rule the whole feature hangs on: nothing added and nothing applied
    // means the caller sends nothing at all.
    isEmpty: addedCount === 0 && appliedCount === 0
  };
}

// ---------------------------------------------------------------------------
// Lifetime stats
// ---------------------------------------------------------------------------

function emptyLifetime() {
  return {
    totalJobs: 0,
    totalApplied: 0,
    totalInterviews: 0,
    totalOffers: 0,
    planType: "",
    effectiveCap: null,
    remaining: null,
    percentUsed: null
  };
}

/**
 * All-time counters plus the plan picture, for the milestone
 * items.
 *
 * One projected read of currentStatus for the whole client (a single small
 * field, and the biggest plan tops out around 1200 cards) plus readPlanCap.
 * Counting in JS rather than with four regex countDocuments calls keeps the
 * definition of "applied" identical to every window report - a milestone that
 * fires on a different definition than the weekly report reads as a bug to the
 * client.
 *
 * totalJobs mirrors dailyCapGuard.countTotalJobs: every non-removed card,
 * saved ones included, because that is what the plan cap actually consumes.
 * totalApplied is the narrower "reached applied or beyond" figure that the
 * client thinks of as their application count.
 */
export async function getClientLifetimeStats(clientEmail) {
  const email = normaliseEmail(clientEmail);
  if (!email || !email.includes("@")) {
    console.warn(`${LOG_PREFIX} getClientLifetimeStats called without a usable clientEmail`);
    return emptyLifetime();
  }

  const out = emptyLifetime();

  try {
    const rows = await JobModel.find({ userID: email })
      .select("currentStatus -_id")
      .limit(MAX_LIFETIME_SCAN)
      .lean();
    for (const row of Array.isArray(rows) ? rows : []) {
      const bucket = classifyStatus(row?.currentStatus);
      if (bucket === "removed") continue;
      out.totalJobs += 1;
      if (APPLIED_OR_BEYOND.has(bucket)) out.totalApplied += 1;
      if (bucket === "interview") out.totalInterviews += 1;
      if (bucket === "offer") out.totalOffers += 1;
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} getClientLifetimeStats count failed for ${email}:`, err?.message || err);
    return emptyLifetime();
  }

  // readPlanCap throws by design (its callers fail closed on a cap read). A
  // reminder must not: a missing plan just means we omit the quota line.
  try {
    const cap = await readPlanCap(email);
    out.planType = cap?.planType || "";
    out.effectiveCap = Number.isFinite(cap?.effectiveCap) ? cap.effectiveCap : null;
  } catch (err) {
    console.warn(`${LOG_PREFIX} plan cap unavailable for ${email}:`, err?.message || err);
  }

  if (out.effectiveCap != null && out.effectiveCap > 0) {
    out.remaining = Math.max(0, out.effectiveCap - out.totalJobs);
    out.percentUsed = Math.round((out.totalJobs / out.effectiveCap) * 100);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Inactivity
// ---------------------------------------------------------------------------

/**
 * How many IST calendar days ago the client last had ANY activity (a card
 * added or an application submitted).
 *
 * 0 means something happened today. When nothing is found inside the lookback
 * the function returns maxLookbackDays, i.e. "at least this long" - callers
 * compare with >= so saturating is the correct, safe answer.
 *
 * Deliberately ONE getClientActivityStats read over the whole lookback window
 * and then a walk backwards through byDay. Looping day-by-day with a query per
 * day would be 30 round trips per client per tick.
 */
export async function daysSinceLastActivity(clientEmail, maxLookbackDays = 30) {
  const raw = Number(maxLookbackDays);
  const lookback = Number.isFinite(raw) ? Math.min(365, Math.max(1, Math.floor(raw))) : 30;

  const email = normaliseEmail(clientEmail);
  if (!email || !email.includes("@")) {
    console.warn(`${LOG_PREFIX} daysSinceLastActivity called without a usable clientEmail`);
    return lookback;
  }

  try {
    const now = new Date();
    const todayStart = startOfCalendarDayIST(now);
    const from = new Date(todayStart.getTime() - lookback * DAY_MS);
    const to = endOfCalendarDayIST(now);

    const stats = await getClientActivityStats(email, { from, to });
    const rows = Array.isArray(stats?.byDay) ? stats.byDay : [];

    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if ((row?.added || 0) > 0 || (row?.applied || 0) > 0) {
        // byDay is ascending and every day in the range is present, so the
        // distance from the end IS the age in days. Derive it from the row
        // index rather than re-parsing the key.
        const age = rows.length - 1 - i;
        return Math.min(lookback, age);
      }
    }
    return lookback;
  } catch (err) {
    console.error(`${LOG_PREFIX} daysSinceLastActivity failed for ${email}:`, err?.message || err);
    // Fail towards "we do not know", which for the inverted inactivity_alert
    // means it will fire. That is the internal-only Mattermost warning, and a
    // spurious warning is cheaper than missing a genuinely stalled client.
    return lookback;
  }
}

/**
 * When did the Nth role get added to this client's tracker today?
 *
 * Backs the daily summary's threshold auto-send: "once 5 roles are added, mail
 * an hour later". The clock has to start at the Nth add, not at the newest one,
 * or a client whose roles trickle in all day would have the timer reset by
 * every new card and the mail would never go out.
 *
 * Creation time comes from the ObjectId, never from the stored locale strings -
 * see Utils/jobActivityTime.js for why those cannot be trusted for ordering.
 * Removed cards do not count toward the threshold, matching getClientActivityStats.
 *
 * @param {string} clientEmail
 * @param {number} n            the threshold, 1-based
 * @param {Date}   [now]
 * @returns {Promise<{count: number, nthAt: Date|null}>} nthAt is null until the
 *          client has at least n added roles today.
 */
export async function nthRoleAddedTodayIST(clientEmail, n, now = new Date()) {
  const email = String(clientEmail || "").trim().toLowerCase();
  const threshold = Number.isInteger(n) && n > 0 ? n : 5;
  if (!email) return { count: 0, nthAt: null };

  try {
    const from = startOfCalendarDayIST(now);
    const to = endOfCalendarDayIST(now);

    const rows = await JobModel.find({
      userID: email,
      _id: { $gte: objectIdAtOrAfter(from), $lte: objectIdAtOrAfter(to) }
    })
      .select("_id currentStatus")
      .sort({ _id: 1 })
      .lean();

    const live = rows.filter((r) => classifyStatus(r.currentStatus) !== "removed");
    const nth = live[threshold - 1];
    return {
      count: live.length,
      nthAt: nth ? new Date(objectIdTimeMs(nth._id)) : null
    };
  } catch (err) {
    // Never throw into the tick. No answer means "not due", which is the safe
    // direction for a trigger that sends client-facing mail.
    console.error(`${LOG_PREFIX} nthRoleAddedTodayIST failed for ${email}:`, err?.message || err);
    return { count: 0, nthAt: null };
  }
}
