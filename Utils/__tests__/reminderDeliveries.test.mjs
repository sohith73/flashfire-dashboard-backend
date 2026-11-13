// Covers the reminder delivery history (POST /operations/reminders/deliveries),
// its "next scheduled send" line, and the rule that every active client gets a
// daily-summary config.

import test from "node:test";
import assert from "node:assert/strict";
import { parseDeliveryQuery, MAX_PAGE_SIZE } from "../reminderDeliveryQuery.js";

const isItem = (k) => ["daily_summary", "inactivity_alert"].includes(k);
const C = "client@x.com";

test("defaults: one client, every status, page 1 of 25", () => {
  const q = parseDeliveryQuery({ clientEmail: "Client@X.com" }, isItem);
  assert.equal(q.ok, true);
  assert.deepEqual(q.filter, { clientEmail: C });
  assert.equal(q.page, 1);
  assert.equal(q.pageSize, 25);
});

test("delivered means sent or partial, and counts ignore the status filter", () => {
  const q = parseDeliveryQuery({ clientEmail: C, status: "delivered", itemKey: "daily_summary" }, isItem);
  assert.deepEqual(q.filter, { clientEmail: C, itemKey: "daily_summary", status: { $in: ["sent", "partial"] } });
  assert.deepEqual(q.countsFilter, { clientEmail: C, itemKey: "daily_summary" });
});

test("dates are whole IST days, both ends inclusive", () => {
  const q = parseDeliveryQuery({ clientEmail: C, from: "2026-11-12", to: "2026-11-12" }, isItem);
  assert.equal(q.filter.at.$gte.toISOString(), "2026-11-11T18:30:00.000Z");
  assert.equal(q.filter.at.$lt.toISOString(), "2026-11-12T18:30:00.000Z");
});

test("bad input is refused with a reason, not silently widened", () => {
  const bad = (b) => parseDeliveryQuery({ clientEmail: C, ...b }, isItem).ok;
  assert.equal(parseDeliveryQuery({}, isItem).ok, false, "clientEmail is required");
  assert.equal(parseDeliveryQuery({ clientEmail: "not-an-email" }, isItem).ok, false);
  assert.equal(bad({ status: "delivered!" }), false);
  assert.equal(bad({ itemKey: "weekly_report" }), false);
  assert.equal(bad({ from: "2026-02-31" }), false);
  assert.equal(bad({ from: "12/11/2026" }), false);
  assert.equal(bad({ from: "2026-11-12", to: "2026-11-01" }), false);
});

test("paging is clamped, and other clients can never be listed", () => {
  const q = parseDeliveryQuery({ clientEmail: C, page: "3", pageSize: 5000, search: "other" }, isItem);
  assert.equal(q.page, 3);
  assert.equal(q.pageSize, MAX_PAGE_SIZE);
  assert.deepEqual(q.filter, { clientEmail: C }, "a stray search field must not widen the query");
  assert.equal(parseDeliveryQuery({ clientEmail: C, page: -2, pageSize: 0 }, isItem).page, 1);
});

// ---- coverage: every active client gets a config ---------------------------

const { ensureActiveClientConfigs, nextScheduledSend } = await import("../../src/services/clientReminderWorker.js");
const { reminderItemMeta, defaultItemConfig } = await import("../reminderItems.js");

// ---- the "next scheduled send" line -------------------------------------------

const daily = reminderItemMeta("daily_summary");
const ist = (s) => new Date(`${s}+05:30`);

test("before 21:30 IST the next send is today at 21:30", () => {
  const next = nextScheduledSend(defaultItemConfig("daily_summary"), daily, ist("2026-11-13T11:00:00"));
  assert.equal(next.at.toISOString(), ist("2026-11-13T21:30:00").toISOString());
  assert.equal(next.dueNow, false);
});

test("once today is decided (sent or skipped), the next send is tomorrow", () => {
  const item = { ...defaultItemConfig("daily_summary"), lastPeriodKey: "daily_summary:2026-11-13" };
  const next = nextScheduledSend(item, daily, ist("2026-11-13T21:40:00"));
  assert.equal(next.at.toISOString(), ist("2026-11-14T21:30:00").toISOString());
});

test("past the time with today still open, it is due on the next tick", () => {
  const next = nextScheduledSend(defaultItemConfig("daily_summary"), daily, ist("2026-11-13T21:32:00"));
  assert.equal(next.dueNow, true);
});

test("a switched-off item, or one with no channel, has nothing scheduled", () => {
  const now = ist("2026-11-13T11:00:00");
  assert.equal(nextScheduledSend({ ...defaultItemConfig("daily_summary"), enabled: false }, daily, now), null);
  const noChannel = { ...defaultItemConfig("daily_summary"), channels: { email: false, mattermost: false } };
  assert.equal(nextScheduledSend(noChannel, daily, now), null);
});

function fakeModel(existingEmails) {
  const calls = { bulk: null };
  return {
    calls,
    find: () => ({ select: () => ({ lean: async () => existingEmails.map((clientEmail) => ({ clientEmail })) }) }),
    bulkWrite: async (ops) => {
      calls.bulk = ops;
      return { upsertedCount: ops.length };
    }
  };
}

test("active clients without a config get the defaults; existing ones (opt-outs too) are untouched", async () => {
  const model = fakeModel(["has@x.com", "optedout@x.com"]);
  const created = await ensureActiveClientConfigs({
    listActive: async () => [
      { email: "has@x.com", name: "Has" },
      { email: "optedout@x.com", name: "Opted" },
      { email: "new@x.com", name: "New Client" },
      { email: "broken", name: "No Email" }
    ],
    model
  });
  assert.equal(created, 1);
  assert.equal(model.calls.bulk.length, 1);
  const op = model.calls.bulk[0].updateOne;
  assert.deepEqual(op.filter, { clientEmail: "new@x.com" });
  assert.equal(op.upsert, true);
  assert.deepEqual(Object.keys(op.update), ["$setOnInsert"], "must never overwrite an existing config");
  const daily = op.update.$setOnInsert.items.find((i) => i.key === "daily_summary");
  assert.equal(daily.enabled, true);
  assert.equal(daily.channels.email, true);
});

test("nothing to create means no write, and a lookup failure never throws", async () => {
  const model = fakeModel(["a@x.com"]);
  assert.equal(await ensureActiveClientConfigs({ listActive: async () => [{ email: "a@x.com" }], model }), 0);
  assert.equal(model.calls.bulk, null);
  assert.equal(
    await ensureActiveClientConfigs({ listActive: async () => { throw new Error("db down"); }, model }),
    0
  );
});
