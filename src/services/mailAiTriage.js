// mailAiTriage - a second look at every mail the regexes did NOT flag.
//
// The rules classifier (Utils/mailRulesClassifier.js) is the cheap first pass,
// and it misses real mail: on 2026-11-20 a B&Q interview invite sent through
// iCIMS (talent.icims.eu) was filed as a job-board alert, and learned
// exclusions had been burying real "Interview invitation" and "Online
// Assessment Invitation" mails. So every mail the regexes leave as anything
// other than interview / assessment / offer / rejection is read once by
// gpt-4o-mini here.
//
// This is a FINDER, not a judge. When it spots a milestone or a rejection the
// mail is handed to the normal pipeline under that category, so the existing
// verifier (mailMilestoneVerifier.js) still has the final word before any
// client email. Nothing reaches a client on this call's say-so alone.
//
// Contract:
//   - Always on. Uses the same OPENAI_API_KEY as the verifier; no new env.
//   - Fail-soft: OpenAI down or junk -> { ok:false } and the rules result
//     stands, exactly as before this file existed.
//   - temperature 0, json_object, body capped, usage recorded under "mail-triage".

import { recordAiUsage, AI_USAGE_SOURCES } from "../../Utils/aiUsage.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const TIMEOUT_MS = 20000;
const MAX_BODY_CHARS = 4000;

/** Categories the triage may hand back to the pipeline. */
export const TRIAGE_CATEGORIES = new Set(["interview", "assessment", "offer", "rejection"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);

/** Rules categories that already get an AI check downstream; triage skips them. */
export const RULE_FLAGGED_CATEGORIES = TRIAGE_CATEGORIES;

const SYSTEM_PROMPT = `You sort emails from a job seeker's inbox. Keyword rules did not recognise this email as a hiring milestone. Decide whether they missed one.

Categories:
- "interview": the employer, their recruiter or a scheduling tool invites the candidate to an interview, phone screen or call about a specific role, or confirms or reschedules one.
- "assessment": the candidate is asked to complete a named test, assessment, video interview, take-home or assignment for a specific employer.
- "offer": a job offer for a specific role.
- "rejection": the candidate is told they are no longer being considered for a specific role.
- "none": anything else, including "thank you for applying" acknowledgements, application-incomplete reminders, job-board alerts and digests, recruiter cold outreach, newsletters, marketing, account or security mail.

Applicant-tracking systems (iCIMS, Workday, Greenhouse, Lever, SmartRecruiters, Taleo and others) send all of these categories, so judge the content, not the sender.

Return ONLY a JSON object:
{
  "category": "interview" | "assessment" | "offer" | "rejection" | "none",
  "confidence": "high" | "medium" | "low",
  "reason": "one short sentence naming the decisive evidence"
}
When unsure, return "none". Output raw JSON only.`;

function clamp(s, n) {
  const t = String(s || "").trim();
  return t.length <= n ? t : t.slice(0, n);
}

function fail(error) {
  return { ok: false, category: "none", confidence: "", reason: "", model: MODEL, error: String(error || "unknown").slice(0, 300) };
}

/**
 * Read one mail the rules did not flag.
 *
 * @param {{from:string, subject:string, bodyText?:string, snippet?:string, rulesCategory?:string}} mail
 * @param {{fetchImpl?:Function, env?:Object}} [deps] - injected in tests
 * @returns {Promise<{ok:boolean, category:string, confidence:string, reason:string, model:string, error:string}>}
 *          Always resolves.
 */
export async function triageMail({ from, subject, bodyText, snippet, rulesCategory }, { fetchImpl = fetch, env = process.env } = {}) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return fail("OPENAI_API_KEY not configured");

  const userPrompt = [
    `Keyword rules said: ${rulesCategory || "other"}`,
    `From: ${from || "unknown"}`,
    `Subject: ${subject || "(no subject)"}`,
    "",
    "--- EMAIL BODY ---",
    clamp(bodyText, MAX_BODY_CHARS) || clamp(snippet, 600) || "(empty body)"
  ].join("\n");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(OPENAI_URL, {
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
    recordAiUsage({ source: AI_USAGE_SOURCES.MAIL_TRIAGE, model: data?.model || MODEL, usage: data?.usage });

    const content = data?.choices?.[0]?.message?.content;
    if (!content) return fail("OpenAI returned no content");
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return fail("OpenAI returned unparseable JSON");
    }
    return {
      ok: true,
      category: TRIAGE_CATEGORIES.has(parsed?.category) ? parsed.category : "none",
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
 * Whether a triage result should send the mail down the milestone/rejection
 * path. Low confidence is ignored: the verifier would only throw it away.
 */
export function triageFlags(t) {
  return Boolean(t?.ok && TRIAGE_CATEGORIES.has(t.category) && (t.confidence === "high" || t.confidence === "medium"));
}

export const __config = { MODEL, TIMEOUT_MS, MAX_BODY_CHARS };
