// Authoritative timestamps for a job card.
//
// THE PROBLEM THIS SOLVES
//
// JobModel stores dateAdded / createdAt / updatedAt / appliedDate as LOCALE
// STRINGS, and the collection contains at least three different formats,
// because different writers over the years used different locales:
//
//   en-IN  "1/5/2026, 3:59:09 pm"    D/M/YYYY, lowercase meridiem
//   en-US  "5/1/2026, 3:59:09 PM"    M/D/YYYY, UPPERCASE meridiem
//   ISO    "2025-08-29T15:32:35.351Z"
//
// The writer locale CHANGED. Measured over 12208 live cards, bucketed by the
// creation month in the ObjectId:
//
//   2025-07   en-US 22
//   2025-08   en-US 853,  ISO 44
//   2025-09   en-IN 3413, en-US 2263      <- the switchover
//   2025-10   en-IN 4587, en-US 174
//   2026-03+  en-IN only
//
// Totals for dateAdded: en-IN 8823, en-US 3341, ISO 44. So neither "always
// DD/MM" nor "always MM/DD" is right: the first breaks the 2025 archive, the
// second breaks everything written since. Both mistakes exist in this codebase's
// history, and both sort a large slice of the data into the wrong month.
// "1/5/2026" read as 5 January instead of 1 May moves a card four months into
// the past, which is exactly how the dashboard's Recent Activities panel ended
// up showing April cards above May ones.
//
// THE FIX, in order of trustworthiness:
//
//   1. The ObjectId. Mongo embeds the insert time in the first 4 bytes of _id.
//      It is exact, unambiguous, timezone-free and cannot be reformatted by a
//      locale. For "when was this card created" it is simply the right answer,
//      and no string parsing is involved. Validated against 6000 live cards.
//
//   2. For fields with no ObjectId equivalent (updatedAt, appliedDate) the
//      string has to be parsed, so parseLocaleDateMs() disambiguates using, in
//      order: a day > 12 (only DD/MM is legal), a second number > 12 (only
//      MM/DD is legal), then the MERIDIEM CASE, which is a reliable tell
//      because en-IN lowercases it and en-US uppercases it. Measured against
//      ObjectId ground truth over 6000 cards: MM/DD 87.1%, DD/MM 74.3%,
//      meridiem-aware 91.8%.
//
//   3. Whatever survives step 2 is CLAMPED against the ObjectId time. A card
//      cannot have been updated before it was created, and cannot be updated
//      in the future. A misparse almost always violates one of those, so the
//      clamp catches the residue that the meridiem tell misses and falls back
//      to the creation time rather than inventing an order.
//
// Callers should use `activityAt` for ordering and never re-parse the strings.

/** Tolerated clock skew ahead of "now" before a parsed date is called bogus. */
const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

const IST_OFFSET_MS = 330 * 60 * 1000; // UTC+05:30, fixed - India has no DST

/**
 * Creation time straight out of the ObjectId. Exact, and the only timestamp
 * here that involves no guessing whatsoever.
 * @returns {number|null} epoch ms, or null when the id is not an ObjectId.
 */
export function objectIdTimeMs(id) {
  if (!id) return null;
  try {
    if (typeof id.getTimestamp === "function") {
      const t = id.getTimestamp();
      const ms = t instanceof Date ? t.getTime() : Number(t);
      return Number.isFinite(ms) ? ms : null;
    }
    // A lean() read or a JSON round-trip hands back the 24-char hex string.
    const hex = String(id);
    if (!/^[0-9a-fA-F]{24}$/.test(hex)) return null;
    return parseInt(hex.slice(0, 8), 16) * 1000;
  } catch {
    return null;
  }
}

/**
 * Parse one of the stored locale date strings to epoch ms.
 *
 * Returns null rather than a guess when the string cannot be read, so callers
 * can fall back to the ObjectId instead of silently sorting on epoch 0 - which
 * is what the old parsers did, and why deleted 1970 cards floated to the top.
 *
 * @param {string|number|Date} raw
 * @returns {number|null}
 */
export function parseLocaleDateMs(raw) {
  if (raw == null || raw === "") return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.getTime();
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;

  const s = String(raw).trim();
  if (!s) return null;

  // ISO first - unambiguous, and already carries its own offset.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }

  // Date-only ISO, e.g. "2026-08-22". Read as IST midnight rather than UTC
  // midnight, or every such row lands 5.5 hours early and can fall out of the
  // reporting window it belongs to.
  const isoDateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDateOnly) {
    const y = Number(isoDateOnly[1]);
    const mo = Number(isoDateOnly[2]);
    const da = Number(isoDateOnly[3]);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    return Date.UTC(y, mo - 1, da, 0, 0, 0) - IST_OFFSET_MS;
  }

  const parts = s.split(",");
  // A date with no time at all. 644 appliedDate rows look like "24/3/2026" -
  // written by a path that formatted the date only. There is no comma and no
  // meridiem, so the branch below (which requires both) used to drop straight
  // through to `new Date("24/3/2026")`, which Node reads as Invalid Date. That
  // silently hid 644 applied cards from every reader that asks "was this
  // applied in the window". Treated as IST midnight on that day.
  if (parts.length === 1 && /^\d{1,4}\/\d{1,2}\/\d{2,4}$/.test(s)) {
    const nums = s.split("/").map((p) => parseInt(p.trim(), 10));
    if (nums.length === 3 && !nums.some((n) => Number.isNaN(n))) {
      let dd;
      let mm;
      let yyyy = nums[2];
      if (nums[0] > 12) {
        dd = nums[0];
        mm = nums[1];
      } else if (nums[1] > 12) {
        mm = nums[0];
        dd = nums[1];
      } else {
        // Genuinely ambiguous and no meridiem to break the tie. Every date-only
        // row in the collection was written after the en-IN switchover, so D/M
        // is the right default here - unlike the timestamped strings, where the
        // en-US era is large and the meridiem case decides.
        dd = nums[0];
        mm = nums[1];
      }
      if (yyyy < 100) yyyy += 2000;
      if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12 && yyyy >= 1970) {
        return Date.UTC(yyyy, mm - 1, dd, 0, 0, 0) - IST_OFFSET_MS;
      }
    }
  }
  if (parts.length === 2) {
    const nums = parts[0].trim().split("/").map((p) => parseInt(p.trim(), 10));
    const time = parts[1].trim().match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|AM|PM)?/);

    if (nums.length === 3 && !nums.some((n) => Number.isNaN(n)) && time) {
      const rawMeridiem = time[4] || "";
      let dd;
      let mm;
      let yyyy = nums[2];

      if (nums[0] > 12) {
        // Only DD/MM can be read this way.
        dd = nums[0];
        mm = nums[1];
      } else if (nums[1] > 12) {
        // Only MM/DD can be read this way.
        mm = nums[0];
        dd = nums[1];
      } else if (rawMeridiem && rawMeridiem === rawMeridiem.toLowerCase()) {
        // Ambiguous, lowercase meridiem: en-IN wrote it, so D/M.
        dd = nums[0];
        mm = nums[1];
      } else {
        // Ambiguous, uppercase or absent meridiem: en-US wrote it, so M/D.
        // An absent meridiem lands here too. No timestamped row in the
        // collection is missing one today, so this branch is a safety net
        // rather than a real case.
        mm = nums[0];
        dd = nums[1];
      }

      if (yyyy < 100) yyyy += 2000;

      if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12 && yyyy >= 1970) {
        let hour = parseInt(time[1], 10);
        const minute = parseInt(time[2], 10);
        const second = time[3] ? parseInt(time[3], 10) : 0;
        const meridiem = rawMeridiem.toLowerCase();
        if (meridiem === "pm" && hour !== 12) hour += 12;
        if (meridiem === "am" && hour === 12) hour = 0;

        if (!Number.isNaN(hour) && !Number.isNaN(minute) && hour <= 23 && minute <= 59) {
          // Every one of these strings was produced with timeZone Asia/Kolkata,
          // so the wall-clock reading has to be shifted back to UTC.
          const ms = Date.UTC(yyyy, mm - 1, dd, hour, minute, second) - IST_OFFSET_MS;
          if (Number.isFinite(ms)) return ms;
        }
      }
    }
  }

  const native = new Date(s);
  return Number.isNaN(native.getTime()) ? null : native.getTime();
}

/**
 * Clamp a parsed timestamp into the only window it could legitimately fall in.
 * Anything outside is a misparse, and the creation time is a better answer than
 * a wrong one.
 */
function sane(ms, createdAtMs, nowMs) {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (createdAtMs != null && ms < createdAtMs) return null; // before it existed
  if (ms > nowMs + FUTURE_SKEW_MS) return null; // after the end of time
  return ms;
}

/**
 * Machine-readable timestamps for one job card.
 *
 * @param {object} job         a lean JobModel document
 * @param {number} [nowMs]     injectable for tests
 * @returns {{createdAtMs:number, updatedAtMs:number, appliedAtMs:number|null, activityAt:number}}
 */
export function computeJobTimes(job, nowMs = Date.now()) {
  const fromId = objectIdTimeMs(job?._id);

  // Fall back to the strings only when there is no usable ObjectId, which in
  // practice means a synthesised or hand-inserted document.
  const createdAtMs =
    fromId ??
    sane(parseLocaleDateMs(job?.createdAt), null, nowMs) ??
    sane(parseLocaleDateMs(job?.dateAdded), null, nowMs) ??
    0;

  const updatedAtMs = sane(parseLocaleDateMs(job?.updatedAt), createdAtMs, nowMs) ?? createdAtMs;
  const appliedAtMs = sane(parseLocaleDateMs(job?.appliedDate), createdAtMs, nowMs);

  // "Latest thing that happened to this card." A card added nine days ago and
  // moved to Interviewing this morning is more recent ACTIVITY than one added
  // today and never touched, which is what the Recent Activities panel is
  // actually meant to rank by.
  const activityAt = Math.max(createdAtMs, updatedAtMs, appliedAtMs ?? 0);

  return { createdAtMs, updatedAtMs, appliedAtMs, activityAt };
}

/** True for a card the client should not be shown as recent activity. */
export function isRemovedStatus(currentStatus) {
  return /^(deleted|removed)/i.test(String(currentStatus || "").trim());
}

/**
 * Strip the operator attribution the backend appends to currentStatus.
 *
 * UpdateChanges.js turns "applied" into "applied by Shubhangi" so operations
 * can see who moved a card. That is internal. A CLIENT opening their dashboard
 * must never be shown the name of the staff member working their account, and
 * this is the single place that decision is enforced for API responses.
 */
export function publicStatus(currentStatus) {
  const s = String(currentStatus || "").trim();
  if (!s) return "saved";
  if (isRemovedStatus(s)) return "removed";
  return s.replace(/\s+by\s+.*$/i, "").trim() || "saved";
}
