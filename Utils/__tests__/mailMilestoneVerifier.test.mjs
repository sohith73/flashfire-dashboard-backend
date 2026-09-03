// Milestone verification — the CLIENT-SEND POLICY, locked down.
//
// The client-milestone mail stream was paused 2026-08-12 because the regex
// classifier alone forwarded an Amazon "Thank you for applying" auto-ack to a
// client as "you've got an interview". The fix is a second-stage AI verifier
// (src/services/mailMilestoneVerifier.js) that must approve every candidate
// before the client is emailed. These tests lock down:
//   1. the gate is FAIL-CLOSED — no verifier verdict, no client mail;
//   2. the verifier's request/response wiring against a stubbed OpenAI;
//   3. the rules classifier's KNOWN looseness (documented, not "fixed" — the
//      verifier exists precisely because these regexes stay loose on purpose);
//   4. the redesigned template renders the facts and escapes user content.

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

// Route the verifier at a local stub BEFORE the module (which reads env at
// import time) is loaded.
const stub = { status: 200, body: null, lastRequest: null };
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    stub.lastRequest = JSON.parse(raw);
    res.writeHead(stub.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stub.body));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.MAIL_AI_API_URL = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
process.env.OPENAI_API_KEY = "test-key";

const { verifyMilestoneMail, milestoneGate } = await import("../../src/services/mailMilestoneVerifier.js");
const { classifyMailByRules } = await import("../mailRulesClassifier.js");
const { renderClientMilestoneEmail } = await import("../clientMailTemplates.js");

test.after(() => server.close());

function openaiReply(obj) {
  return {
    model: "gpt-4o-mini-test",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    choices: [{ message: { content: JSON.stringify(obj) } }]
  };
}

// ── 1. milestoneGate: fail-closed policy ─────────────────────────────

test("gate: verifier unavailable → NOT eligible (fail-closed)", () => {
  const g = milestoneGate({ ok: false, genuine: false, error: "timeout after 20000ms" });
  assert.equal(g.eligible, false);
  assert.match(g.reason, /^verifier_unavailable:/);
});

test("gate: verified rejection → NOT eligible, reason preserved", () => {
  const g = milestoneGate({ ok: true, genuine: false, category: "not-milestone", confidence: "high", reason: "bootcamp promo" });
  assert.equal(g.eligible, false);
  assert.match(g.reason, /^verifier_rejected:bootcamp promo/);
});

test("gate: genuine but low confidence → NOT eligible", () => {
  const g = milestoneGate({ ok: true, genuine: true, category: "interview", confidence: "low", reason: "vague" });
  assert.equal(g.eligible, false);
  assert.match(g.reason, /^verifier_low_confidence:/);
});

test("gate: genuine + medium/high confidence → eligible with verifier category", () => {
  for (const confidence of ["medium", "high"]) {
    const g = milestoneGate({ ok: true, genuine: true, category: "assessment", confidence, reason: "Codility invite from Acme" });
    assert.equal(g.eligible, true);
    assert.equal(g.category, "assessment");
  }
});

test("gate: null/undefined verdict → NOT eligible", () => {
  assert.equal(milestoneGate(null).eligible, false);
  assert.equal(milestoneGate(undefined).eligible, false);
});

// ── 2. verifyMilestoneMail wiring against the stub ──────────────────

test("verifier: parses a rejection verdict and reports ok", async () => {
  stub.status = 200;
  stub.body = openaiReply({ genuine: false, category: "not-milestone", confidence: "high", reason: "marketing newsletter" });
  const v = await verifyMilestoneMail({
    from: "TechBootcamp <hello@bootcamp.io>",
    subject: "Your next step starts here!",
    bodyText: "Book a time with our advisors to talk about the next step in your career.",
    rulesCategory: "interview"
  });
  assert.equal(v.ok, true);
  assert.equal(v.genuine, false);
  assert.equal(v.category, "not-milestone");
  // The prompt must carry the mail's facts and the rules guess.
  const sent = stub.lastRequest.messages.map((m) => m.content).join("\n");
  assert.match(sent, /Rules classifier guess: interview/);
  assert.match(sent, /bootcamp\.io/);
  assert.equal(stub.lastRequest.temperature, 0);
});

test("verifier: genuine=true is honored only with a milestone category", async () => {
  stub.body = openaiReply({ genuine: true, category: "not-milestone", confidence: "high", reason: "contradictory" });
  const v = await verifyMilestoneMail({ from: "a@b.co", subject: "x", bodyText: "y", rulesCategory: "offer" });
  assert.equal(v.ok, true);
  assert.equal(v.genuine, false, "genuine must be forced false when category is not a milestone");
});

test("verifier: HTTP error → ok:false (fail-closed), never throws", async () => {
  stub.status = 500;
  stub.body = { error: "boom" };
  const v = await verifyMilestoneMail({ from: "a@b.co", subject: "x", bodyText: "y", rulesCategory: "interview" });
  assert.equal(v.ok, false);
  assert.equal(v.genuine, false);
  assert.match(v.error, /HTTP 500/);
  stub.status = 200;
});

test("verifier: unparseable model output → ok:false", async () => {
  stub.body = { model: "m", choices: [{ message: { content: "not json {" } }] };
  const v = await verifyMilestoneMail({ from: "a@b.co", subject: "x", bodyText: "y", rulesCategory: "interview" });
  assert.equal(v.ok, false);
  assert.match(v.error, /unparseable/);
});

// ── 3. The documented looseness the verifier exists for ─────────────

test("rules classifier STILL flags promo-worded mail (why the verifier exists)", () => {
  // A course promo phrased like recruiting mail. The regexes are loose on
  // purpose (recall over precision); this asserts the false positive so the
  // verifier's job is visible. If this test starts failing, the rules got
  // stricter — re-evaluate whether the verifier thresholds should change too.
  const promo = classifyMailByRules({
    from: "Career Academy <hello@career-academy.io>",
    subject: "Interview prep: schedule a call with our coaches",
    bodyText: "Would you like to book a time? Take the next step in your career today."
  });
  assert.equal(promo.category, "interview");

  // And the real thing also passes rules — the verifier separates them.
  const real = classifyMailByRules({
    from: "Jane Doe <jane@acme.com>",
    subject: "Interview invitation - Backend Engineer at Acme",
    bodyText: "We would like to invite you to a 45-minute technical interview. Please pick a slot."
  });
  assert.equal(real.category, "interview");
});

// ── 4. Redesigned template ───────────────────────────────────────────

test("template: renders facts, CTA, and escapes hostile content", () => {
  const { subject, html, text } = renderClientMilestoneEmail({
    client: { name: "Alex Carter", email: "alex@example.com" },
    digest: {
      category: "assessment",
      subject: `Reminder: complete your Codility assessment <script>alert(1)</script>`,
      from: "no-reply@codility.com",
      summary: "Grant Street Group invites you to complete a Codility assessment.",
      actionRequired: "Complete the assignment before the deadline.",
      date: new Date("2026-08-06T18:30:39.730Z")
    },
    dashboardUrl: "https://portal.flashfirejobs.com"
  });

  assert.match(subject, /^You have a new assignment/);
  assert.ok(!html.includes("<script>alert(1)</script>"), "subject must be HTML-escaped");
  assert.match(html, /You have a new assignment/);
  assert.match(html, /no-reply@codility\.com/);
  assert.match(html, /Open your dashboard/);
  assert.match(html, /Received/);
  assert.match(html, /Flashfire/);
  assert.ok(!html.includes("FlashFire"), "brand is spelled Flashfire, not FlashFire");
  // Plaintext fallback carries the same facts.
  assert.match(text, /Category: Assignment/);
  assert.match(text, /From: no-reply@codility\.com/);
  assert.match(text, /https:\/\/portal\.flashfirejobs\.com/);
});

test("template: javascript: dashboardUrl is refused, falls back to portal", () => {
  const { html } = renderClientMilestoneEmail({
    client: { name: "A" },
    digest: { category: "interview", subject: "s", from: "f@c.co" },
    dashboardUrl: "javascript:alert(1)"
  });
  assert.ok(!html.includes("javascript:alert"), "javascript: URI must never reach an href");
  assert.match(html, /https:\/\/portal\.flashfirejobs\.com/);
});
