// AI-written exclusion rules — the SAFETY GAUNTLET, locked down.
//
// The regex learner lets an AI write patterns that run in production. These
// tests are the reason that is acceptable: any pattern that could eat a real
// interview/assessment/offer mail, or that is structurally dangerous, must be
// rejected by acceptProposal() before it ever reaches Mongo. If a test here
// fails, do NOT loosen the assertion — the gauntlet is the product.
//
// Pure functions only. No Mongo, no network.

import assert from "node:assert/strict";
import test from "node:test";

const { validatePatternSource, acceptProposal, GENUINE_FIXTURES } = await import(
  "../../src/services/mailRegexLearner.js"
);

const PROMO_MAIL = {
  subject: "Interview prep: schedule a call with our career coaches",
  from: "Career Academy <hello@career-academy.io>",
  bodyText: "Would you like to book a time? Join CareerBoost Pro and take the next step in your career today. Unsubscribe anytime."
};

// ── validatePatternSource ────────────────────────────────────────────

test("pattern: compiles and passes when sane", () => {
  const v = validatePatternSource("career[- ]?academy\\.io");
  assert.equal(v.ok, true);
  assert.ok(v.re instanceof RegExp);
});

test("pattern: too short / too long are rejected", () => {
  assert.equal(validatePatternSource("promo").ok, false);
  assert.equal(validatePatternSource("x".repeat(201)).ok, false);
});

test("pattern: dangerous constructs are rejected", () => {
  for (const bad of [
    "(?<=foo)bar-pattern", // lookbehind
    "(interview)\\1 again", // backreference
    "(next step)+ today", // quantified group — backtracking shape
    "(.*)*promotions", // nested quantifier
    ".*.*newsletter", // double wildcard
    "^.*$" // match-everything
  ]) {
    assert.equal(validatePatternSource(bad).ok, false, `must reject: ${bad}`);
  }
});

test("pattern: non-compiling source is rejected, not thrown", () => {
  const v = validatePatternSource("([unclosed-group");
  assert.equal(v.ok, false);
  assert.match(v.reason, /compile/);
});

// ── acceptProposal: the regression suite in action ───────────────────

test("accept: a well-targeted sender pattern passes", () => {
  const r = acceptProposal({
    pattern: "@career-academy\\.io",
    targetField: "from",
    offendingMail: PROMO_MAIL
  });
  assert.equal(r.ok, true);
});

test("accept: a distinctive marketing phrase on body passes", () => {
  const r = acceptProposal({
    pattern: "join careerboost pro",
    targetField: "body",
    offendingMail: PROMO_MAIL
  });
  assert.equal(r.ok, true);
});

test("accept: rejected when it does not match the offending mail", () => {
  const r = acceptProposal({
    pattern: "totally-unrelated-brand",
    targetField: "subject",
    offendingMail: PROMO_MAIL
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /offending/);
});

test("accept: a generic recruiting phrase is rejected by the genuine fixtures", () => {
  // "interview" appears in genuine invites — the fixtures must catch this.
  const r = acceptProposal({
    pattern: "\\binterview\\b.{0,40}", // matches the promo subject AND real invites
    targetField: "subject",
    offendingMail: PROMO_MAIL
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /genuine/);
});

test("accept: 'book a time' style patterns are rejected (real invites say it too)", () => {
  const r = acceptProposal({
    pattern: "book a time( that works)?",
    targetField: "body",
    offendingMail: PROMO_MAIL
  });
  assert.equal(r.ok, false, "Stripe's genuine phone-screen fixture says 'book a time'");
});

test("accept: live genuine examples extend the regression set", () => {
  const r = acceptProposal({
    pattern: "schedule a call with our career coaches",
    targetField: "subject",
    offendingMail: PROMO_MAIL,
    genuineExamples: [{ subject: "Schedule a call with our career coaches at RealCo (final round)", from: "", body: "" }]
  });
  assert.equal(r.ok, false, "a pattern matching a live genuine example must be rejected");
});

test("accept: bad targetField is rejected", () => {
  const r = acceptProposal({ pattern: "@career-academy\\.io", targetField: "headers", offendingMail: PROMO_MAIL });
  assert.equal(r.ok, false);
});

// ── fixtures sanity ──────────────────────────────────────────────────

test("fixtures: cover all three milestone categories", () => {
  const all = GENUINE_FIXTURES.map((f) => `${f.subject} ${f.bodyText || f.body}`).join(" ").toLowerCase();
  assert.match(all, /interview/);
  assert.match(all, /assessment|assignment/);
  assert.match(all, /offer/);
});
