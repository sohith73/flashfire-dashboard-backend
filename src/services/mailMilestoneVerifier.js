// mailMilestoneVerifier — second-stage AI check for milestone candidates.
//
// The rules classifier (Utils/mailRulesClassifier.js) is deliberately loose:
// phrases like "next step", "book a time" or "would like to connect" appear in
// marketing mail, course promos and application auto-acknowledgements just as
// often as in real interview invites. That looseness produced the 2026-08-12
// false positive (an Amazon "Thank you for applying" auto-ack alerted a client
// with "you've got an interview") that got the whole client-milestone mail
// stream paused.
//
// This verifier runs ONLY on mails the rules already flagged as a notifiable
// milestone (interview / assessment / offer) — a handful per mailbox per day —
// and its single job is to REJECT false positives with full-mail context.
//
// Contract:
//   • FAIL-CLOSED for the client. If OpenAI is down or returns junk, the
//     result is { ok:false } and the caller must NOT email the client. The
//     ops Discord line still goes out (marked unverified) so a real invite is
//     never silently lost — it just isn't auto-forwarded to the client.
//   • temperature 0 + response_format json_object, same as the summarizer.
//   • Usage is recorded under the "mail-verify" source for the cost report.

import { recordAiUsage, AI_USAGE_SOURCES } from "../../Utils/aiUsage.js";
import { mailAiConfig, MISSING_KEY_ERROR } from "../../Utils/mailAiConfig.js";

// MAIL_VERIFY_MODEL still overrides the model for the verifier alone.
const MODEL = mailAiConfig(process.env, { modelOverride: process.env.MAIL_VERIFY_MODEL }).model;
const TIMEOUT_MS = Number(process.env.MAIL_VERIFY_TIMEOUT_MS) || 20000;
const MAX_BODY_CHARS = 9000;

const MILESTONE_CATEGORIES = new Set(["interview", "assessment", "offer"]);
const REJECTION_CATEGORIES = new Set(["rejection"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);
const REDIRECT_CATEGORIES = new Set(["interview", "assessment", "offer", "rejection"]);

const SYSTEM_PROMPT = `You are a strict verifier for a job-search operations team. Keyword rules flagged one email from a client's inbox as a possible career milestone (interview invite, assessment/assignment, or job offer). Most flagged emails are false positives. Your job is to reject them.

An email is a GENUINE milestone only if ALL of these hold:
- It is personally addressed to the candidate about a SPECIFIC application, role, or hiring process they are in.
- It comes from an employer, their recruiting team, or a scheduling/assessment tool acting for them (e.g. Calendly, HackerRank, Codility invites tied to a named company).
- It asks for or announces a concrete hiring step: scheduling or confirming an interview, completing a named assessment, or presenting an offer.

These ARE genuine, even though they are automated (they were wrongly turned down before, Nov 2026):
- A reminder to complete an assessment, test, video interview or interview the candidate was invited to for a named employer or role ("Reminder to complete your Amazon Assessment", "Complete the Online Assessment stage by tomorrow"). A pending step with a deadline is exactly what the candidate must not miss.
- An invitation or reminder from an assessment or video-interview platform acting for a named employer: HireVue, Criteria (CCAT), SHL, Sapia, Modern Hire, Spark Hire, Pymetrics, Harver, Codility, HackerRank, CodeSignal, TestGorilla, Testlify and similar.
- A calendar invitation, confirmation or reminder for an interview, screen or call with the employer or their recruiter ("Invitation: Interview with Akita Health @ Mon Nov 23", "Time confirmed: Talent Screen with Volter").
- An applicant-tracking-system mail (Workday, Greenhouse, iCIMS, Lever and others) that asks the candidate to complete a named assessment or book an interview for their application.

It is NOT a genuine milestone if it is any of:
- Marketing or promotional content, product updates, newsletters, webinar/course/bootcamp/career-coaching promotions.
- Job-board alerts or digests (LinkedIn, Indeed, ZipRecruiter, Glassdoor, etc.), "jobs for you" blasts.
- Mass recruiter outreach not tied to an application the candidate made ("came across your profile...").
- Automated application acknowledgements ("thank you for applying", "we received your application", "your application is under review") with no interview, assessment, or offer in them. Boilerplate like "the next step in the process" or "if selected we will contact you" inside such a mail is NOT a hiring step.
- ATS / careers-portal housekeeping: candidate account creation or activation, profile completion reminders, password or login mail from Workday, Greenhouse, Lever, iCIMS, Taleo, SuccessFactors and similar.
- Community and content digests (Reddit, Medium, Substack, forums) and listicles such as "13 high-paying remote jobs", even when they contain the words "job offer".
- Rejections, account/security mail, payment or billing mail.
- Notifications from FlashFire (flashfirehq.com) about a step: FlashFire already told the candidate, this is a copy.
- An assessment RESULT or a "thanks for completing" note with no further step.

Return ONLY a JSON object:
{
  "genuine": true | false,
  "category": "interview" | "assessment" | "offer" | "rejection" | "not-milestone",
  "confidence": "high" | "medium" | "low",
  "reason": "one short sentence naming the decisive evidence"
}

Rules: base the decision only on the email content given. When uncertain, return genuine=false. If the email is really a rejection of the candidate's application, return genuine=false with category "rejection". Output raw JSON only.`;

const REJECTION_SYSTEM_PROMPT = `You are a strict verifier for a job-search operations team. Keyword rules flagged one email from a candidate's inbox as a possible REJECTION of a job application they made. Your job is to confirm or reject that reading.

It is a GENUINE rejection only if ALL of these hold:
- It is addressed to this candidate about a SPECIFIC application, role, or hiring process they were in.
- It comes from the employer, their recruiting team, or the applicant-tracking system acting for them.
- It tells the candidate they are no longer being considered: not selected, not moving forward, the role was filled, or the application was declined.

It is NOT a genuine rejection if it is any of:
- An interview invitation, assessment invitation or offer. Those are the opposite outcome, even when the mail also mentions a previous rejection.
- An application acknowledgement ("thank you for applying", "we received your application", "we will be in touch") with no decision in it.
- A job-board digest, newsletter, marketing mail or careers-advice content, including articles about handling rejection.
- A withdrawal the candidate made themselves, an expired or cancelled posting with no decision about this candidate, or a rejection addressed to somebody else.
- A polite sign-off in an otherwise neutral mail. "Best of luck" or "other candidates" on their own do not make a rejection.

Return ONLY a JSON object:
{
  "genuine": true | false,
  "category": "rejection" | "interview" | "assessment" | "offer" | "not-rejection",
  "confidence": "high" | "medium" | "low",
  "reason": "one short sentence naming the decisive evidence",
  "company": "the employer the application was for, exactly as the email names it, or \"\"",
  "jobTitle": "the role the application was for, exactly as the email names it, or \"\""
}

Rules: base the decision only on the email content given. When uncertain, return genuine=false. If the email is really an interview invitation, assessment invitation or offer, return genuine=false with that category. For company and jobTitle copy the wording from the email and never guess: use "" when the email does not name them (a recruiting-platform name such as Greenhouse, Workday or Lever is not the employer). Output raw JSON only.`;

function clamp(text, max) {
  const s = String(text || "").trim();
  return s.length <= max ? s : s.slice(0, max) + "\n…[truncated]";
}

function cleanField(v) {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 120) : "";
}

function fail(error) {
  return {
    ok: false,
    genuine: false,
    category: "",
    confidence: "",
    reason: "",
    company: "",
    jobTitle: "",
    redirect: "",
    model: MODEL,
    error: String(error || "unknown").slice(0, 300)
  };
}

/**
 * Verify one rules-flagged milestone candidate.
 *
 * @param {Object} mail
 * @param {string} mail.from
 * @param {string} mail.subject
 * @param {string} [mail.bodyText]
 * @param {string} [mail.snippet]
 * @param {string} mail.rulesCategory - what the rules classifier thought it was
 * @returns {Promise<{ok:boolean, genuine:boolean, category:string, confidence:string, reason:string, model:string, error:string}>}
 *          Always resolves; ok=false means the AI check could not run — treat as unverified, never as genuine.
 */
export async function verifyMilestoneMail({ from, subject, bodyText, snippet, rulesCategory }) {
  return askVerifier({
    systemPrompt: SYSTEM_PROMPT,
    from,
    subject,
    bodyText,
    snippet,
    rulesCategory,
    allowed: MILESTONE_CATEGORIES,
    fallbackCategory: "not-milestone",
    usageSource: AI_USAGE_SOURCES.MAIL_VERIFY
  });
}

/**
 * Verify one rules-flagged REJECTION candidate.
 *
 * Same contract as verifyMilestoneMail, and the same fail-closed rule, but the
 * stakes are lower on this side: a rejection never reaches the client, so an
 * unverifiable one still earns its ops Discord line, marked unverified.
 *
 * @param {Object} mail
 * @param {string} mail.from
 * @param {string} mail.subject
 * @param {string} [mail.bodyText]
 * @param {string} [mail.snippet]
 *          Also returns `company` and `jobTitle` as the mail words them ("" when absent),
 *          which the auto-reject matcher uses to find the client's job card.
 * @returns {Promise<{ok:boolean, genuine:boolean, category:string, confidence:string, reason:string, company:string, jobTitle:string, model:string, error:string}>}
 */
export async function verifyRejectionMail({ from, subject, bodyText, snippet }) {
  return askVerifier({
    systemPrompt: REJECTION_SYSTEM_PROMPT,
    from,
    subject,
    bodyText,
    snippet,
    rulesCategory: "rejection",
    allowed: REJECTION_CATEGORIES,
    fallbackCategory: "not-rejection",
    usageSource: AI_USAGE_SOURCES.MAIL_VERIFY
  });
}

async function askVerifier({
  systemPrompt,
  from,
  subject,
  bodyText,
  snippet,
  rulesCategory,
  allowed,
  fallbackCategory,
  usageSource
}) {
  const ai = mailAiConfig(process.env, { modelOverride: process.env.MAIL_VERIFY_MODEL });
  if (!ai.apiKey) return fail(MISSING_KEY_ERROR);

  const userPrompt = [
    `Rules classifier guess: ${rulesCategory || "unknown"}`,
    `From: ${from || "unknown"}`,
    `Subject: ${subject || "(no subject)"}`,
    "",
    "--- EMAIL BODY ---",
    clamp(bodyText, MAX_BODY_CHARS) || clamp(snippet, 600) || "(empty body)"
  ].join("\n");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ai.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ai.apiKey}` },
      body: JSON.stringify({
        model: ai.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        response_format: { type: "json_object" },
        temperature: 0
      }),
      signal: ctrl.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return fail(`OpenAI HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    recordAiUsage({
      source: usageSource,
      model: data?.model || MODEL,
      usage: data?.usage
    });

    const content = data?.choices?.[0]?.message?.content;
    if (!content) return fail("OpenAI returned no content");

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return fail("OpenAI returned unparseable JSON");
    }

    const category = allowed.has(parsed?.category) ? parsed.category : fallbackCategory;
    // The verifier may say the rules picked the wrong side: a "milestone" that
    // is a rejection, or a "rejection" that is an invite. The pipeline then
    // re-checks the mail on the other side instead of dropping it.
    const raw = String(parsed?.category || "");
    const redirect = !allowed.has(raw) && REDIRECT_CATEGORIES.has(raw) ? raw : "";
    return {
      ok: true,
      genuine: parsed?.genuine === true && category !== fallbackCategory,
      category,
      redirect,
      confidence: CONFIDENCES.has(parsed?.confidence) ? parsed.confidence : "low",
      reason: typeof parsed?.reason === "string" ? parsed.reason.trim().slice(0, 300) : "",
      // Only the rejection prompt asks for these; the milestone prompt leaves them "".
      company: cleanField(parsed?.company),
      jobTitle: cleanField(parsed?.jobTitle),
      model: data?.model || MODEL,
      error: ""
    };
  } catch (e) {
    return fail(e?.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : e?.message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Final client-notify gate, pure and unit-testable.
 * A candidate may email the client only when the verifier RAN, said genuine,
 * agreed it is a notifiable category, and was at least medium-confident.
 *
 * @param {Object} verdict - result of verifyMilestoneMail()
 * @returns {{eligible:boolean, category:string, reason:string}}
 */
export function milestoneGate(verdict) {
  if (!verdict?.ok) {
    return { eligible: false, category: "", reason: `verifier_unavailable:${verdict?.error || "unknown"}` };
  }
  if (!verdict.genuine) {
    return { eligible: false, category: "", reason: `verifier_rejected:${verdict.reason || "not a milestone"}` };
  }
  if (verdict.confidence === "low") {
    return { eligible: false, category: "", reason: `verifier_low_confidence:${verdict.reason || ""}` };
  }
  return { eligible: true, category: verdict.category, reason: verdict.reason || "" };
}

export const __config = { MODEL, TIMEOUT_MS, MILESTONE_CATEGORIES, REJECTION_CATEGORIES };
