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

const OPENAI_URL = process.env.MAIL_AI_API_URL || "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.MAIL_VERIFY_MODEL || "gpt-4o-mini";
const TIMEOUT_MS = Number(process.env.MAIL_VERIFY_TIMEOUT_MS) || 20000;
const MAX_BODY_CHARS = 9000;

const MILESTONE_CATEGORIES = new Set(["interview", "assessment", "offer"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);

const SYSTEM_PROMPT = `You are a strict verifier for a job-search operations team. Keyword rules flagged one email from a client's inbox as a possible career milestone (interview invite, assessment/assignment, or job offer). Most flagged emails are false positives. Your job is to reject them.

An email is a GENUINE milestone only if ALL of these hold:
- It is personally addressed to the candidate about a SPECIFIC application, role, or hiring process they are in.
- It comes from an employer, their recruiting team, or a scheduling/assessment tool acting for them (e.g. Calendly, HackerRank, Codility invites tied to a named company).
- It asks for or announces a concrete hiring step: scheduling or confirming an interview, completing a named assessment, or presenting an offer.

It is NOT a genuine milestone if it is any of:
- Marketing or promotional content, product updates, newsletters, webinar/course/bootcamp/career-coaching promotions.
- Job-board alerts or digests (LinkedIn, Indeed, ZipRecruiter, Glassdoor, etc.), "jobs for you" blasts.
- Mass recruiter outreach not tied to an application the candidate made ("came across your profile...").
- Automated application acknowledgements ("thank you for applying", "we received your application", "your application is under review") with no interview, assessment, or offer in them.
- Rejections, account/security mail, payment or billing mail.

Return ONLY a JSON object:
{
  "genuine": true | false,
  "category": "interview" | "assessment" | "offer" | "not-milestone",
  "confidence": "high" | "medium" | "low",
  "reason": "one short sentence naming the decisive evidence"
}

Rules: base the decision only on the email content given. When uncertain, return genuine=false. Output raw JSON only.`;

function clamp(text, max) {
  const s = String(text || "").trim();
  return s.length <= max ? s : s.slice(0, max) + "\n…[truncated]";
}

function fail(error) {
  return {
    ok: false,
    genuine: false,
    category: "",
    confidence: "",
    reason: "",
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
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fail("OPENAI_API_KEY not configured");

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
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
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
      source: AI_USAGE_SOURCES.MAIL_VERIFY,
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

    const category = MILESTONE_CATEGORIES.has(parsed?.category) ? parsed.category : "not-milestone";
    return {
      ok: true,
      genuine: parsed?.genuine === true && category !== "not-milestone",
      category,
      confidence: CONFIDENCES.has(parsed?.confidence) ? parsed.confidence : "low",
      reason: typeof parsed?.reason === "string" ? parsed.reason.trim().slice(0, 300) : "",
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

export const __config = { MODEL, TIMEOUT_MS, MILESTONE_CATEGORIES };
