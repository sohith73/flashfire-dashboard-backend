// The daily summary's threshold auto-send: "once N roles are added, mail the
// client a set delay later, instead of waiting for the scheduled time".
//
// The property that matters most is ONCE PER DAY. Both triggers write the same
// daily period key, so whichever fires first consumes the day and the other
// becomes a no-op. Without that, a client whose fifth role lands at 15:40 would
// get the summary then AND again at 21:30.
//
// Pure functions only. No Mongo, no network.

import assert from "node:assert/strict";
import test from "node:test";

const { defaultItemConfig, reminderItemMeta, REMINDER_ITEM_KEYS } = await import("../reminderItems.js");
const { isThresholdAutoDue, isItemDue, periodKeyFor } = await import("../../src/services/clientReminderWorker.js");
const { sanitizeItemsInput } = await import("../../Schema_Models/ClientReminderConfig.js");

const DAILY = reminderItemMeta("daily_summary");
const IDLE = reminderItemMeta("inactivity_alert");

/** 26 Aug 2026 at HH:MM IST, as the UTC instant. */
const ist = (h, m = 0) => new Date(Date.UTC(2026, 7, 26, h, m, 0) - 330 * 60 * 1000);

const item = (over = {}) => ({ ...defaultItemConfig("daily_summary"), autoOnThreshold: true, ...over });

test("threshold auto-send", async (t) => {
  await t.test("the retired report types are gone from the catalogue", () => {
    for (const gone of ["monthly_report", "plan_usage", "weekly_report", "interview_digest", "milestone"]) {
      assert.ok(!REMINDER_ITEM_KEYS.includes(gone), `${gone} must be removed`);
      assert.equal(reminderItemMeta(gone), null, `${gone} has no metadata`);
      assert.equal(defaultItemConfig(gone), null, `${gone} has no default config`);
    }
    assert.deepEqual(REMINDER_ITEM_KEYS, ["daily_summary", "inactivity_alert"]);
  });

  await t.test("off by default, and never fires while switched off", () => {
    assert.equal(defaultItemConfig("daily_summary").autoOnThreshold, false);
    assert.equal(
      isThresholdAutoDue({
        item: item({ autoOnThreshold: false }),
        meta: DAILY,
        addedCount: 50,
        nthAt: ist(9),
        now: ist(20)
      }),
      false,
      "a switched-off item never auto-sends however many roles land"
    );
  });

  await t.test("fires only once the count is reached AND the delay has elapsed", () => {
    const it = item({ autoThresholdCount: 5, autoDelayMinutes: 60 });
    // Fifth role at 14:00, so the mail is due from 15:00.
    const nthAt = ist(14);

    assert.equal(
      isThresholdAutoDue({ item: it, meta: DAILY, addedCount: 4, nthAt: null, now: ist(16) }),
      false,
      "four roles is not five"
    );
    assert.equal(
      isThresholdAutoDue({ item: it, meta: DAILY, addedCount: 5, nthAt, now: ist(14, 59) }),
      false,
      "one minute early"
    );
    assert.equal(
      isThresholdAutoDue({ item: it, meta: DAILY, addedCount: 5, nthAt, now: ist(15, 0) }),
      true,
      "exactly on the delay boundary"
    );
    assert.equal(
      isThresholdAutoDue({ item: it, meta: DAILY, addedCount: 9, nthAt, now: ist(18) }),
      true,
      "later roles do not push the clock back"
    );
  });

  await t.test("the delay is measured from the Nth role, not the newest one", () => {
    // A trickle of roles all afternoon must not reset the timer, or the mail
    // never goes out at all.
    const it = item({ autoThresholdCount: 5, autoDelayMinutes: 60 });
    const fifthAt = ist(10);
    assert.equal(
      isThresholdAutoDue({ item: it, meta: DAILY, addedCount: 40, nthAt: fifthAt, now: ist(11, 1) }),
      true,
      "still due an hour after the FIFTH role, whatever landed since"
    );
  });

  await t.test("once the day is consumed, the auto-send stops - no double delivery", () => {
    const key = periodKeyFor("daily_summary", ist(15));
    const it = item({ autoThresholdCount: 5, autoDelayMinutes: 60, lastPeriodKey: key });
    assert.equal(
      isThresholdAutoDue({ item: it, meta: DAILY, addedCount: 20, nthAt: ist(9), now: ist(15) }),
      false,
      "the auto path respects the period key"
    );
    // And the scheduled path, at its own time, is equally blocked - so a client
    // whose auto-send already fired does NOT get a second mail at 21:30.
    assert.equal(isItemDue(it, DAILY, ist(21, 30)), false, "the clock path is blocked too");
    // Sanity: with the key cleared, the scheduled path would have fired.
    assert.equal(isItemDue({ ...it, lastPeriodKey: "" }, DAILY, ist(21, 30)), true);
  });

  await t.test("an item that never opted in does not auto-send, whatever its cadence", () => {
    // inactivity_alert is daily too, but it declares no autoOnThreshold field
    // and defaults to false, so the threshold path must leave it alone.
    assert.equal(
      isThresholdAutoDue({
        item: { ...item(), key: "inactivity_alert", autoOnThreshold: false },
        meta: IDLE,
        addedCount: 99,
        nthAt: ist(9),
        now: ist(20)
      }),
      false,
      "an item with the automation off never auto-sends"
    );
  });

  await t.test("malformed input never fires, and never throws", () => {
    const it = item();
    for (const bad of [null, undefined, "not a date", NaN, 0]) {
      assert.equal(
        isThresholdAutoDue({ item: it, meta: DAILY, addedCount: 10, nthAt: bad, now: ist(20) }),
        false,
        `nthAt=${JSON.stringify(bad)} must not fire`
      );
    }
    assert.equal(isThresholdAutoDue({ item: null, meta: DAILY, addedCount: 10, nthAt: ist(9) }), false);
    assert.equal(isThresholdAutoDue({ item: it, meta: null, addedCount: 10, nthAt: ist(9) }), false);
    assert.equal(
      isThresholdAutoDue({ item: it, meta: DAILY, addedCount: NaN, nthAt: ist(9), now: ist(20) }),
      false,
      "an unknown count is not a reached threshold"
    );
  });

  await t.test("operator input is clamped into a sendable range", () => {
    const one = (over) =>
      sanitizeItemsInput([{ key: "daily_summary", ...over }], []).find((i) => i.key === "daily_summary");
    // 1 would mail on the first role of the day, which is noise.
    assert.equal(one({ autoThresholdCount: 1 }).autoThresholdCount, 2);
    assert.equal(one({ autoThresholdCount: 9999 }).autoThresholdCount, 200);
    assert.equal(one({ autoDelayMinutes: -30 }).autoDelayMinutes, 0);
    // A delay past the end of the IST day would roll the period key over and
    // the mail would never be sent, so it is capped well inside one day.
    assert.equal(one({ autoDelayMinutes: 5000 }).autoDelayMinutes, 720);
    assert.equal(one({ autoThresholdCount: "abc" }).autoThresholdCount, 5, "garbage falls back to the default");
  });
});
