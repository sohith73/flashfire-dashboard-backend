// Ordering and client-facing status for job cards.
//
// The bug these lock down: the dashboard's Recent Activities panel sorted on a
// locale string using "MM/DD unless the first number is > 12". The collection
// is a MIX of en-US (M/D, uppercase meridiem), en-IN (D/M, lowercase meridiem)
// and ISO - measured live as 2954 / 1002 / 44 out of 4000 cards - so that rule
// silently threw 98 of one client's 265 cards into the wrong month, and April
// cards outranked May ones on the client's own dashboard.
//
// Pure functions only. No Mongo, no network.

import assert from "node:assert/strict";
import test from "node:test";

const { objectIdTimeMs, parseLocaleDateMs, computeJobTimes, isRemovedStatus, publicStatus } =
  await import("../jobActivityTime.js");

const IST = (y, m, d, hh, mm, ss = 0) => Date.UTC(y, m - 1, d, hh, mm, ss) - 330 * 60 * 1000;

// A 24-hex ObjectId whose leading 4 bytes encode `seconds`.
const oid = (seconds) => seconds.toString(16).padStart(8, "0") + "0011223344556677";

test("jobActivityTime", async (t) => {
  await t.test("objectIdTimeMs reads the embedded insert time exactly", () => {
    const secs = Math.floor(Date.UTC(2026, 7, 22, 6, 30, 0) / 1000);
    assert.equal(objectIdTimeMs(oid(secs)), secs * 1000);
    assert.equal(objectIdTimeMs({ getTimestamp: () => new Date(1234567890000) }), 1234567890000);
    for (const junk of [null, undefined, "", "nope", 42, {}]) {
      assert.equal(objectIdTimeMs(junk), null, `${JSON.stringify(junk)} is not an ObjectId`);
    }
  });

  await t.test("an unambiguous day > 12 can only be DD/MM", () => {
    // 23/4/2026 - there is no 23rd month, so this is 23 April whatever wrote it.
    assert.equal(parseLocaleDateMs("23/4/2026, 6:09:33 pm"), IST(2026, 4, 23, 18, 9, 33));
    assert.equal(parseLocaleDateMs("23/4/2026, 6:09:33 PM"), IST(2026, 4, 23, 18, 9, 33));
  });

  await t.test("an unambiguous second number > 12 can only be MM/DD", () => {
    // 7/27/2026 - there is no 27th month either.
    assert.equal(parseLocaleDateMs("7/27/2026, 1:38:47 PM"), IST(2026, 7, 27, 13, 38, 47));
    assert.equal(parseLocaleDateMs("7/27/2026, 1:38:47 pm"), IST(2026, 7, 27, 13, 38, 47));
  });

  await t.test("the meridiem case disambiguates when both numbers are <= 12", () => {
    // THE ACTUAL BUG. Both readings are legal, so the case of the meridiem is
    // the tell: Node's en-IN prints "pm", en-US prints "PM". Confirmed in this
    // runtime, and it lifted the parse from 87.1% to 91.8% against ObjectId
    // ground truth over 6000 live cards.
    assert.equal(parseLocaleDateMs("1/5/2026, 3:59:09 pm"), IST(2026, 5, 1, 15, 59, 9), "en-IN is 1 May");
    assert.equal(parseLocaleDateMs("1/5/2026, 3:59:09 PM"), IST(2026, 1, 5, 15, 59, 9), "en-US is 5 January");
    // The old code read BOTH as 5 January. Prove the two now differ at all.
    assert.notEqual(
      parseLocaleDateMs("1/5/2026, 3:59:09 pm"),
      parseLocaleDateMs("1/5/2026, 3:59:09 PM")
    );
  });

  await t.test("midnight and noon meridiem conversion", () => {
    assert.equal(parseLocaleDateMs("23/4/2026, 12:00:00 am"), IST(2026, 4, 23, 0, 0, 0), "12am is 00:00");
    assert.equal(parseLocaleDateMs("23/4/2026, 12:00:00 pm"), IST(2026, 4, 23, 12, 0, 0), "12pm is 12:00");
  });

  await t.test("ISO passes straight through and junk returns null, never epoch 0", () => {
    assert.equal(parseLocaleDateMs("2025-08-29T15:32:35.351Z"), Date.parse("2025-08-29T15:32:35.351Z"));
    assert.equal(parseLocaleDateMs(new Date(999)), 999);
    assert.equal(parseLocaleDateMs(999), 999);
    // Returning null rather than 0 is the point: a 1970 fallback sorted broken
    // rows to the TOP of a descending list, which is how a deleted card with an
    // unreadable date became the client's most recent activity.
    for (const junk of ["", null, undefined, "not a date", "//,"]) {
      assert.equal(parseLocaleDateMs(junk), null, `${JSON.stringify(junk)} must be null`);
    }
  });

  await t.test("createdAtMs always comes from the ObjectId, never the string", () => {
    const secs = Math.floor(Date.UTC(2026, 4, 1, 10, 29, 9) / 1000);
    // The string disagrees with the id on purpose. The id wins.
    const times = computeJobTimes({ _id: oid(secs), dateAdded: "1/1/2020, 1:00:00 PM", createdAt: "rubbish" });
    assert.equal(times.createdAtMs, secs * 1000);
  });

  await t.test("an impossible updatedAt is clamped back to creation, not trusted", () => {
    const secs = Math.floor(Date.UTC(2026, 4, 1, 10, 0, 0) / 1000);
    const now = Date.UTC(2026, 7, 22, 12, 0, 0);
    // Misparsed into the past, before the card existed.
    const past = computeJobTimes({ _id: oid(secs), updatedAt: "1/1/2019, 1:00:00 PM" }, now);
    assert.equal(past.updatedAtMs, secs * 1000, "pre-creation update is discarded");
    assert.equal(past.activityAt, secs * 1000);
    // Misparsed into the far future.
    const future = computeJobTimes({ _id: oid(secs), updatedAt: "1/1/2099, 1:00:00 PM" }, now);
    assert.equal(future.updatedAtMs, secs * 1000, "future update is discarded");
    // activityAt can never precede creation or exceed now + 1 day.
    for (const times of [past, future]) {
      assert.ok(times.activityAt >= times.createdAtMs);
      assert.ok(times.activityAt <= now + 24 * 60 * 60 * 1000);
    }
  });

  await t.test("activityAt ranks by the latest thing that happened, not by creation", () => {
    const created = Math.floor(Date.UTC(2026, 7, 13, 6, 0, 0) / 1000); // 9 days ago
    const now = Date.UTC(2026, 7, 22, 12, 0, 0);
    // Added nine days ago, moved to interviewing at 09:15 IST (03:45 UTC).
    const moved = computeJobTimes({ _id: oid(created), updatedAt: "22/8/2026, 9:15:00 am" }, now);
    // Added today at 07:30 IST (02:00 UTC) and never touched since. Both
    // instants are stated in UTC here on purpose: an earlier version of this
    // fixture compared 09:15 IST against 05:00 UTC and quietly had the fresh
    // card winning, which tested nothing.
    const freshSecs = Math.floor(Date.UTC(2026, 7, 22, 2, 0, 0) / 1000);
    const fresh = computeJobTimes({ _id: oid(freshSecs) }, now);
    assert.ok(fresh.activityAt > created * 1000, "the fresh card really is newer by creation");
    assert.ok(
      moved.activityAt > fresh.activityAt,
      "a card that reached interviewing today outranks one merely added today"
    );
  });

  await t.test("removal detection covers every variant the backend writes", () => {
    for (const s of ["deleted", "removed", "deleted by AI", "removed by user", "Deleted By Ops", "  removed  "]) {
      assert.equal(isRemovedStatus(s), true, `${JSON.stringify(s)} is a removal`);
    }
    for (const s of ["applied", "saved by Ops", "interviewing", "", null, undefined]) {
      assert.equal(isRemovedStatus(s), false, `${JSON.stringify(s)} is not a removal`);
    }
  });

  await t.test("publicStatus never leaks an operator name to the client", () => {
    // The panel rendered currentStatus verbatim, so clients were reading the
    // name of the staff member working their account.
    assert.equal(publicStatus("applied by shubhangi"), "applied");
    assert.equal(publicStatus("Saved by Ops"), "Saved");
    assert.equal(publicStatus("applied by Mary Jane Watson"), "applied");
    assert.equal(publicStatus("interviewing"), "interviewing");
    assert.equal(publicStatus("offer received"), "offer received", "a non-attribution word survives");
    assert.equal(publicStatus("deleted by AI"), "removed");
    assert.equal(publicStatus(""), "saved");
    assert.equal(publicStatus(null), "saved");
    for (const s of ["applied by shubhangi", "Saved by Ops", "deleted by AI"]) {
      assert.ok(!/\bby\b/i.test(publicStatus(s)), `${JSON.stringify(s)} must not keep an attribution`);
    }
  });
});
