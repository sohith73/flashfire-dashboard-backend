// Verification for the zero-AI rules classifier + client-alert eligibility.
//
//   npm run verify:mail-rules
//
// The headline property: a REJECTION email that contains the words "interview"
// or "offer" must NEVER be classified as a positive milestone (which would fire
// a false "you got an offer!" alert). Every rejection case below is a real-world
// phrasing that also mentions a positive keyword.

import { classifyMailByRules } from "../Utils/mailRulesClassifier.js";
import { deriveEligibility } from "../src/services/clientMailNotifier.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const classify = (subject, body = "", from = "recruiter@company.com") =>
  classifyMailByRules({ subject, bodyText: body, from, snippet: body.slice(0, 120) });

// eligible? runs the SAME path the worker uses.
const eligible = (c) =>
  deriveEligibility({ ...c, confident: c.aiSucceeded === true || c.matched === true }).clientNotifyEligible;

// ─────────────────────────────────────────────────────────────
console.log("\n[1] Positive milestones are detected + eligible");
{
  const interview = classify("Interview invitation — Backend Engineer", "We'd like to invite you to interview this week. Please schedule a time.");
  ok("interview category", interview.category === "interview", interview.category);
  ok("interview high priority (subject hit)", interview.priority === "high");
  ok("interview eligible", eligible(interview) === true);
  ok("interview gets action line", /confirm a time/i.test(interview.actionRequired));

  const offer = classify("Your offer from Vertex Labs", "We are pleased to offer you the Senior Engineer position.");
  ok("offer category", offer.category === "offer", offer.category);
  ok("offer eligible", eligible(offer) === true);

  const assign = classify("Take-home assignment for Frontend role", "Please complete the coding assessment on HackerRank within 3 days.");
  ok("assessment category", assign.category === "assessment", assign.category);
  ok("assessment eligible", eligible(assign) === true);

  // Body-only match → medium priority, still eligible (min is medium)
  const bodyOnly = classify("Update on your application", "Good news — we'd like to schedule an interview with you.");
  ok("body-only interview → medium", bodyOnly.category === "interview" && bodyOnly.priority === "medium", `${bodyOnly.category}/${bodyOnly.priority}`);
  ok("body-only interview still eligible", eligible(bodyOnly) === true);
}

// ─────────────────────────────────────────────────────────────
console.log("\n[2] REJECTIONS that mention interview/offer must NOT be milestones");
{
  const cases = [
    ["Regarding your interview", "Thank you for taking the time to interview with us. Unfortunately, we have decided to move forward with other candidates."],
    ["Your application to Acme", "After careful consideration, we regret to inform you that we will not be moving forward with your application."],
    ["Update on Senior Engineer role", "We enjoyed our interview, but unfortunately you were not selected for this position."],
    ["Thank you for your interest", "We've decided to pursue other candidates whose experience more closely matches the role."],
    ["Interview feedback", "Unfortunately, after your interview, the team decided not to proceed. We wish you the best."],
    ["Re: Offer discussion", "Unfortunately, we are not able to extend an offer at this time. The position has been filled."],
    ["Application status", "Your application was unsuccessful on this occasion."]
  ];
  for (const [subj, body] of cases) {
    const c = classify(subj, body);
    ok(`rejection: "${subj}" → rejection`, c.category === "rejection", `got ${c.category}`);
    ok(`rejection: "${subj}" NOT eligible`, eligible(c) === false, `eligible with category ${c.category}!`);
  }
}

// ─────────────────────────────────────────────────────────────
console.log("\n[3] Noise is classified but never emails the client");
{
  const alert = classify("5 new jobs matching your search", "Software Engineer roles for you.", "jobs-noreply@linkedin.com");
  ok("linkedin alert → job-alert", alert.category === "job-alert", alert.category);
  ok("job-alert not eligible", eligible(alert) === false);

  const board = classify("New opportunities", "Check these out", "alerts@indeed.com");
  ok("indeed sender → job-alert", board.category === "job-alert", board.category);

  const recruiter = classify("Exciting opportunity at a startup", "I came across your profile and wanted to reach out about an opening.");
  ok("recruiter outreach detected", recruiter.category === "recruiter-outreach", recruiter.category);
  ok("recruiter not eligible (positive-only)", eligible(recruiter) === false);

  const sec = classify("Verify your email address", "Please confirm your account.", "noreply@github.com");
  ok("security detected", sec.category === "account-security", sec.category);
  ok("security not eligible", eligible(sec) === false);

  const news = classify("This week in tech", "Top stories and updates.", "newsletter@medium.com");
  ok("newsletter sender detected", news.category === "newsletter", news.category);

  const junk = classify("hey", "lunch tomorrow?", "friend@gmail.com");
  ok("unmatched → other, not matched", junk.category === "other" && junk.matched === false);
  ok("other not eligible", eligible(junk) === false);
}

// ─────────────────────────────────────────────────────────────
console.log("\n[4] Output shape is digest-compatible + deterministic summary");
{
  const c = classify("Interview invitation", "Join here: https://meet.google.com/abc-defg . Reschedule if needed.");
  ok("aiSucceeded false (no AI)", c.aiSucceeded === false);
  ok("aiModel = rules", c.aiModel === "rules");
  ok("summary is the snippet/body text", c.summary.includes("Join here"));
  ok("urls extracted deterministically", c.urls[0] === "https://meet.google.com/abc-defg", JSON.stringify(c.urls));
  ok("keyPoints empty (no AI)", Array.isArray(c.keyPoints) && c.keyPoints.length === 0);

  // A reschedule note with a lone 'unfortunately'-free negative should stay interview.
  const resched = classify("Re: Interview", "Sorry, that slot no longer works — can we find another time?");
  ok("reschedule stays interview (no false rejection)", resched.category === "interview", resched.category);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
