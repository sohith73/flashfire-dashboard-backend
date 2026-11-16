// The "Client Emails Sent" card on the 5 AM Daily Mail Summary. Pure counting
// and rendering only; mailDailySummaryCatchUp.test.mjs covers the post.

import test from "node:test";
import assert from "node:assert/strict";

const { summarizeClientMail, buildClientMailEmbed } = await import("../../src/services/clientMailSummary.js");

const ist = (s) => new Date(`${s}+05:30`);
const since = ist("2026-11-17T05:00:00"); // Tuesday 05:00 to Wednesday 05:00
const until = ist("2026-11-18T05:00:00");
const at = ist("2026-11-17T21:30:00");

const rows = {
  since,
  until,
  reminders: [
    { clientEmail: "a@x.com", status: "sent", email: { ok: true } },
    { clientEmail: "b@x.com", status: "skipped", reason: "below_minimum" },
    { clientEmail: "c@x.com", status: "skipped", reason: "below_minimum" },
    { clientEmail: "d@x.com", status: "skipped", reason: "nothing_added" },
    { clientEmail: "e@x.com", status: "failed", email: { ok: false } },
    { clientEmail: "f@x.com", status: "partial", email: { ok: true } }
  ],
  onboarding: [
    { clientEmail: "a@x.com", steps: [{ key: "base_resume", sentAt: at }, { key: "cover_letter", sentAt: at }] },
    { clientEmail: "g@x.com", steps: [{ key: "base_resume", sentAt: ist("2026-11-10T10:00:00") }, { key: "linkedin", sentAt: at }] }
  ],
  milestones: [
    { clientEmail: "H@x.com", status: "success" },
    { clientEmail: "i@x.com", status: "failed" }
  ],
  useful: [
    { ownerEmail: "j@x.com", clientNotifyEligible: true, clientNotifiedAt: at },
    { ownerEmail: "j@x.com", clientNotifyEligible: true, clientNotifiedAt: at },
    { gmailEmail: "k@x.com", clientNotifyEligible: true, clientNotifySkippedReason: "inbox_alerts_off" },
    { ownerEmail: "l@x.com", clientNotifyEligible: true },
    { ownerEmail: "m@x.com", clientNotifyEligible: true, clientNotifyError: "smtp 421" },
    { ownerEmail: "n@x.com", clientNotifyEligible: false }
  ]
};

test("counts distinct clients emailed across every kind", () => {
  const s = summarizeClientMail(rows);
  // a, f (daily) + a, g (onboarding) + h (milestone) + j (alerts) = a f g h j
  assert.equal(s.clientsEmailed, 5);
  assert.deepEqual(s.daily, { sent: 2, below5: 2, noneAdded: 1, otherSkip: 0, failed: 1 });
  assert.deepEqual(s.onboarding, { emails: 3, clients: 2 }, "only steps sent inside the window count");
  assert.deepEqual(s.milestones, { sent: 1, failed: 1, clients: 1 });
  assert.equal(s.alerts.useful, 6);
  assert.equal(s.alerts.emailed, 2);
  assert.equal(s.alerts.clients, 1);
  assert.equal(s.alerts.waiting, 1);
  assert.equal(s.alerts.failed, 1);
  assert.equal(s.alerts.notSent, 1);
  assert.equal(s.alerts.notForClient, 1);
  assert.equal(s.sundayInWindow, false);
});

test("the card says it in plain words, below 5 included", () => {
  const e = buildClientMailEmbed(summarizeClientMail(rows));
  const by = Object.fromEntries(e.fields.map((f) => [f.name, f.value]));
  assert.equal(by["👥 Clients emailed"], "5");
  assert.equal(
    by["⭐ Clients told about the useful mails"],
    "2 of 6 emailed to 1 client · 1 waiting to send · 1 failed · 1 not sent (1 alerts off) · 1 team only"
  );
  assert.equal(by["📊 Daily activity summary"], "2 clients emailed · 2 below 5 · 1 no roles added · 1 failed");
  assert.equal(by["🧾 Onboarding"], "3 emails to 2 clients");
  assert.equal(by["🏁 Plan milestones"], "1 email to 1 client · 1 failed");
  assert.equal(e.color, 0xf59e0b, "amber when anything failed");
});

test("a quiet window reads cleanly, and a Sunday is called out", () => {
  const sunSince = ist("2026-11-15T05:00:00");
  const s = summarizeClientMail({ since: sunSince, until: ist("2026-11-16T05:00:00") });
  assert.equal(s.clientsEmailed, 0);
  assert.equal(s.sundayInWindow, true);
  const by = Object.fromEntries(buildClientMailEmbed(s).fields.map((f) => [f.name, f.value]));
  assert.equal(by["⭐ Clients told about the useful mails"], "No useful mails in this window.");
  assert.equal(by["📊 Daily activity summary"], "0 clients emailed");
  assert.equal(by["🧾 Onboarding"], "none");
  assert.match(by.Note, /Sunday/);
});

test("a read failure becomes an error card, not a missing header", () => {
  const e = buildClientMailEmbed(null, { error: "connection reset" });
  assert.match(e.description, /connection reset/);
});
