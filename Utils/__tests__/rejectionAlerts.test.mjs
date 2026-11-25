// Rejections: detect them, record them, tell nobody.
//
// The rules classifier flags rejection mail and the digest stores the verdict,
// so the data is queryable. Nothing is delivered off the back of it:
//
//   • NO Discord line. Ops asked for that to stop (28 Sept 2026); a steady
//     trickle of bad news is not what the mail channel is for.
//   • NO client email, ever. Telling somebody by robot that they were turned
//     down is not a thing this product does.
//
// The AI check still runs, for one reason only: when it catches a false
// positive it has the regex learner write an exclusion, which is what keeps the
// rejection patterns sharpening. That loop is the whole remaining point.
//
// Pure functions and source checks. No Mongo, no OpenAI, nothing sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { classifyMailByRules, rejectionSignal } = await import("../mailRulesClassifier.js");
const { GENUINE_REJECTION_FIXTURES, acceptProposal, LEARNABLE_CATEGORIES } = await import(
  "../../src/services/mailRegexLearner.js"
);
const { NOTIFIABLE_CATEGORIES } = await import("../clientMailTemplates.js");

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const classify = (from, subject, body) =>
  classifyMailByRules({ from, subject, bodyText: body, snippet: body.slice(0, 120) });

// The rejection side lives in verifyAsRejection(); the branch calls it and may
// only leave the rejection path when the milestone verifier confirms an invite.
const rejectionHelper = (worker) => worker.slice(worker.indexOf("async function verifyAsRejection"), worker.indexOf("// ─── Discord delivery"));
const rejectionBranch = (worker) => {
  const from = worker.indexOf('} else if (ai.category === "rejection") {');
  return worker.slice(from, worker.indexOf("// Self-correction", from));
};

// ── nothing is delivered ──────────────────────────────────────────────────

test("no Discord line exists for a rejection any more", () => {
  const discord = read("../discordMailNotify.js");
  assert.equal(/notifyRejectionLine/.test(discord), false, "the rejection embed builder must be gone");
  assert.equal(/REJECTION_WEBHOOK/.test(discord), false, "and so must its webhook");

  const worker = read("../../src/services/mailPollWorker.js");
  assert.equal(/opsRejectionEligible/.test(worker), false, "no flag can route a rejection to Discord");
  assert.equal(/notifyRejectionLine/.test(worker), false);
});

test("the rejection branch leaves every delivery flag false", () => {
  const worker = read("../../src/services/mailPollWorker.js");
  assert.ok(worker.indexOf('} else if (ai.category === "rejection") {') > -1, "the rejection branch must still exist - detection is kept");
  assert.match(rejectionBranch(worker), /await verifyAsRejection\(vctx\)/);
  assert.match(rejectionBranch(worker), /if \(m\.verdict\.genuine\)/, "only a CONFIRMED invite leaves the rejection path");
  const branch = rejectionHelper(worker);

  assert.match(branch, /clientNotifyEligible: false/);
  assert.match(branch, /opsNotifyEligible: false/);
  assert.equal(/clientNotifyEligible: true/.test(branch), false);
  assert.equal(/opsNotifyEligible: true/.test(branch), false);
  assert.match(branch, /rejection_recorded_only/, "the digest says why nothing went out");
});

test("a rejection can never be emailed to a client", () => {
  // The client templates only know the three positive categories, so there is
  // no rejection mail to render even if something tried.
  assert.deepEqual(NOTIFIABLE_CATEGORIES, ["interview", "assessment", "offer"]);
  assert.equal(NOTIFIABLE_CATEGORIES.includes("rejection"), false);

  const notifier = read("../../src/services/clientMailNotifier.js");
  const line = notifier.split("\n").find((l) => l.includes("NOTIFY_CATEGORIES = new Set"));
  assert.ok(line, "the notifier's own category gate must exist");
  assert.equal(/rejection/.test(line), false, "rejection must not be a notifiable category");
});

// ── detection is kept, and sharper ────────────────────────────────────────

test("every canonical rejection is still detected", () => {
  for (const f of GENUINE_REJECTION_FIXTURES) {
    assert.equal(classify(f.from, f.subject, f.body).category, "rejection", f.subject);
  }
});

test("the phrasings employers and ATS systems actually use", () => {
  const bodies = [
    "We have moved forward with another candidate for this role.",
    "After reviewing your candidacy, we have decided to move in a different direction.",
    "You were not shortlisted for the Backend Engineer position.",
    "You did not progress to the next round following the technical screen.",
    "Your candidacy has concluded for this requisition.",
    "Regretfully, we will not be extending an offer at this time.",
    "The requisition has been closed and the position is no longer available.",
    "We have filled the position internally.",
    "You were unsuccessful on this occasion.",
    "We won't be able to move forward with your application.",
    "We regret to inform you that we will not be proceeding with your application.",
    "Thank you for your interest. We will keep your resume on file."
  ];
  for (const body of bodies) {
    assert.equal(classify("hr@acme.com", "Your application", body).category, "rejection", body);
  }
});

test("a rejection still beats interview and offer wording in the same mail", () => {
  const c = classify(
    "talent@acme.com",
    "Your interview with Acme",
    "Thank you for interviewing with us. Unfortunately, we have decided to move forward with other candidates. We are unable to offer you the position."
  );
  assert.equal(c.category, "rejection");
});

test("the broadened patterns do not swallow good news", () => {
  const safe = [
    ["We would like to invite you to a technical interview. Please pick a slot.", "interview"],
    ["Thank you for applying. We have received your application and will be in touch.", "job-application"],
    ["We are pleased to extend a formal offer for the Senior Engineer position.", "offer"],
    ["Complete your Codility assessment for the Software Engineer role within 5 days.", "assessment"]
  ];
  for (const [body, want] of safe) {
    assert.equal(classify("hr@acme.com", "Update", body).category, want, body);
  }
  // "moving forward with" is a rejection phrase only when somebody ELSE got it.
  const onboarding = classify("hr@acme.com", "Welcome", "Moving forward with your onboarding, please complete the forms.");
  assert.notEqual(onboarding.category, "rejection");
});

test("one weak phrase on its own is not a rejection", () => {
  const stillOpen = classify(
    "jane@acme.com",
    "Next steps",
    "We have other candidates in the pipeline, but we liked your profile and would like to schedule an interview."
  );
  assert.equal(stillOpen.category, "interview");
  assert.notEqual(classify("friend@example.com", "Good luck", "Best of luck with the new job!").category, "rejection");
});

test("two weak phrases together are enough to record", () => {
  const c = classify(
    "no-reply@acme.com",
    "Your application",
    "We went with other candidates whose background more closely matches the role. We wish you the best."
  );
  assert.equal(c.category, "rejection");
  assert.equal(c.priority, "low", "weak evidence is flagged low and the AI verifier decides");
});

test("a subject-line rejection outranks a body-only one", () => {
  assert.equal(rejectionSignal("We regret to inform you", "").priority, "high");
  assert.equal(rejectionSignal("Your application", "We regret to inform you").priority, "medium");
  assert.equal(rejectionSignal("Hello", "Nothing to see here").hit, false);
});

// ── the learning loop, which is the point of still verifying ──────────────

test("rejection is a category the regex learner may write rules for", () => {
  assert.equal(LEARNABLE_CATEGORIES.has("rejection"), true);
});

test("the AI check still runs so the learner keeps getting taught", () => {
  const worker = read("../../src/services/mailPollWorker.js");
  const branch = rejectionHelper(worker);
  assert.match(branch, /verifyRejectionMail/);
  assert.match(branch, /proposeAndStoreExclusion/, "a false positive must still teach an exclusion");
});

test("a learned rejection exclusion may not eat a real rejection", () => {
  const greedy = acceptProposal({
    pattern: "unfortunately",
    targetField: "body",
    offendingMail: { subject: "x", from: "y@z.com", body: "unfortunately this newsletter is ending" },
    fixtures: GENUINE_REJECTION_FIXTURES
  });
  assert.equal(greedy.ok, false);
  assert.match(greedy.reason, /matches genuine mail/);

  const narrow = acceptProposal({
    pattern: "this newsletter is ending",
    targetField: "body",
    offendingMail: { subject: "x", from: "y@z.com", body: "unfortunately this newsletter is ending" },
    fixtures: GENUINE_REJECTION_FIXTURES
  });
  assert.equal(narrow.ok, true, narrow.reason);
});
