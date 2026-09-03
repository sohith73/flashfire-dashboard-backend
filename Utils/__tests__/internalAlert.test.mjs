// The internal-alert routing policy, locked down.
//
// The no-activity alert exists to tell OPERATIONS that a client's account went
// quiet. Delivered to the client instead, the same words read as a confession.
// These tests pin the three layers that keep it internal: the catalogue flag,
// the email-destination resolver, and the template's own labelling.
//
// Pure functions only. No Mongo, no network.

import assert from "node:assert/strict";
import test from "node:test";

const { REMINDER_ITEMS, reminderItemMeta, defaultItemConfig } = await import("../reminderItems.js");
const { resolveInternalAlertEmail } = await import("../../src/services/clientReminderWorker.js");
const { renderReminderEmail } = await import("../reminderTemplates.js");

test("internal alert routing", async (t) => {
  await t.test("inactivity_alert is flagged internal, and is the only internal item", () => {
    assert.equal(reminderItemMeta("inactivity_alert").internal, true);
    // A new internal item must be a deliberate act, not an accident of copy-paste:
    // every internal item bypasses the client's payment email entirely.
    assert.deepEqual(
      REMINDER_ITEMS.filter((i) => i.internal === true).map((i) => i.key),
      ["inactivity_alert"]
    );
  });

  await t.test("its email channel ships OFF by default", () => {
    // Mattermost-first. Email to the team inbox is an opt-in, and email to the
    // client is impossible regardless (the worker routes internal items away
    // from the payment address before any send).
    const d = defaultItemConfig("inactivity_alert");
    assert.equal(d.channels.email, false);
    assert.equal(d.channels.mattermost, true);
    assert.equal(d.enabled, false, "the whole item is off until an operator turns it on");
  });

  await t.test("resolveInternalAlertEmail returns the SMTP account, and never invents one", () => {
    // We mail ourselves from the account we send from. No separate env var, so
    // there is nothing extra to configure and nothing that can be set in one
    // environment and forgotten in another.
    const saved = process.env.SMTP_USER;
    try {
      process.env.SMTP_USER = "support@flashfirejobs.com";
      assert.equal(resolveInternalAlertEmail(), "support@flashfirejobs.com");

      // Case is normalised, so a stray capital in .env still matches.
      process.env.SMTP_USER = "Support@FlashFireJobs.com";
      assert.equal(resolveInternalAlertEmail(), "support@flashfirejobs.com");

      // A malformed value is not an address. Better to send nothing than to
      // send somewhere unintended.
      process.env.SMTP_USER = "not-an-address";
      assert.equal(resolveInternalAlertEmail(), "");

      delete process.env.SMTP_USER;
      assert.equal(resolveInternalAlertEmail(), "", "no SMTP account means no send, never a guess");
    } finally {
      if (saved === undefined) delete process.env.SMTP_USER;
      else process.env.SMTP_USER = saved;
    }
  });

  await t.test("the rendered mail is unmistakably internal on its face", () => {
    const out = renderReminderEmail({
      kind: "inactivity_alert",
      client: { name: "Rijul Jain", email: "rijuljain17@gmail.com" },
      stats: { addedCount: 0, appliedCount: 0, isEmpty: true },
      lifetime: {},
      period: { label: "19 Aug - 22 Aug 2026" },
      extra: { days: 4 }
    });
    // Belt and braces: even if a routing bug ever delivered it to the wrong
    // inbox, the subject and body say what it is instead of masquerading as a
    // client report.
    assert.ok(out.subject.startsWith("[Internal]"), out.subject);
    assert.ok(out.html.includes("not sent to the client"));
  });
});
