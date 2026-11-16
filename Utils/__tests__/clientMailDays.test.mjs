// No client mail on Sundays (IST). Covers the shared rule, the daily summary's
// "next scheduled send" line, and the operator's send-now being held.

import test from "node:test";
import assert from "node:assert/strict";
import { isClientMailOffDay, nextClientMailInstant, CLIENT_MAIL_HOLD_REASON } from "../clientMailDays.js";

const ist = (s) => new Date(`${s}+05:30`);

test("Sunday is decided on the IST clock, midnight to midnight", () => {
  assert.equal(isClientMailOffDay(ist("2026-11-14T23:59:00")), false, "Saturday night");
  assert.equal(isClientMailOffDay(ist("2026-11-15T00:00:00")), true, "Sunday 00:00");
  assert.equal(isClientMailOffDay(ist("2026-11-15T21:30:00")), true, "Sunday 21:30");
  assert.equal(isClientMailOffDay(ist("2026-11-16T00:00:00")), false, "Monday 00:00");
  // Saturday 20:00 UTC is already Sunday 01:30 in India.
  assert.equal(isClientMailOffDay(new Date("2026-11-14T20:00:00Z")), true);
});

test("a time on Sunday moves to Monday 00:00 IST; any other day is kept", () => {
  assert.equal(nextClientMailInstant(ist("2026-11-15T10:00:00")).toISOString(), ist("2026-11-16T00:00:00").toISOString());
  const sat = ist("2026-11-14T22:00:00");
  assert.equal(nextClientMailInstant(sat).toISOString(), sat.toISOString());
});

const { nextScheduledSend, deliverReminder } = await import("../../src/services/clientReminderWorker.js");
const { reminderItemMeta, defaultItemConfig } = await import("../reminderItems.js");
const daily = reminderItemMeta("daily_summary");
const internal = reminderItemMeta("inactivity_alert");

test("the daily summary is never scheduled on a Sunday", () => {
  // Saturday after the send: tomorrow is Sunday, so Monday 21:30.
  const decided = { ...defaultItemConfig("daily_summary"), lastPeriodKey: "daily_summary:2026-11-14" };
  assert.equal(
    nextScheduledSend(decided, daily, ist("2026-11-14T22:00:00")).at.toISOString(),
    ist("2026-11-16T21:30:00").toISOString()
  );
  // On Sunday itself, before and after 21:30: Monday, never due now.
  for (const t of ["2026-11-15T09:00:00", "2026-11-15T22:00:00"]) {
    const next = nextScheduledSend(defaultItemConfig("daily_summary"), daily, ist(t));
    assert.equal(next.at.toISOString(), ist("2026-11-16T21:30:00").toISOString(), t);
    assert.equal(next.dueNow, false, t);
  }
});

test("the team's own no-activity alert still runs on Sunday", () => {
  const item = { ...defaultItemConfig("inactivity_alert"), enabled: true };
  const next = nextScheduledSend(item, internal, ist("2026-11-15T09:00:00"));
  assert.equal(next.at.toISOString(), ist("2026-11-15T11:00:00").toISOString());
});

test("send-now of the daily summary on Sunday is held before any read or send", async () => {
  const out = await deliverReminder({
    config: { clientEmail: "client@example.com", items: [] },
    itemKey: "daily_summary",
    trigger: "manual",
    now: ist("2026-11-15T12:00:00")
  });
  assert.equal(out.status, "skipped");
  assert.equal(out.reason, CLIENT_MAIL_HOLD_REASON);
  assert.equal(out.periodKey, "", "no period is used, so Monday sends as normal");
});
