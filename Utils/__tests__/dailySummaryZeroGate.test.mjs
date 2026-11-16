// "Daily update: 0 new roles added" must never leave the building.
//
// On 14 Sept 2026 a client received exactly that. The item is activityGated,
// but the gate asked "was anything added OR applied today?" while the mail
// prints one figure: roles added. A day with zero added and some applications
// therefore passed the gate and mailed a headline of 0.
//
// Two properties are locked down here:
//   1. zero roles added = no send, whatever else happened that day
//   2. no override. 'nothing_added' is absent from FORCEABLE_REASONS, so the
//      Send-anyway button in Operations cannot push it out either.
//
// Pure functions only. No Mongo, no network.

import assert from "node:assert/strict";
import test from "node:test";

const { defaultItemConfig, reminderItemMeta } = await import("../reminderItems.js");
const { decideDelivery, FORCEABLE_REASONS } = await import("../../src/services/clientReminderWorker.js");

const META = reminderItemMeta("daily_summary");
const ITEM = defaultItemConfig("daily_summary");
const LIFETIME = { totalJobs: 412, totalApplied: 337 };

const stats = (addedCount, appliedCount) => ({
  addedCount,
  appliedCount,
  isEmpty: addedCount === 0 && appliedCount === 0
});

const decide = (st) => decideDelivery({ meta: META, item: ITEM, stats: st, lifetime: LIFETIME });

test("the catalogue gates the daily summary on roles added", () => {
  assert.equal(META.activityGated, true);
  assert.equal(META.gateOn, "added", "the gate must follow the number the mail prints");
});

test("zero roles added is a skip even when the client applied that day", () => {
  // The exact 14 Sept shape: nothing added, plenty applied, isEmpty false.
  const d = decide(stats(0, 12));
  assert.equal(d.shouldSend, false);
  assert.equal(d.reason, "nothing_added");
});

test("a completely empty day is also a skip", () => {
  const d = decide(stats(0, 0));
  assert.equal(d.shouldSend, false);
  assert.equal(d.reason, "nothing_added");
});

test("a broken stats read cannot turn into a zero-count mail", () => {
  // getClientActivityStats returns a zeroed shape on a DB failure. It must
  // land on silence, not on "0 new roles added".
  for (const st of [{}, { addedCount: null, isEmpty: true }, { addedCount: "", appliedCount: 3 }]) {
    assert.equal(decide(st).shouldSend, false, JSON.stringify(st));
  }
});

test("below 5 added or below 5 applied is a skip; 5 and 5 sends", () => {
  for (const [a, p] of [[1, 0], [4, 20], [20, 4], [4, 4]]) {
    const d = decide(stats(a, p));
    assert.equal(d.shouldSend, false, `${a} added / ${p} applied`);
    assert.equal(d.reason, "below_minimum");
    assert.deepEqual(d.extra, { added: a, applied: p, minAdded: 5, minApplied: 5 });
  }
  assert.equal(decide(stats(5, 5)).shouldSend, true);
  assert.equal(decide(stats(30, 12)).reason, "ok");
});

test("below_minimum can never be forced through", () => {
  assert.equal(FORCEABLE_REASONS.has("below_minimum"), false);
});

test("nothing_added can never be forced through", () => {
  assert.equal(FORCEABLE_REASONS.has("nothing_added"), false);
  // The neighbouring reasons are still overridable - this change must not have
  // quietly taken the operator's escape hatch away from the other items.
  assert.equal(FORCEABLE_REASONS.has("no_activity"), true);
  assert.equal(FORCEABLE_REASONS.has("client_is_active"), true);
});

test("the internal inactivity alert is untouched by the new gate", () => {
  const meta = reminderItemMeta("inactivity_alert");
  const item = defaultItemConfig("inactivity_alert");
  assert.equal(meta.gateOn, undefined, "only the daily summary opts into the stricter gate");
  // It fires BECAUSE there is no activity; a zero day must still alert.
  const d = decideDelivery({ meta, item, stats: stats(0, 0), lifetime: LIFETIME, inactivityDays: 3, daysIdle: 5 });
  assert.equal(d.shouldSend, true);
});
