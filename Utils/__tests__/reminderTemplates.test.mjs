// Client reminder templates - the SEND POLICY, locked down.
//
// These tests exist to stop well-meaning edits from re-introducing the things
// we deliberately removed after the first version read like machine output:
// per-job link lists in recurring mail, hype copy, more than one outbound
// link. The policy itself is documented at the top of Utils/reminderTemplates.js;
// if a test here fails, read that block before changing the assertion.
//
// Pure functions only. No Mongo, no network.

import assert from "node:assert/strict";
import test from "node:test";

const { renderReminderEmail, renderReminderMattermost } = await import("../reminderTemplates.js");

const CLIENT = { name: "Rijul Jain", email: "rijuljain17@gmail.com" };

const job = (jobTitle, companyName) => ({
  jobTitle,
  companyName,
  joblink: "https://boards.greenhouse.io/acme/jobs/123",
  at: "2026-08-20T10:00:00+05:30"
});

const STATS = {
  addedCount: 5,
  appliedCount: 12,
  interviewCount: 3,
  offerCount: 1,
  rejectedCount: 2,
  removedCount: 0,
  addedJobs: [job("Staff Engineer", "Figma")],
  appliedJobs: [job("Senior Backend Engineer", "Stripe"), job("Platform Engineer", "Datadog")],
  interviewJobs: [job("Senior Backend Engineer", "Stripe"), job("Platform Engineer", "Datadog")],
  offerJobs: [job("Backend Developer", "Shopify")],
  topCompanies: [
    { name: "Stripe", count: 3 },
    { name: "Datadog", count: 2 }
  ],
  byDay: [
    { date: "2026-08-18", added: 6, applied: 9 },
    { date: "2026-08-19", added: 5, applied: 11 },
    { date: "2026-08-20", added: 6, applied: 13 }
  ],
  isEmpty: false
};

const LIFETIME = {
  totalJobs: 412,
  totalApplied: 337,
  totalInterviews: 14,
  totalOffers: 2,
  planType: "Executive",
  effectiveCap: 1200,
  remaining: 788,
  percentUsed: 34
};

const KINDS = ["daily_summary", "inactivity_alert"];

const render = (kind, over = {}) =>
  renderReminderEmail({
    kind,
    client: CLIENT,
    stats: STATS,
    lifetime: LIFETIME,
    period: { label: "18 Aug - 24 Aug 2026" },
    extra: { threshold: 400, days: 4 },
    ...over
  });

const renderMm = (kind, over = {}) =>
  renderReminderMattermost({
    kind,
    client: CLIENT,
    stats: STATS,
    lifetime: LIFETIME,
    period: { label: "18 Aug - 24 Aug 2026" },
    extra: { threshold: 400, days: 4 },
    ...over
  });

test("reminderTemplates", async (t) => {
  await t.test("every kind renders subject, html and text; unknown kind is null", () => {
    for (const kind of KINDS) {
      const out = render(kind);
      assert.ok(out, `${kind} rendered`);
      assert.ok(out.subject.length > 0, `${kind} has a subject`);
      assert.ok(out.html.includes("<!DOCTYPE html>"), `${kind} html is a document`);
      assert.ok(out.text.trim().length > 0, `${kind} has a text part`);
      const mm = renderMm(kind);
      assert.ok(mm && mm.text.length > 0, `${kind} has a Mattermost message`);
    }
    assert.equal(renderReminderEmail({ kind: "not_a_kind" }), null);
    assert.equal(renderReminderMattermost({ kind: "not_a_kind" }), null);
  });

  await t.test("POLICY: no job links anywhere in client email - one dashboard link only", () => {
    // The stats fixture carries a joblink on every job. None of it may reach
    // the mail: a dead posting behind a link the client clicks is the exact
    // complaint this rework exists to prevent.
    for (const kind of KINDS) {
      const out = render(kind);
      assert.ok(!out.html.includes("greenhouse.io"), `${kind}: job link leaked into html`);
      assert.ok(!out.text.includes("greenhouse.io"), `${kind}: job link leaked into text`);
      const anchors = (out.html.match(/<a\s/g) || []).length;
      if (kind === "inactivity_alert") {
        assert.equal(anchors, 0, "the internal alert links to nothing");
      } else {
        assert.equal(anchors, 1, `${kind}: exactly one link (the dashboard), found ${anchors}`);
        assert.ok(out.html.includes("https://portal.flashfirejobs.com"), `${kind}: the one link is the dashboard`);
      }
    }
  });

  await t.test("POLICY: daily summary is numbers only - no role or company names", () => {
    const out = render("daily_summary");
    for (const needle of ["Stripe", "Datadog", "Figma", "Senior Backend Engineer", "Staff Engineer"]) {
      assert.ok(!out.html.includes(needle), `daily html must not name ${needle}`);
      assert.ok(!out.text.includes(needle), `daily text must not name ${needle}`);
    }
    // The number itself must be there. Roles added, not applications - see the
    // dedicated case below for why the applications row was removed.
    assert.ok(out.html.includes("New roles added"), "labelled");
    assert.ok(out.html.includes(">5<") || out.html.includes("5"), "added count present");
    const mm = renderMm("daily_summary");
    assert.ok(!mm.text.includes("Stripe"), "Mattermost daily is numbers only too");
  });

  await t.test("no hype: no emoji, no exclamation marks, no em dashes in client output", () => {
    const EM_DASH = "—";
    // The exclamation check applies to what a reader SEES, so markup is
    // stripped first - "<!DOCTYPE html>" is not hype.
    const visible = (html) => html.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");
    for (const kind of KINDS) {
      const out = render(kind);
      const mm = renderMm(kind);
      for (const [what, text] of [["subject", out.subject], ["html", visible(out.html)], ["text", out.text], ["mattermost", mm.text]]) {
        assert.ok(!text.includes(EM_DASH), `${kind} ${what}: em dash`);
        assert.ok(!text.includes("!"), `${kind} ${what}: exclamation mark`);
        assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text), `${kind} ${what}: emoji`);
      }
    }
  });

  await t.test("every client mail states its reporting window", () => {
    for (const kind of KINDS) {
      const out = render(kind);
      assert.ok(
        out.html.includes("18 Aug - 24 Aug 2026") || out.subject.includes("18 Aug - 24 Aug 2026"),
        `${kind}: window label missing`
      );
    }
  });

  await t.test("no internal language reaches a client mail", () => {
    for (const kind of KINDS.filter((k) => k !== "inactivity_alert")) {
      const out = render(kind);
      for (const leak of ["removed by", "deleted by", "queue", "operator", "skip"]) {
        assert.ok(!out.html.toLowerCase().includes(leak), `${kind}: internal term "${leak}"`);
      }
    }
  });

  await t.test("mattermost messages stay under the size ceiling with a huge pipeline", () => {
    const many = {
      ...STATS,
      interviewJobs: Array.from({ length: 300 }, (_, i) => job(`A very long senior staff principal role title number ${i}`, `Company ${i}`)),
      byDay: Array.from({ length: 31 }, (_, i) => ({ date: `2026-07-${String(i + 1).padStart(2, "0")}`, added: 5, applied: 9 }))
    };
    for (const kind of KINDS) {
      const mm = renderMm(kind, { stats: many });
      assert.ok(mm.text.length <= 4000, `${kind}: ${mm.text.length} chars`);
    }
  });

  await t.test("removed report types render nothing at all", () => {
    // Retired from the catalogue over several rounds. An unknown kind must
    // return null rather than a half-built mail, so a stale config row
    // referencing one cannot resurrect it.
    for (const gone of ["monthly_report", "plan_usage", "weekly_report", "interview_digest", "milestone"]) {
      assert.equal(renderReminderEmail({ kind: gone }), null, `${gone} email`);
      assert.equal(renderReminderMattermost({ kind: gone }), null, `${gone} mattermost`);
    }
  });

  await t.test("the daily summary counts roles added and never applications", () => {
    // "Applications submitted" was removed on purpose: on a normal day it reads
    // 0, because applying happens after roles are queued, and a daily mail
    // whose headline number is zero reads as "nothing happened". Submissions
    // are counted in the weekly report, over a window long enough to be real.
    const out = render("daily_summary", { stats: { ...STATS, addedCount: 11, appliedCount: 0 } });
    assert.ok(!out.html.includes("Applications submitted"), "no applications row");
    assert.ok(!out.text.includes("Applications submitted"), "no applications row in text");
    assert.ok(out.html.includes("New roles added"), "roles row present");
    // Interview and offer counts were removed too: those reach the client the
    // moment they land, via the inbox milestone alert, which names the company
    // and carries the real mail. A bare count a day later invites "which one?".
    assert.ok(!out.html.includes("Moved to interview"), "no interview row");
    assert.ok(!out.html.includes("Offers"), "no offers row");
    assert.match(out.subject, /11 new roles added/, out.subject);
    const mm = renderMm("daily_summary", { stats: { ...STATS, addedCount: 11, appliedCount: 0 } });
    assert.ok(!mm.text.includes("Applications submitted"), "mattermost too");
  });
});
