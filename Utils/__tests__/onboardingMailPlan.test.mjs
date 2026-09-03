// Onboarding-email plan gating.
//
// The rule: a client is only ever told about work their plan includes. LinkedIn
// optimisation ships with Professional and Executive only, so a Prime or Ignite
// client must never receive "LinkedIn optimisation done" — which is exactly
// what happened before this gate existed.
//
// Runs offline. No SMTP is reachable from these tests: every scheduled step is
// either pruned by the plan gate or not yet due, so sendDue() returns before it
// can render or deliver anything.

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

// isSmtpConfigured() reads these directly. Without them sendDue() bails at the
// top and the prune path under test is never reached.
process.env.SMTP_USER = process.env.SMTP_USER || "test@example.com";
process.env.SMTP_PASS = process.env.SMTP_PASS || "test-pass";
mongoose.set("bufferCommands", false);

const { OnboardingMailState } = await import("../../Schema_Models/OnboardingMailState.js");
const { ClientPaymentLookup } = await import("../../Schema_Models/ClientPaymentLookup.js");
const { stepsForPlan, planIncludesStep, sendDue } = await import("../../src/services/onboardingMailWorker.js");

const HOUR = 60 * 60 * 1000;

// ── stubs ─────────────────────────────────────────────────────────────────
let docs = [];       // what OnboardingMailState.find returns
let plans = {};      // clientEmail → planType in the tracking collection
const orig = {};

function thenable(resolve) {
  const p = {
    select: () => p,
    lean: () => p,
    then: (ok, err) => Promise.resolve().then(resolve).then(ok, err),
    catch: (err) => Promise.resolve().then(resolve).catch(err),
  };
  return p;
}

function makeDoc(clientEmail, planType, steps) {
  return {
    clientEmail,
    clientName: "Test Client",
    planType,
    paymentEmail: clientEmail,
    status: "scheduled",
    steps,
    saved: 0,
    save() { this.saved += 1; return Promise.resolve(this); },
  };
}

function step(key, { sentAt = null, dueInMs = HOUR } = {}) {
  return { key, subject: "", sendAt: new Date(Date.now() + dueInMs), sentAt, attempts: 0, error: "", messageId: "" };
}

before(() => {
  orig.find = OnboardingMailState.find;
  orig.findOne = ClientPaymentLookup.findOne;
  OnboardingMailState.find = () => thenable(() => docs);
  ClientPaymentLookup.findOne = (filter) => thenable(() => {
    const email = String(filter?.email || "").toLowerCase();
    return email in plans ? { email, planType: plans[email] } : null;
  });
});

after(() => {
  OnboardingMailState.find = orig.find;
  ClientPaymentLookup.findOne = orig.findOne;
});

beforeEach(() => { docs = []; plans = {}; });

// ── the plan map ──────────────────────────────────────────────────────────

test("Prime does not receive the LinkedIn email", () => {
  assert.deepEqual(stepsForPlan("prime"), ["base_resume"]);
  assert.equal(planIncludesStep("prime", "linkedin"), false);
  assert.equal(planIncludesStep("prime", "cover_letter"), false);
  assert.equal(planIncludesStep("prime", "base_resume"), true);
});

test("Ignite does not receive the LinkedIn email", () => {
  assert.deepEqual(stepsForPlan("ignite"), ["base_resume"]);
  assert.equal(planIncludesStep("ignite", "linkedin"), false);
});

test("Professional and Executive keep LinkedIn; only Executive gets the cover letter", () => {
  assert.deepEqual(stepsForPlan("professional"), ["base_resume", "linkedin"]);
  assert.deepEqual(stepsForPlan("executive"), ["base_resume", "cover_letter", "linkedin"]);
  assert.equal(planIncludesStep("professional", "cover_letter"), false);
  assert.equal(planIncludesStep("executive", "cover_letter"), true);
});

test("plan lookup is case-insensitive and covers the legacy Prime alias", () => {
  assert.deepEqual(stepsForPlan("Prime"), ["base_resume"]);
  assert.deepEqual(stepsForPlan("  PROFESSIONAL "), ["base_resume", "linkedin"]);
  assert.deepEqual(stepsForPlan("free trial"), ["base_resume"]);
});

test("an unknown or missing plan gets the base résumé only", () => {
  // Claiming a LinkedIn optimisation the client may not have bought is the
  // expensive mistake; a missing email is recoverable from the UI.
  assert.deepEqual(stepsForPlan(""), ["base_resume"]);
  assert.deepEqual(stepsForPlan(null), ["base_resume"]);
  assert.deepEqual(stepsForPlan("some-new-plan"), ["base_resume"]);
});

// ── the send-time gate ────────────────────────────────────────────────────

test("a LinkedIn step already queued for a Prime client is dropped, not sent", async () => {
  const doc = makeDoc("purvi@example.com", "prime", [
    step("base_resume", { sentAt: new Date(Date.now() - 2 * HOUR) }),
    step("linkedin", { dueInMs: -HOUR }), // overdue: it WOULD send without the gate
  ]);
  docs = [doc];
  plans["purvi@example.com"] = "Prime";

  const out = await sendDue();
  assert.equal(out.sent, 0, "nothing may go out");
  assert.deepEqual(doc.steps.map((s) => s.key), ["base_resume"], "the LinkedIn step is removed from the sequence");
  assert.equal(doc.status, "done", "with nothing left to send, the sequence closes");
  assert.ok(doc.saved >= 1);
});

test("the live plan wins over the plan stamped on the sequence", async () => {
  // Scheduled while the client was Professional, downgraded to Prime since.
  const doc = makeDoc("moved@example.com", "professional", [
    step("base_resume", { sentAt: new Date(Date.now() - 2 * HOUR) }),
    step("linkedin", { dueInMs: -HOUR }),
  ]);
  docs = [doc];
  plans["moved@example.com"] = "prime";

  const out = await sendDue();
  assert.equal(out.sent, 0);
  assert.deepEqual(doc.steps.map((s) => s.key), ["base_resume"]);
});

test("a Professional client keeps their LinkedIn step", async () => {
  const doc = makeDoc("pro@example.com", "professional", [
    step("base_resume", { sentAt: new Date(Date.now() - 2 * HOUR) }),
    step("linkedin", { dueInMs: HOUR }), // not due — sendDue stops before delivering
  ]);
  docs = [doc];
  plans["pro@example.com"] = "professional";

  const out = await sendDue();
  assert.equal(out.sent, 0);
  assert.deepEqual(doc.steps.map((s) => s.key), ["base_resume", "linkedin"], "the step must survive");
  assert.equal(doc.status, "scheduled");
});

test("an unresolvable client falls back to the plan on the sequence", async () => {
  const doc = makeDoc("ghost@example.com", "prime", [
    step("base_resume", { sentAt: new Date(Date.now() - 2 * HOUR) }),
    step("linkedin", { dueInMs: -HOUR }),
  ]);
  docs = [doc];
  // plans is empty — no tracking row for this client.

  const out = await sendDue();
  assert.equal(out.sent, 0);
  assert.deepEqual(doc.steps.map((s) => s.key), ["base_resume"], "the doc's own plan still gates the step");
});

test("the base résumé step is never gated and costs no plan lookup", async () => {
  let lookups = 0;
  const prevFindOne = ClientPaymentLookup.findOne;
  ClientPaymentLookup.findOne = (filter) => { lookups += 1; return prevFindOne(filter); };
  try {
    const doc = makeDoc("new@example.com", "prime", [step("base_resume", { dueInMs: HOUR })]);
    docs = [doc];
    plans["new@example.com"] = "prime";

    const out = await sendDue();
    assert.equal(out.sent, 0);
    assert.deepEqual(doc.steps.map((s) => s.key), ["base_resume"]);
    assert.equal(lookups, 0, "gating base_resume would add a query per client per tick for no reason");
  } finally {
    ClientPaymentLookup.findOne = prevFindOne;
  }
});
