// AI triage: every mail the regexes do not flag gets a gpt-4o-mini read, and a
// learned exclusion that hid a genuine mail switches itself off. OpenAI is a
// fake fetch; Mongo model methods are swapped in place.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { triageMail, triageFlags, RULE_FLAGGED_CATEGORIES } = await import("../../src/services/mailAiTriage.js");
const { classifyMailByRules, actionForCategory } = await import("../mailRulesClassifier.js");
const { retireExclusionRule, GENUINE_FIXTURES } = await import("../../src/services/mailRegexLearner.js");
const { MailClassifierRule } = await import("../../Schema_Models/MailClassifierRule.js");

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const BQ = {
  from: "Jack Laycock <kingfisher2+email+1u66m-b131f7bf28@talent.icims.eu>",
  subject: "Interview invitation - Showroom Project Coordinator, B&Q Blackburn",
  bodyText: "Hello Mudassar, thanks for your application to B&Q for the position of Showroom Project Coordinator. I'd like to invite you to an interview, which will take up to an hour."
};

const fakeOpenAi = (content, { status = 200 } = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (status !== 200) return { ok: false, status, text: async () => "boom" };
    return { ok: true, json: async () => ({ model: "gpt-4o-mini", usage: {}, choices: [{ message: { content } }] }) };
  };
  return { fetchImpl, calls };
};
const env = { OPENAI_API_KEY: "sk-test" };

// -- the sender bug that hid the B&Q invite ---------------------------------

test("iCIMS mail is judged on content, not filed as a job-board alert", () => {
  assert.equal(classifyMailByRules(BQ).category, "interview");
  assert.equal(classifyMailByRules({ ...BQ, from: "x@talent.icims.com" }).category, "interview");
  // The talent.com job board is still a job board.
  assert.equal(classifyMailByRules({ ...BQ, from: "alerts@talent.com" }).category, "job-alert");
  assert.equal(classifyMailByRules({ ...BQ, from: "jobs@uk.talent.com" }).category, "job-alert");
  assert.equal(classifyMailByRules({ ...BQ, from: "jobs@linkedin.com" }).category, "job-alert");
});

test("the B&Q invite is a regression fixture no learned exclusion may match", () => {
  assert.ok(GENUINE_FIXTURES.some((f) => /B&Q/.test(f.subject)));
});

// -- triageMail ---------------------------------------------------------------

test("triage: sends the mail to gpt-4o-mini and returns the category it found", async () => {
  const { fetchImpl, calls } = fakeOpenAi(JSON.stringify({ category: "interview", confidence: "high", reason: "invites to an interview" }));
  const t = await triageMail({ ...BQ, rulesCategory: "job-alert" }, { fetchImpl, env });
  assert.deepEqual([t.ok, t.category, t.confidence], [true, "interview", "high"]);
  assert.equal(calls[0].body.model, "gpt-4o-mini");
  assert.equal(calls[0].body.temperature, 0);
  assert.match(calls[0].body.messages[1].content, /Keyword rules said: job-alert/);
  assert.match(calls[0].body.messages[1].content, /Showroom Project Coordinator/);
});

test("triage: unknown categories read as none, unknown confidence as low", async () => {
  const { fetchImpl } = fakeOpenAi(JSON.stringify({ category: "party-invite", confidence: "very" }));
  const t = await triageMail(BQ, { fetchImpl, env });
  assert.equal(t.category, "none");
  assert.equal(t.confidence, "low");
});

test("triage: fail-soft on HTTP error, bad JSON and a missing key; never throws", async () => {
  assert.equal((await triageMail(BQ, { ...fakeOpenAi("", { status: 500 }), env })).ok, false);
  assert.equal((await triageMail(BQ, { ...fakeOpenAi("not json"), env })).ok, false);
  assert.equal((await triageMail(BQ, { fetchImpl: async () => { throw new Error("net down"); }, env })).ok, false);
  const noKey = await triageMail(BQ, { fetchImpl: fakeOpenAi("{}").fetchImpl, env: {} });
  assert.equal(noKey.ok, false);
  assert.match(noKey.error, /OPENAI_API_KEY/);
});

test("triageFlags: only a working, medium-or-high call on a real category flags", () => {
  assert.equal(triageFlags({ ok: true, category: "interview", confidence: "high" }), true);
  assert.equal(triageFlags({ ok: true, category: "rejection", confidence: "medium" }), true);
  assert.equal(triageFlags({ ok: true, category: "offer", confidence: "low" }), false);
  assert.equal(triageFlags({ ok: true, category: "none", confidence: "high" }), false);
  assert.equal(triageFlags({ ok: false, category: "interview", confidence: "high" }), false);
  assert.equal(triageFlags(null), false);
});

test("actionForCategory gives the fixed next-step line for triage finds", () => {
  assert.match(actionForCategory("interview"), /interview/i);
  assert.equal(actionForCategory("rejection"), "");
});

// -- self-correction ------------------------------------------------------------

let saved;
beforeEach(() => { saved = MailClassifierRule.updateOne; });
afterEach(() => { MailClassifierRule.updateOne = saved; });

test("retireExclusionRule: disables an active AI rule, never a manual one, and records why", async () => {
  let call;
  MailClassifierRule.updateOne = async (filter, update) => { call = { filter, update }; return { modifiedCount: 1 }; };
  const r = await retireExclusionRule("rule1", { subject: BQ.subject, reason: "real interview" });
  assert.equal(r.retired, true);
  assert.deepEqual(call.filter, { _id: "rule1", status: "active", source: { $ne: "manual" } });
  assert.equal(call.update.$set.status, "disabled");
  assert.match(call.update.$set.disabledReason, /real interview/);
  assert.equal(call.update.$set.wrongExampleSubject, BQ.subject);
});

test("retireExclusionRule: no id, already disabled or a DB error all return quietly", async () => {
  assert.equal((await retireExclusionRule("")).retired, false);
  MailClassifierRule.updateOne = async () => ({ modifiedCount: 0 });
  assert.equal((await retireExclusionRule("rule1")).retired, false);
  MailClassifierRule.updateOne = async () => { throw new Error("mongo down"); };
  assert.equal((await retireExclusionRule("rule1")).retired, false);
});

// -- pipeline wiring (read from source, like the other mail tests) ----------------

test("pipeline: every mail the rules did not flag goes to triage, and a find takes the normal path", () => {
  const worker = read("../../src/services/mailPollWorker.js");
  assert.deepEqual([...RULE_FLAGGED_CATEGORIES].sort(), ["assessment", "interview", "offer", "rejection"]);
  assert.match(worker, /if \(!RULE_FLAGGED_CATEGORIES\.has\(learned\.category\)\) \{\s*const t = await triageMail\(/);
  assert.match(worker, /fromTriage = triageFlags\(t\)/);
  // The verifier still runs on a triage find; nothing skips it.
  assert.match(worker, /const verdict = await verifyMilestoneMail\(/);
  // A triage find is never sender-suppressed and never teaches an exclusion.
  assert.match(worker, /provisional\.clientNotifyEligible && !fromTriage\s*\? await shouldSuppressSender/);
  assert.equal((worker.match(/verdict\.ok && !verdict\.genuine && !fromTriage/g) || []).length, 2);
  // A wrong learned rule is switched off only after the verifier confirms.
  assert.match(worker, /fromTriage && learned\.excludedByRule && verifyFields\.verifyGenuine === true/);
  assert.match(worker, /\.\.\.verifyFields,\s*\.\.\.triageFields,/);
});

// -- learner guard: no sender-wide exclusion on hiring systems ----------------------

test("protected senders: generic no-reply and hiring-system 'from' rules are refused", async () => {
  const { acceptProposal, coversProtectedSender, validatePatternSource } = await import("../../src/services/mailRegexLearner.js");
  const promo = { subject: "50% off our interview prep course", from: "deals@noreply.example-promo.com", bodyText: "Book a time" };
  for (const pattern of ["noreply@.*", "notifications@calendly\\.com", "myworkday\\.com", "icims\\.com", "no-reply@ashbyhq\\.com", "jobs\\+\\w+@adp\\.com"]) {
    assert.equal(coversProtectedSender(validatePatternSource(pattern).re), true, pattern);
  }
  const r = acceptProposal({ pattern: "noreply@.*", targetField: "from", offendingMail: { ...promo, from: "noreply@example-promo.com" } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /hiring-system or generic no-reply/);
  // A marketing sender that never sends hiring mail is still learnable.
  assert.equal(acceptProposal({ pattern: "deals@noreply\\.example-promo\\.com", targetField: "from", offendingMail: promo }).ok, true);
  assert.equal(coversProtectedSender(validatePatternSource("careerflow\\.ai").re), false);
});

test("protected senders: stored bad rules are skipped when loaded, without a DB write", () => {
  const learner = read("../../src/services/mailRegexLearner.js");
  assert.match(learner, /if \(d\.targetField === "from" && coversProtectedSender\(v\.re\)\) continue;/);
});
