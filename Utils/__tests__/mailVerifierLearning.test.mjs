// The learning loop + staged rollout — POLICY, locked down.
//
// Covers the pure decision functions behind:
//   • learned sender suppression (mailVerifierLearning.decideSuppression)
//   • the single-client rollout gate (clientMailNotifier.rolloutAllows)
//   • the stale-digest guard that stops old milestones flushing when the
//     allowlist is later widened (clientMailNotifier.isTooOldToNotify)
//
// Pure functions only. No Mongo, no network.

import assert from "node:assert/strict";
import test from "node:test";

const { domainOf, decideSuppression, PROTECTED_DOMAINS, SUPPRESS_AFTER_REJECTIONS } = await import(
  "../../src/services/mailVerifierLearning.js"
);
const { rolloutAllows, isTooOldToNotify } = await import("../../src/services/clientMailNotifier.js");

// ── domainOf ─────────────────────────────────────────────────────────

test("domainOf: parses, lowercases, and fails to empty string", () => {
  assert.equal(domainOf("Hello <no-reply@Career-Academy.IO>".match(/<(.+)>/)[1]), "career-academy.io");
  assert.equal(domainOf("plain@bootcamp.io"), "bootcamp.io");
  assert.equal(domainOf("not-an-email"), "");
  assert.equal(domainOf(""), "");
  assert.equal(domainOf(null), "");
  assert.equal(domainOf("trailing@"), "");
});

// ── decideSuppression ────────────────────────────────────────────────

test("suppression: enough rejections + zero genuine → suppress", () => {
  assert.equal(
    decideSuppression({ domain: "spammy-jobs.io", rejectCount: SUPPRESS_AFTER_REJECTIONS, genuineCount: 0 }),
    true
  );
});

test("suppression: below the rejection threshold → never suppress", () => {
  assert.equal(
    decideSuppression({ domain: "spammy-jobs.io", rejectCount: SUPPRESS_AFTER_REJECTIONS - 1, genuineCount: 0 }),
    false
  );
});

test("suppression: ONE genuine milestone ever → never suppress, any reject count", () => {
  assert.equal(decideSuppression({ domain: "spammy-jobs.io", rejectCount: 100, genuineCount: 1 }), false);
});

test("suppression: protected domains are never suppressed", () => {
  for (const domain of ["gmail.com", "greenhouse.io", "codility.com", "calendly.com"]) {
    assert.ok(PROTECTED_DOMAINS.has(domain), `${domain} must be protected`);
    assert.equal(decideSuppression({ domain, rejectCount: 999, genuineCount: 0 }), false);
  }
});

test("suppression: empty domain → never suppress", () => {
  assert.equal(decideSuppression({ domain: "", rejectCount: 999, genuineCount: 0 }), false);
});

// ── rollout gate ─────────────────────────────────────────────────────

test("rollout: the test client passes on any of the three identities", () => {
  assert.equal(rolloutAllows({ clientEmail: "rijuljain17@gmail.com" }), true);
  assert.equal(rolloutAllows({ paymentEmail: "RijulJain17@Gmail.com " }), true, "case/space-insensitive");
  assert.equal(rolloutAllows({ mailbox: "rijuljain17@gmail.com" }), true);
});

test("rollout: everyone else is gated while the allowlist is non-empty", () => {
  assert.equal(
    rolloutAllows({ clientEmail: "other@client.com", paymentEmail: "pay@client.com", mailbox: "mb@client.com" }),
    false
  );
  assert.equal(rolloutAllows({}), false);
});

// ── stale-digest guard ───────────────────────────────────────────────

test("staleness: fresh digest sends, 3-day-old digest does not", () => {
  const now = Date.now();
  assert.equal(isTooOldToNotify(new Date(now - 2 * 3600 * 1000), now), false, "2h old → sends");
  assert.equal(isTooOldToNotify(new Date(now - 72 * 3600 * 1000), now), true, "72h old → parked");
});

test("staleness: unknown date never blocks", () => {
  assert.equal(isTooOldToNotify(null), false);
  assert.equal(isTooOldToNotify(undefined), false);
  assert.equal(isTooOldToNotify("not a date"), false);
});
