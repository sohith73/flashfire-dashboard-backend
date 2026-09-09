// Unsubscribe: token security, link building, and which mails carry it.
//
// Two things this guards. First, the link authorises itself with an HMAC
// because it must work from an inbox with no session - so a forged or edited
// link must never unsubscribe somebody, and the address must not be an
// editable query parameter that lets anyone walk the client list. Second, the
// link must be ABSENT rather than broken when it cannot be built: a dead
// unsubscribe link reads as deliberate and earns a spam report.
//
// Pure functions only. No Mongo, no network.

import assert from "node:assert/strict";
import test from "node:test";

const withEnv = async (vars, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

const LIVE = { JWT_SECRET: "test-signing-secret", PUBLIC_API_URL: "https://api.flashfirejobs.com" };

const u = await import("../unsubscribe.js");

test("unsubscribe", async (t) => {
  await t.test("a token only verifies for the exact address AND stream it was cut for", async () => {
    await withEnv(LIVE, () => {
      const token = u.unsubscribeToken("client@example.com", u.UNSUB_STREAMS.REMINDERS);
      assert.ok(token.length === 32, "128-bit tag");

      assert.equal(u.verifyUnsubscribeToken("client@example.com", "reminders", token), true);
      // Changing the address in the URL must not unsubscribe that person -
      // otherwise one valid link is a tool for walking the whole client list.
      assert.equal(u.verifyUnsubscribeToken("someone.else@example.com", "reminders", token), false);
      // And it must not silently widen to other streams.
      assert.equal(u.verifyUnsubscribeToken("client@example.com", "all", token), false);
      assert.equal(u.verifyUnsubscribeToken("client@example.com", "inbox-alerts", token), false);
    });
  });

  await t.test("a forged, empty, truncated or oversized token is rejected without throwing", async () => {
    await withEnv(LIVE, () => {
      for (const bad of ["", "x", "x".repeat(31), "x".repeat(32), "x".repeat(300), null, undefined, 12345]) {
        assert.equal(
          u.verifyUnsubscribeToken("client@example.com", "all", bad),
          false,
          `${JSON.stringify(bad)} must be rejected`
        );
      }
    });
  });

  await t.test("addresses are normalised, so case and padding do not break the link", async () => {
    await withEnv(LIVE, () => {
      const token = u.unsubscribeToken("Client@Example.com", "all");
      assert.equal(u.verifyUnsubscribeToken("  client@example.com  ", "all", token), true);
    });
  });

  await t.test("it degrades to NO link rather than a broken one", async () => {
    // A dead unsubscribe link is worse than none: it reads as deliberate.
    await withEnv({ ...LIVE, JWT_SECRET: null, JWT_SECRET_KEY: null }, () => {
      assert.equal(u.isUnsubscribeConfigured(), false);
      assert.equal(u.unsubscribeUrl("c@e.com", "all"), "");
      assert.deepEqual(u.unsubscribeHeaders("c@e.com", "all"), {});
    });
    await withEnv({ ...LIVE, PUBLIC_API_URL: null, BACKEND_PUBLIC_URL: null }, () => {
      assert.equal(u.unsubscribeUrl("c@e.com", "all"), "", "no public URL means no link");
      assert.deepEqual(u.unsubscribeHeaders("c@e.com", "all"), {});
    });
    await withEnv(LIVE, () => {
      assert.equal(u.unsubscribeUrl("", "all"), "", "no address means no link");
      assert.equal(u.unsubscribeUrl("c@e.com", "not-a-stream"), "", "unknown stream means no link");
    });
  });

  await t.test("the RFC 8058 headers are well formed", async () => {
    await withEnv(LIVE, () => {
      const h = u.unsubscribeHeaders("client@example.com", u.UNSUB_STREAMS.REMINDERS);
      // Angle brackets are required by RFC 2369; Gmail ignores the header without them.
      assert.match(h["List-Unsubscribe"], /^<https:\/\/[^>]+>$/);
      assert.equal(h["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
      // One-click must never be advertised over plain http.
      assert.ok(h["List-Unsubscribe"].includes("https://"), "https only");
    });
  });

  await t.test("every client-facing mail carries a link; the internal alert does not", async () => {
    await withEnv(LIVE, async () => {
      const { renderReminderEmail } = await import(`../reminderTemplates.js?u=${Date.now()}`);
      const { renderClientMilestoneEmail } = await import(`../clientMailTemplates.js?u=${Date.now()}`);
      const { renderOnboardingEmail } = await import(`../onboardingMailTemplates.js?u=${Date.now()}`);

      const stats = {
        addedCount: 5, appliedCount: 0, byDay: [], topCompanies: [],
        addedJobs: [], appliedJobs: [], interviewJobs: [], offerJobs: []
      };
      const client = { name: "R", email: "client@example.com" };

      const daily = renderReminderEmail({
        kind: "daily_summary", client, stats, lifetime: {}, period: { label: "Wed, 26 Aug 2026" }
      });
      assert.match(daily.html, /href="[^"]*\/unsubscribe\?[^"]*"[^>]*>Unsubscribe</, "daily html link");
      assert.match(daily.text, /Unsubscribe: https:\/\//, "daily text link");

      const milestone = renderClientMilestoneEmail({
        client,
        digest: { category: "offer", subject: "Offer", from: "hr@acme.com", date: "2026-08-25T15:21:00Z" }
      });
      assert.ok(milestone.html.includes("/unsubscribe?"), "milestone html link");
      assert.match(milestone.text, /Unsubscribe: https:\/\//, "milestone text link");

      const onboarding = renderOnboardingEmail({
        key: "base_resume", clientName: "R", clientEmail: "client@example.com"
      });
      assert.ok(onboarding.html.includes("/unsubscribe?"), "onboarding html link");

      // The internal idle alert goes to the FlashFire team, not the client.
      // Offering the team an unsubscribe on their own operations alert would
      // be nonsense, and the link would point at a client's config.
      const internal = renderReminderEmail({
        kind: "inactivity_alert", client, stats, lifetime: {},
        period: { label: "x" }, extra: { days: 4 }
      });
      assert.ok(!internal.html.includes("/unsubscribe"), "internal alert has no link");
      assert.ok(!internal.text.includes("Unsubscribe"), "internal alert text has no link");
    });
  });

  await t.test("each stream opts out of its own mail only", async () => {
    await withEnv(LIVE, async () => {
      const { renderReminderEmail } = await import(`../reminderTemplates.js?s=${Date.now()}`);
      const { renderClientMilestoneEmail } = await import(`../clientMailTemplates.js?s=${Date.now()}`);
      const stats = {
        addedCount: 1, appliedCount: 0, byDay: [], topCompanies: [],
        addedJobs: [], appliedJobs: [], interviewJobs: [], offerJobs: []
      };
      const daily = renderReminderEmail({
        kind: "daily_summary", client: { email: "c@e.com" }, stats, lifetime: {}, period: { label: "d" }
      });
      const milestone = renderClientMilestoneEmail({
        client: { email: "c@e.com" }, digest: { category: "offer", subject: "s", from: "f" }
      });
      // Somebody who wants the interview mail but not the daily count must be
      // able to have exactly that.
      assert.match(daily.html, /s=reminders/, "daily opts out of reminders");
      assert.match(milestone.html, /s=inbox-alerts/, "milestone opts out of inbox alerts");
    });
  });
});
