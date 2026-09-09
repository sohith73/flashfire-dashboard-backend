// mailVerifierLearning — the feedback loop behind the milestone verifier.
//
// The flow the team wants: regexes stay loose (recall), the AI verifier
// catches the false positives (precision), and every verdict is RECORDED so
// the system gets stricter over time. Two mechanisms, both deterministic:
//
//   1. Learned sender suppression. A domain the AI has rejected
//      SUPPRESS_AFTER_REJECTIONS times with ZERO genuine milestones is
//      suppressed before the AI call on later mails — no cost, no alert, the
//      verdict is already known. Free-mail providers and the big ATS /
//      scheduling / assessment platforms are PROTECTED and never suppressed:
//      one recruiter's junk from gmail.com must not blind us to another
//      recruiter's real invite from gmail.com.
//
//   2. Evidence for deliberate regex edits. Example subjects + rejection
//      reasons accumulate per domain (see GET /gmail/mail-verify/feedback).
//      Humans update Utils/mailRulesClassifier.js from that evidence, with
//      tests. The classifier NEVER rewrites itself at runtime.
//
// Every function here is fail-soft: a Mongo hiccup must never break the poll,
// and a read failure means "don't suppress" (the AI check still runs).

import { MailVerifierFeedback } from "../../Schema_Models/MailVerifierFeedback.js";

export const SUPPRESS_AFTER_REJECTIONS = 3;
const EXAMPLES_KEPT = 8;

// Domains that must always go to the AI, no matter how many rejections they
// rack up: shared mail providers (many unrelated senders behind one domain)
// and the platforms real interview/assessment mail actually comes from.
export const PROTECTED_DOMAINS = new Set([
  // shared / free mail
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
  // ATS / scheduling / assessment platforms
  "greenhouse.io", "greenhousemail.io", "lever.co", "hire.lever.co",
  "ashbyhq.com", "workablemail.com", "workable.com", "smartrecruiters.com",
  "breezy.hr", "jobvite.com", "personio.de", "personio.com", "recruitee.com",
  "myworkday.com", "icims.com", "bamboohr.com", "rippling.com",
  "calendly.com", "goodtime.io", "codility.com", "hackerrank.com",
  "codesignal.com", "testgorilla.com", "karat.com", "hackerearth.com"
]);

/** Lowercased registrable-ish domain of an email address ("" when unparseable). */
export function domainOf(email) {
  const s = String(email || "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 0 || at === s.length - 1) return "";
  return s.slice(at + 1);
}

/**
 * Pure suppression policy — unit-testable without Mongo.
 * Suppress only when: real domain, not protected, enough AI rejections, and
 * NOT ONE genuine milestone ever seen from it.
 */
export function decideSuppression({ domain, rejectCount = 0, genuineCount = 0 }) {
  if (!domain) return false;
  if (PROTECTED_DOMAINS.has(domain)) return false;
  if (genuineCount > 0) return false;
  return rejectCount >= SUPPRESS_AFTER_REJECTIONS;
}

/**
 * Should mail from this sender skip the AI and be dropped as a known false
 * positive? Fail-open: any read error → { suppress:false }.
 *
 * @returns {Promise<{suppress:boolean, domain:string, rejectCount:number}>}
 */
export async function shouldSuppressSender(fromEmail) {
  const domain = domainOf(fromEmail);
  if (!domain || PROTECTED_DOMAINS.has(domain)) return { suppress: false, domain, rejectCount: 0 };
  try {
    const doc = await MailVerifierFeedback.findOne({ domain })
      .select("rejectCount genuineCount")
      .lean();
    const rejectCount = doc?.rejectCount || 0;
    return {
      suppress: decideSuppression({ domain, rejectCount, genuineCount: doc?.genuineCount || 0 }),
      domain,
      rejectCount
    };
  } catch (e) {
    console.warn(`[mail-learn] suppression lookup failed for ${domain}: ${e.message}`);
    return { suppress: false, domain, rejectCount: 0 };
  }
}

/**
 * Record one verifier verdict for a sender domain. Fail-soft, never throws.
 * Only verdicts the AI actually produced are recorded (verdict.ok === true);
 * an outage teaches us nothing about the sender.
 */
export async function recordVerdict({ fromEmail, rulesCategory, subject, verdict }) {
  if (verdict?.ok !== true) return;
  const domain = domainOf(fromEmail);
  if (!domain) return;
  const example = {
    subject: String(subject || "").slice(0, 200),
    reason: String(verdict.reason || "").slice(0, 300),
    rulesCategory: String(rulesCategory || ""),
    genuine: verdict.genuine === true,
    at: new Date()
  };
  try {
    await MailVerifierFeedback.updateOne(
      { domain },
      {
        $inc: verdict.genuine === true ? { genuineCount: 1 } : { rejectCount: 1 },
        $set: { lastSeenAt: new Date() },
        $push: { examples: { $each: [example], $position: 0, $slice: EXAMPLES_KEPT } }
      },
      { upsert: true }
    );
  } catch (e) {
    console.warn(`[mail-learn] verdict record failed for ${domain}: ${e.message}`);
  }
}
