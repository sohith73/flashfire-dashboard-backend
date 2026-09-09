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
// Output shape mirrors mailAiSummarizer.summarizeMail() so the poll worker and
// MailDigest are agnostic to which classifier produced the result:
//   { aiModel:"rules", aiSucceeded:false, matched, category, priority,
//     summary, keyPoints, actionRequired, urls }

import { extractUrls } from "./gmailMessage.js";

// ── Rejection: multi-word phrases only, so a stray "unfortunately" in a
// reschedule note doesn't nuke a real interview invite. Checked before any
// positive category and wins outright.
const REJECTION = [
  /\bregret to inform\b/i,
  /\bwe regret\b/i,
  /\bnot (?:be )?(?:moving|going|proceeding|progressing) forward\b/i,
  /\bwill not be (?:moving|proceeding|progressing)\b/i,
  /\bdecided not to (?:move|proceed|progress)\b/i,
  /\bdecided to (?:move|proceed) (?:forward |ahead )?with (?:other|another)\b/i,
  /\bwe have decided to pursue\b/i,
  /\bother candidates\b/i,
  /\bmore closely (?:match|aligned)\b/i,
  /\bnot (?:be )?selected\b/i,
  /\bnot (?:been )?selected\b/i,
  /\bwere not selected\b/i,
  /\bposition has been filled\b/i,
  /\brole has been filled\b/i,
  /\bno longer (?:being )?(?:under )?consider(?:ed|ation)\b/i,
  /\bunfortunately,? (?:we|after|your|the|you)\b/i,
  /\bafter careful consideration,? we\b/i,
  /\bwish you (?:the best|luck|success)\b/i,
  /\bnot (?:a )?(?:the )?right fit\b/i,
  /\bwon'?t be (?:moving|proceeding)\b/i,
  /\bapplication (?:was )?(?:unsuccessful|not successful)\b/i
];

// ── Positive milestone categories (client-notifiable) ──
const OFFER = [
  /\boffer letter\b/i,
  /\bletter of (?:offer|employment)\b/i,
  /\boffer of employment\b/i,
  /\b(?:job|employment|formal|verbal|written|final) offer\b/i,
  /\b(?:pleased|excited|delighted|happy) to (?:offer|extend)\b/i,
  /\b(?:extend|extending|present)(?:ing)? (?:you )?an offer\b/i,
  /\bwe(?:'| a)re (?:pleased|excited|delighted|thrilled) to\b.*\boffer\b/i,
  /\byour offer\b/i,
  /\boffer (?:details|package)\b/i,
  /\bwelcome to the team\b/i,
  /\bwelcome aboard\b/i
];

const INTERVIEW = [
  /\binterview (?:invit|request|invitation|schedule|scheduling)\w*/i,
  /\binvit\w+ (?:you )?(?:to|for) (?:an? )?interview\b/i,
  /\b(?:schedule|set up|book|arrange) (?:an? |a )?(?:interview|call|time|meeting)\b/i,
  /\bwould like to (?:interview|schedule|set up|invite|speak|chat|connect)\b/i,
  /\b(?:phone|technical|onsite|on-site|video|final|first|second|initial) (?:screen|interview|round)\b/i,
  /\binterview (?:with|for|process)\b/i,
  /\bavailab\w+ (?:for|to) (?:a |an )?(?:call|interview|chat|meeting)\b/i,
  /\bnext (?:round|step|stage)\b/i,
  /\bmove(?:d)? (?:you )?(?:forward|to the next)\b/i,
  /\b(?:calendly|book a time|pick a (?:time|slot))\b/i,
  /\breschedul\w+/i,
  /\b(?:another|a different|a new) time\b/i
];

const ASSESSMENT = [
  /\b(?:coding|technical|online|skills?|take[- ]?home) (?:assessment|challenge|test|exercise|task|assignment)\b/i,
  /\btake[- ]?home\b/i,
  /\bassignment\b/i,
  /\b(?:hackerrank|codility|coderpad|codesignal|leetcode|hackerearth|testgorilla|karat)\b/i,
  /\bonline assessment\b/i,
  /\bcomplete (?:the|this|a|your) (?:assessment|challenge|test|assignment|exercise)\b/i,
  /\bskills? (?:test|challenge)\b/i
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
const JOB_BOARD_SENDERS = /@(?:linkedin|indeed|ziprecruiter|glassdoor|monster|dice|wellfound|angellist|naukri|hired)\./i;

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

  const isRejection = anyMatch(REJECTION, hay);

  let category = "other";
  let priority = "low";
  let matched = false;

  const classifyPositive = (name, patterns) => {
    const inSubject = anyMatch(patterns, subj);
    const inBody = anyMatch(patterns, body);
    if (!inSubject && !inBody) return false;
    category = name;
    priority = inSubject ? "high" : "medium";
    matched = true;
    return true;
  };

  if (isRejection) {
    // Hard override — never a positive milestone, regardless of other keywords.
    category = "rejection";
    priority = "low";
    matched = true;
  } else if (
    classifyPositive("offer", OFFER) ||
    classifyPositive("interview", INTERVIEW) ||
    classifyPositive("assessment", ASSESSMENT)
  ) {
    // matched set inside
  } else if (anyMatch(RECRUITER, hay)) {
    category = "recruiter-outreach";
    priority = "low";
    matched = true;
  } else if (anyMatch(JOB_ALERT, hay) || JOB_BOARD_SENDERS.test(fromLc)) {
    category = "job-alert";
    priority = "low";
    matched = true;
  } else if (anyMatch(SECURITY, hay)) {
    category = "account-security";
    priority = "low";
    matched = true;
  } else if (NEWSLETTER_SENDERS.test(fromLc)) {
    category = "newsletter";
    priority = "low";
    matched = true;
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

// Exported for the verification script.
export const __patterns = { REJECTION, OFFER, INTERVIEW, ASSESSMENT, RECRUITER, JOB_ALERT, SECURITY };
