// Which mails skip the AI second look (src/services/mailAiTriage.js).
//
// The second look runs on every client mail the regexes did not flag, EXCEPT
// clear marketing. Measured on live mail from 21 to 25 Nov 2026: of ~4,900
// triage calls, job-board alerts (790), sign-in and security mail (428) and
// recruiter blasts (50) never produced one verified milestone. Those are the
// calls this filter saves.
//
// Safety rule: a mail is only skipped when NOTHING in its subject or the start
// of its body hints at a hiring step or a decision. A job-board-looking mail
// that says "interview" (the 2026-11-20 B&Q invite sent through iCIMS was filed
// as a job alert) is still read.

import { normalizeMailText, FLASHFIRE_OWN_SENDERS, __patterns } from "./mailRulesClassifier.js";

const { JOB_BOARD_SENDERS, CONTENT_PLATFORM_SENDERS } = __patterns;

const BODY_HINT_CHARS = 1500;

// Any of these anywhere in the subject or body head means "read it".
const HIRING_HINT = new RegExp(
  [
    "interview", "assessment", "assignment", "offer letter", "job offer", "offer of employment", "extend(?:ing)? (?:you )?an offer",
    "schedul", "screening", "phone screen", "availability", "next (?:step|round|stage)", "talent screen", "meet the team",
    "coding (?:challenge|test|exercise)", "hackerrank", "codility", "codesignal", "hirevue", "take[- ]home",
    "(?:online|numerical|verbal|aptitude|cognitive|psychometric|competency|skills?|technical) (?:test|assessment|challenge)",
    "video (?:interview|introduction)",
    "unfortunately", "regret", "not (?:been )?(?:selected|successful|shortlisted)", "unsuccessful",
    "not (?:be )?(?:moving|proceeding|progressing)", "other (?:candidates|applicants)", "no longer (?:being )?consider",
    "application", "applied", "applying", "your candidacy", "candidate", "decision", "position", "vacancy", "role at",
    // Other languages clients' employers write in (German, French, Spanish/Italian, Dutch).
    "bewerbung", "stelle", "absage", "candidature", "candidat", "entretien", "candidatura", "colloquio", "entrevista", "sollicitatie",
  ].map((p) => `\\b${p}`).join("|"),
  "i"
);

// Marketing wording in a SUBJECT. Not "digest": Workday sends real assessment
// invites inside its "Workday Notification Digest".
const MARKETING_SUBJECT =
  /\b(?:\d{1,2}% off|sale|discount|coupon|promo(?:tion)?|deal|deals|free trial|limited time|last chance|black friday|cyber monday|webinar|masterclass|bootcamp|course|newsletter|weekly roundup|top \d+ (?:jobs|roles|companies))\b/i;

// Mass-mail mailboxes (local part) that never carry a hiring step on their own.
const MARKETING_SENDER = /^(?:[^<]*<)?(?:newsletter|news|marketing|promo(?:tions?)?|offers|deals|hello|community|events|webinars?)@/i;

// Sign-in codes and account mail.
const SECURITY_SUBJECT =
  /\b(?:verification code|one[- ]time (?:code|password|passcode)|otp|security code|sign[- ]?in (?:code|attempt|alert)|new sign[- ]?in|reset your password|password reset|verify your (?:email|account)|confirm your (?:email|account)|two[- ]factor|2fa)\b/i;

// "newsletter" is NOT here: the classifier files any noreply@ / notifications@
// sender as a newsletter, and that is how most applicant-tracking systems send
// real decisions. A newsletter is only skipped when the sender is a content
// platform or a marketing mailbox (checked below).
const SKIPPABLE_RULE_CATEGORIES = new Set(["job-alert"]);

/**
 * @param {{from?:string, subject?:string, bodyText?:string, snippet?:string, rulesCategory?:string}} mail
 * @returns {string} why the second look is skipped, or "" when it must run
 */
export function triageSkipReason({ from = "", subject = "", bodyText = "", snippet = "", rulesCategory = "" } = {}) {
  const fromLc = String(from).toLowerCase();
  if (rulesCategory === "flashfire-own" || FLASHFIRE_OWN_SENDERS.test(fromLc)) return "flashfire-own-mail";

  const subj = normalizeMailText(subject);
  const head = normalizeMailText(String(bodyText || snippet).slice(0, BODY_HINT_CHARS * 2)).slice(0, BODY_HINT_CHARS);
  if (HIRING_HINT.test(subj) || HIRING_HINT.test(head)) return "";

  if (SKIPPABLE_RULE_CATEGORIES.has(rulesCategory)) return `marketing:${rulesCategory}`;
  if (JOB_BOARD_SENDERS.test(fromLc)) return "marketing:job-board-sender";
  if (CONTENT_PLATFORM_SENDERS.test(fromLc)) return "marketing:content-platform";
  if (MARKETING_SENDER.test(fromLc)) return "marketing:sender";
  if (MARKETING_SUBJECT.test(subj)) return "marketing:subject";
  if (SECURITY_SUBJECT.test(subj)) return "account-security";
  if (rulesCategory === "account-security" && /\b(?:code|password|passcode|sign[- ]?in|log[- ]?in|verify|verification)\b/i.test(subj)) return "account-security";
  return "";
}

export const __test = { HIRING_HINT, MARKETING_SUBJECT, MARKETING_SENDER, SECURITY_SUBJECT };
