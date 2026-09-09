// Onboarding-email Mattermost mirror.
//
// Every onboarding email (base résumé, cover letter, LinkedIn) is echoed into
// the client's Mattermost channel once the email is accepted. These tests pin
// the message copy, the fail-soft contract (never throws, never leaks the
// webhook) and the step bookkeeping the UI reads.
//
// Runs offline: the transport is driven through mattermostSender's __setFetch
// seam and the webhook is passed in directly, so no Mongo is touched.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const { renderOnboardingMattermost } = await import("../onboardingMailTemplates.js");
const { __setFetch } = await import("../mattermostSender.js");
const { postOnboardingStepToMattermost, recordMirrorOnStep } = await import(
  "../../src/services/onboardingMattermost.js"
);

const HOOK = "https://mm.example.com/hooks/abcdefgh12345678";

afterEach(() => __setFetch(null));

// ── copy ───────────────────────────────────────────────────────────────────

test("each onboarding step renders its own heading and the email nudge", () => {
  const cases = {
    base_resume: "Your base résumé is made",
    cover_letter: "Your cover letter is made",
    linkedin: "Your LinkedIn optimization is done"
  };
  for (const [key, heading] of Object.entries(cases)) {
    const out = renderOnboardingMattermost({ key, clientName: "Asha Rao", dashboardUrl: "https://portal.example" });
    assert.ok(out, `${key} renders`);
    assert.match(out.text, new RegExp(`^#### ${heading.replace(/\./g, "\\\\.")}, Asha`), `${key} heading`);
    assert.match(out.text, /WhatsApp group/, `${key} points at the WhatsApp group`);
    assert.match(out.text, /emailed you about this/, `${key} says the email exists too`);
    assert.match(out.text, /\[Open your dashboard\]\(https:\/\/portal\.example\)/, `${key} carries the CTA`);
  }
});

test("unknown step key renders nothing", () => {
  assert.equal(renderOnboardingMattermost({ key: "portfolio" }), null);
});

test("client name is markdown-escaped and falls back to the email local part", () => {
  // Only the first name is used, so the escape check is on that token alone.
  const escaped = renderOnboardingMattermost({ key: "base_resume", clientName: "*bold* Rao" });
  assert.match(escaped.text, /, \\\*bold\\\*$/m);
  const fallback = renderOnboardingMattermost({ key: "base_resume", clientEmail: "priya.k@example.com" });
  assert.match(fallback.text, /, priya\\\.k$/m);
});

// ── transport ─────────────────────────────────────────────────────────────

test("posts to the webhook and reports ok", async () => {
  const calls = [];
  __setFetch(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { status: 200, text: async () => "ok" };
  });
  const res = await postOnboardingStepToMattermost({ webhookUrl: HOOK, key: "cover_letter", clientName: "Asha" });
  assert.deepEqual(res, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, HOOK);
  assert.equal(calls[0].body.username, "FlashFire");
  assert.match(calls[0].body.text, /cover letter is made, Asha/);
});

test("no webhook saved is a skip, not a failure, and nothing is fetched", async () => {
  let fetched = 0;
  __setFetch(async () => {
    fetched += 1;
    return { status: 200, text: async () => "ok" };
  });
  assert.deepEqual(await postOnboardingStepToMattermost({ webhookUrl: "", key: "base_resume" }), {
    ok: false,
    skipped: "no_webhook"
  });
  assert.deepEqual(await postOnboardingStepToMattermost({ webhookUrl: "http://plain.example/hooks/x", key: "base_resume" }), {
    ok: false,
    skipped: "no_webhook"
  });
  assert.equal(fetched, 0);
});

test("unknown step is a skip before any network call", async () => {
  let fetched = 0;
  __setFetch(async () => {
    fetched += 1;
    return { status: 200, text: async () => "ok" };
  });
  assert.deepEqual(await postOnboardingStepToMattermost({ webhookUrl: HOOK, key: "nope" }), {
    ok: false,
    skipped: "unknown_step"
  });
  assert.equal(fetched, 0);
});

test("a rejected post is an error that never contains the webhook", async () => {
  __setFetch(async () => ({ status: 404, text: async () => `no hook at ${HOOK}` }));
  const res = await postOnboardingStepToMattermost({ webhookUrl: HOOK, key: "linkedin", clientName: "Asha" });
  assert.equal(res.ok, false);
  assert.ok(res.error, "error is populated");
  assert.equal(res.error.includes(HOOK), false, "webhook redacted");
  assert.equal(res.error.includes("abcdefgh12345678"), false, "token redacted");
});

// ── step bookkeeping ──────────────────────────────────────────────────────

test("recordMirrorOnStep stamps success, keeps failure, ignores a skip", () => {
  const ok = { mattermostAt: null, mattermostError: "old" };
  recordMirrorOnStep(ok, { ok: true });
  assert.ok(ok.mattermostAt instanceof Date);
  assert.equal(ok.mattermostError, "");

  const failed = { mattermostAt: null, mattermostError: "" };
  recordMirrorOnStep(failed, { ok: false, error: "mattermost responded 500" });
  assert.equal(failed.mattermostAt, null);
  assert.equal(failed.mattermostError, "mattermost responded 500");

  const skipped = { mattermostAt: null, mattermostError: "" };
  recordMirrorOnStep(skipped, { ok: false, skipped: "no_webhook" });
  assert.equal(skipped.mattermostAt, null);
  assert.equal(skipped.mattermostError, "");
});
