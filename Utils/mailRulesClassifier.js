// Deterministic, zero-AI mail classifier.
//
// Classifies an inbound job-search email into the same category vocabulary the
// AI summarizer used, using ordered keyword rules. No network, no cost.
//
// The single most important property: a REJECTION must never be classified as a
// positive milestone. Rejection emails routinely contain the words "interview"
// and "offer" ("thank you for interviewing with us, but unfortunately…"), so a
// naive /offer/ match would fire a "🏆 You got an offer!" alert on bad news.
// Rejection language is therefore checked FIRST and hard-overrides the positive
// categories.
//
// Second property (Sept 2026, after a Reddit jobs digest reached Discord as an
// "Offer" and a Bloomberg "thank you for applying" as an "Interview"): two kinds
// of mail are decided BEFORE the positive keywords get a look.
//   • Mass-mail senders (job boards, Reddit, Medium, Substack...) are never a
//     milestone, whatever their body says. Real invites do not come from them.
//   • ATS housekeeping ("candidate account creation", "complete your profile")
//     in the SUBJECT is "job-application" unless that subject also carries a
//     milestone phrase. Application acknowledgements ("thank you for applying")
//     are "job-application" too, but only once no strong milestone phrase was
//     found; their "next step" / "move forward" boilerplate is weak (below).
// On top of that the positive lists are split into STRONG and WEAK phrases. A
// weak phrase ("next step", "your offer", "assignment") counts only in the
// subject, or when a strong phrase is also present; alone in the body it is
// too common in promos and auto-acks to mean anything.
//
// Output shape mirrors mailAiSummarizer.summarizeMail() so the poll worker and
// MailDigest are agnostic to which classifier produced the result:
//   { aiModel:"rules", aiSucceeded:false, matched, category, priority,
//     summary, keyPoints, actionRequired, urls }

import { extractUrls } from "./gmailMessage.js";

// ── Rejection ────────────────────────────────────────────────────────
// Checked FIRST and wins outright over every positive category. Rejection mail
// routinely contains "interview" and "offer" ("thank you for interviewing with
// us, but unfortunately..."), so a naive /offer/ match would fire a "you got an
// offer!" alert on bad news.
//
// Split the same way as the positives (Sept 2026). STRONG phrases only ever
// appear in a real rejection. WEAK ones appear in rejections but also in
// ordinary recruiter mail - "we have other candidates in the pipeline, but we
// liked your profile" is not a rejection, and neither is a friendly sign-off
// that wishes somebody luck. One weak phrase is not evidence; two together are.
const REJECTION_STRONG = [
  // Regret and refusal
  /\bregret(?:fully)? to inform\b/i,
  /\bwe regret\b/i,
  /\bregretfully,? we\b/i,
  /\bunfortunately,? (?:we|after|your|the|you)\b/i,
  /\bafter careful consideration,? we\b/i,
  /\bafter (?:carefully )?reviewing your (?:application|profile|resume|cv|candidacy),? we\b/i,

  // Not proceeding
  /\bnot (?:be )?(?:moving|going|proceeding|progressing) (?:forward|ahead)\b/i,
  /\bwill not be (?:moving|proceeding|progressing|continuing)\b/i,
  /\b(?:won'?t|will not|cannot|can'?t) be able to (?:move|proceed|progress)\b/i,
  /\bwon'?t be (?:moving|proceeding|progressing)\b/i,
  /\bdecided not to (?:move|proceed|progress|continue)\b/i,
  /\bnot to proceed with your (?:application|candidacy)\b/i,
  /\bunable to (?:offer|move forward|progress|proceed)\b/i,
  /\bnot progressing your (?:application|candidacy)\b/i,
  /\bwill not be extending an offer\b/i,
  /\bat this time,? we (?:will not|are not|have decided|cannot)\b/i,

  // Someone else got it
  /\bdecided to (?:move|proceed|go) (?:forward |ahead )?with (?:other|another)\b/i,
  /\b(?:moving|moved) forward with (?:other|another|candidates whose)\b/i,
  /\b(?:chosen|selected|decided) to (?:move forward|proceed) with (?:another|other)\b/i,
  /\bwe have decided to pursue\b/i,
  /\bpursu(?:e|ing) (?:other|another) (?:candidates?|applicants?)\b/i,
  /\b(?:selected|chosen) another candidate\b/i,
  /\bmove in a different direction\b/i,

  // Not selected
  /\bnot (?:be |been )?selected\b/i,
  /\bwere not selected\b/i,
  /\bnot (?:been )?shortlisted\b/i,
  /\bdid not (?:make it|progress|advance) to the next (?:round|stage|step)\b/i,
  /\bno longer (?:being )?(?:under )?consider(?:ed|ation)\b/i,
  /\bcandidacy has (?:concluded|ended)\b/i,
  /\bnot (?:a )?(?:the )?right fit\b/i,
  /\bapplication (?:was |has been )?(?:unsuccessful|not successful|declined|rejected)\b/i,
  /\bunsuccessful (?:in|on) (?:your|this) (?:application|occasion)\b/i,

  // The role is gone
  /\b(?:position|role|vacancy|req(?:uisition)?) (?:has been|was) (?:filled|closed)\b/i,
  /\bwe have filled (?:the|this) (?:position|role)\b/i,
  /\b(?:position|role|opportunity) is no longer (?:available|open)\b/i,

  // The classic closing line
  /\bkeep your (?:resume|cv|details|profile) on file\b/i
];

const REJECTION_WEAK = [
  /\bother candidates\b/i,
  /\bmore closely (?:match|aligned)\b/i,
  /\bwish you (?:the best|luck|success|all the best)\b/i,
  /\bbest of luck\b/i,
  /\bfuture opportunities\b/i
];

/** Exported so the verify script can report which half fired. */
export function rejectionSignal(subject, body) {
  const hay = `${subject}\n${body}`;
  if (anyMatch(REJECTION_STRONG, subject)) return { hit: true, strength: "strong", priority: "high" };
  if (anyMatch(REJECTION_STRONG, body)) return { hit: true, strength: "strong", priority: "medium" };
  // Two independent weak phrases. One on its own is ordinary recruiter English.
  const weakHits = REJECTION_WEAK.filter((re) => re.test(hay)).length;
  if (weakHits >= 2) return { hit: true, strength: "weak", priority: "low" };
  return { hit: false, strength: "", priority: "low" };
}

// ── Positive milestone categories (client-notifiable) ──
// STRONG: the phrase only appears when the mail really is about this step.
// WEAK: real invites use it too, but so do promos and auto-acks. See header.
const OFFER = [
  /\boffer letter\b/i,
  /\bletter of (?:offer|employment)\b/i,
  /\boffer of employment\b/i,
  /\b(?:job|employment|formal|verbal|written|final) offer\b/i,
  /\b(?:pleased|excited|delighted|happy) to (?:offer|extend)\b/i,
  /\b(?:extend|extending|present)(?:ing)? (?:you )?an offer\b/i,
  /\bwe(?:'| a)re (?:pleased|excited|delighted|thrilled) to\b.*\boffer\b/i
];
const OFFER_WEAK = [/\byour offer\b/i, /\boffer (?:details|package)\b/i, /\bwelcome to the team\b/i, /\bwelcome aboard\b/i];

const INTERVIEW = [
  /\binterview (?:invit|request|invitation|schedule|scheduling)\w*/i,
  /\binvit\w+ (?:you )?(?:to|for) (?:an? )?interview\b/i,
  /\b(?:schedule|set up|book|arrange) (?:an? |your |the )?(?:interview|call|time|meeting)\b/i,
  /\bwould like to (?:interview|schedule|set up|invite|speak|chat|connect)\b/i,
  /\b(?:phone|technical|onsite|on-site|video|final|first|second|initial) (?:screen|interview|round)\b/i,
  /\binterview (?:with|for|process)\b/i,
  /\bavailab\w+ (?:for|to) (?:a |an )?(?:call|interview|chat|meeting)\b/i,
  /\b(?:calendly|book a time|pick a (?:time|slot))\b/i
];
// The bare word in a SUBJECT is a strong signal on its own ("Re: Interview",
// "Interview confirmed"); in a body it is not (every rejection has it).
const INTERVIEW_SUBJECT = [/\binterviews?\b/i];
const INTERVIEW_WEAK = [
  /\bnext (?:round|step|stage)\b/i,
  /\bmove(?:d)? (?:you )?(?:forward|to the next)\b/i,
  /\breschedul\w+/i,
  /\b(?:another|a different|a new) time\b/i
];

const ASSESSMENT = [
  /\b(?:coding|technical|online|skills?|take[- ]?home) (?:assessment|challenge|test|exercise|task|assignment)\b/i,
  /\b(?:hackerrank|codility|coderpad|codesignal|leetcode|hackerearth|testgorilla|karat)\b/i,
  /\bonline assessment\b/i,
  /\bcomplete (?:the|this|a|your) (?:assessment|challenge|test|assignment|exercise)\b/i,
  /\bskills? (?:test|challenge)\b/i
];
const ASSESSMENT_SUBJECT = [/\bassessments?\b/i];
const ASSESSMENT_WEAK = [/\btake[- ]?home\b/i, /\bassignment\b/i];

// ── Application acknowledgements ──
// "Thank you for applying" and friends. Their bodies routinely say "next step"
// or "move forward" about a process that has not started, which is why those
// phrases are WEAK above. A strong phrase in the body ("we would like to
// schedule an interview") still wins over an ack subject: some employers send
// the invite under the same "Update on your application" subject line.
const APPLICATION_ACK = [
  /\bthank(?:s| you) for (?:your )?(?:application|applying|submitting|interest)\b/i,
  /\bapplication (?:has been |was |is )?(?:received|submitted|complete|confirmed|under review|in review)\b/i,
  /\b(?:we(?:'ve| have) )?received your application\b/i,
  /\bapplication (?:confirmation|receipt|status|update)\b/i,
  /\byour application (?:to|for|with|has been|is|was)\b/i,
  /\b(?:update|status|news) on your application\b/i
];

// ── ATS housekeeping, decided BEFORE the positive lists ──
// Candidate-account creation, profile completion, portal passwords. A subject
// like "REMINDER: KBR Candidate Account Home Creation" is never an offer, no
// matter what boilerplate the body carries ("welcome aboard", "your offer of
// employment, if extended, will appear here").
const ATS_HOUSEKEEPING = [
  /\bcandidate (?:account|home|profile|portal)\b/i,
  /\b(?:create|set ?up|activate|complete|verify) your (?:candidate |applicant |career )?(?:account|profile)\b/i,
  /\baccount (?:creation|activation|created|setup)\b/i,
  /\bprofile (?:creation|created|setup|completion)\b/i,
  /\b(?:careers?|candidate|applicant) portal (?:password|login|access)\b/i
];

// ── Non-notifiable categories (classified for Discord + accuracy, never emailed) ──
const RECRUITER = [
  /\b(?:came across|found|saw) your (?:profile|resume|linkedin|background)\b/i,
  /\breaching out (?:about|regarding|because)\b/i,
  /\b(?:exciting|great|new) (?:opportunity|opening|role|position)\b/i,
  /\bopportunity (?:at|with|for)\b/i,
  /\bwe(?:'| a)re hiring\b/i,
  /\bopen (?:role|position|opportunity)\b/i
];

const JOB_ALERT = [
  /\bjobs? (?:for you|matching|you might|recommended|alert)\b/i,
  /\bnew jobs?\b/i,
  /\brecommended (?:jobs?|for you)\b/i,
  /\b\d+ new (?:jobs?|opportunities|roles?)\b/i,
  /\bbased on your (?:search|profile|activity)\b/i
];

const SECURITY = [
  /\b(?:verify your|confirm your) (?:email|account|identity)\b/i,
  /\b(?:reset|change) your password\b/i,
  /\bsecurity (?:alert|code|notification)\b/i,
  /\b(?:new )?sign[- ]?in\b/i,
  /\b(?:one[- ]?time|verification) (?:code|password)\b/i,
  /\b(?:otp|2fa|two[- ]factor)\b/i
];

const NEWSLETTER_SENDERS = /(newsletter|digest|noreply|no-reply|updates?|notifications?|mailer|marketing)@/i;
// Job boards and aggregators: their mail is alerts and digests, never a step
// in an application the client made. Checked before the positive lists.
//
// talent.com is named in full. A bare "talent" also matched talent.icims.com
// and talent.icims.eu, the iCIMS applicant-tracking system that hundreds of
// employers (B&Q, Kingfisher, KPMG, First Citizens...) send real interview
// invites through, so every one of those was filed as a job-board alert.
const JOB_BOARD_SENDERS =
  /@(?:(?:[\w.-]+\.)?(?:linkedin|indeed|ziprecruiter|glassdoor|monster|dice|wellfound|angellist|naukri|hired|jobright|simplyhired|careerbuilder|lensa|joblist|remotive|weworkremotely|himalayas|wfh)\.[a-z.]+|(?:[\w.-]+\.)?talent\.com)\b/i;
// Content platforms: community digests and newsletters. A Reddit jobs thread
// mentioning "job offer" is not an offer. Checked before the positive lists.
const CONTENT_PLATFORM_SENDERS = /@(?:[\w.-]+\.)?(?:reddit|redditmail|medium|substack|quora|beehiiv|mailchimp|convertkit)\.[a-z.]+/i;

const anyMatch = (patterns, text) => patterns.some((re) => re.test(text));

// Generic, deterministic next-step line per notifiable category (no AI prose).
const ACTION = {
  interview: "Reply to confirm a time for the interview.",
  assessment: "Complete the assignment and submit it before the deadline.",
  offer: "Review the offer details and respond to the recruiter."
};

/**
 * Classify one email with rules only.
 *
 * @param {Object} mail
 * @param {string} mail.subject
 * @param {string} mail.from
 * @param {string} [mail.bodyText]
 * @param {string} [mail.snippet]  - Gmail's snippet; used as the deterministic summary
 * @returns {Object} digest-shaped classification (see file header)
 */
export function classifyMailByRules({ subject = "", from = "", bodyText = "", snippet = "" } = {}) {
  const subj = String(subject);
  const body = String(bodyText);
  const fromLc = String(from).toLowerCase();
  // Subject is the highest-signal field; a subject hit → "high", body-only → "medium".
  const hay = `${subj}\n${body}`;

  const rejection = rejectionSignal(subj, body);

  let category = "other";
  let priority = "low";
  let matched = false;

  const set = (name, prio) => {
    category = name;
    priority = prio;
    matched = true;
    return true;
  };

  // Strong phrase in the subject or body, or a weak phrase in the SUBJECT,
  // makes the category. A weak phrase alone in the body does not.
  const classifyPositive = (name, strong, weak, subjectOnly = []) => {
    const inSubject = anyMatch(strong, subj) || anyMatch(weak, subj) || anyMatch(subjectOnly, subj);
    if (inSubject) return set(name, "high");
    if (anyMatch(strong, body)) return set(name, "medium");
    return false;
  };

  // Decided before any positive phrase gets a look. See file header.
  const subjectHousekeeping = anyMatch(ATS_HOUSEKEEPING, subj);
  const subjectPositive = [
    OFFER, OFFER_WEAK,
    INTERVIEW, INTERVIEW_WEAK, INTERVIEW_SUBJECT,
    ASSESSMENT, ASSESSMENT_WEAK, ASSESSMENT_SUBJECT
  ].some((list) => anyMatch(list, subj));

  if (rejection.hit) {
    // Hard override — never a positive milestone, regardless of other keywords.
    // Priority carries how sure the phrasing was, which the AI verifier and the
    // ops Discord line both read.
    set("rejection", rejection.priority);
  } else if (JOB_BOARD_SENDERS.test(fromLc)) {
    set("job-alert", "low");
  } else if (CONTENT_PLATFORM_SENDERS.test(fromLc)) {
    set("newsletter", "low");
  } else if (subjectHousekeeping && !subjectPositive) {
    set("job-application", "low");
  } else if (
    classifyPositive("offer", OFFER, OFFER_WEAK) ||
    classifyPositive("interview", INTERVIEW, INTERVIEW_WEAK, INTERVIEW_SUBJECT) ||
    classifyPositive("assessment", ASSESSMENT, ASSESSMENT_WEAK, ASSESSMENT_SUBJECT)
  ) {
    // set inside
  } else if (anyMatch(APPLICATION_ACK, hay) || anyMatch(ATS_HOUSEKEEPING, hay)) {
    set("job-application", "low");
  } else if (anyMatch(RECRUITER, hay)) {
    set("recruiter-outreach", "low");
  } else if (anyMatch(JOB_ALERT, hay)) {
    set("job-alert", "low");
  } else if (anyMatch(SECURITY, hay)) {
    set("account-security", "low");
  } else if (NEWSLETTER_SENDERS.test(fromLc)) {
    set("newsletter", "low");
  }

  const urls = extractUrls(body, subj);
  const isNotifiable = category === "interview" || category === "assessment" || category === "offer";

  return {
    aiModel: "rules",
    aiSucceeded: false, // no AI wrote this
    matched, // a real category rule fired (not the "other" fallback)
    category,
    priority,
    // Deterministic "summary": Gmail's own snippet, or a trimmed body fallback.
    summary: (snippet || body).replace(/\s+/g, " ").trim().slice(0, 600),
    keyPoints: [],
    actionRequired: isNotifiable ? ACTION[category] : "",
    urls
  };
}

/** The fixed next-step line for a notifiable category ("" for anything else). */
export function actionForCategory(category) {
  return ACTION[category] || "";
}

// Exported for the verification script.
export const __patterns = {
  REJECTION_STRONG,
  REJECTION_WEAK,
  OFFER,
  OFFER_WEAK,
  INTERVIEW,
  INTERVIEW_WEAK,
  INTERVIEW_SUBJECT,
  ASSESSMENT,
  ASSESSMENT_WEAK,
  ASSESSMENT_SUBJECT,
  APPLICATION_ACK,
  ATS_HOUSEKEEPING,
  RECRUITER,
  JOB_ALERT,
  SECURITY,
  JOB_BOARD_SENDERS,
  CONTENT_PLATFORM_SENDERS
};
