// gpt-4o-mini summarizer for inbound client mail.
//
// Takes a parsed Gmail message (subject, sender, body text, and the decoded
// text of any .txt attachments) and returns a compact structured digest that
// the Discord embed renders directly.
//
// Design notes:
//  • FAIL-OPEN. If OpenAI is down, rate-limited, or returns junk, we return
//    aiSucceeded:false with an empty summary. The worker still posts the mail
//    to Discord using the raw snippet — losing the summary is acceptable,
//    losing the notification is not.
//  • URLs are NOT taken from the model. Models hallucinate links. We extract
//    them deterministically with a regex and only let the model *choose* which
//    extracted URL is primary.
//  • temperature 0 + response_format json_object for stable, parseable output.

import { extractUrls } from "../../Utils/gmailMessage.js";
import { recordAiUsage, AI_USAGE_SOURCES } from "../../Utils/aiUsage.js";
import { mailAiConfig, MISSING_KEY_ERROR } from "../../Utils/mailAiConfig.js";

// Overridable so the pipeline can be pointed at a proxy / Azure deployment,
// and so tests can exercise the real request path against a local stub.
const MODEL = mailAiConfig(process.env).model;
const TIMEOUT_MS = Number(process.env.MAIL_AI_TIMEOUT_MS) || 30000;

// Keep the prompt well inside the context window and the cost sane. A job
// alert mail plus its .txt payload is normally far under these.
const MAX_BODY_CHARS = Number(process.env.MAIL_AI_MAX_BODY_CHARS) || 12000;
const MAX_ATTACHMENT_CHARS = Number(process.env.MAIL_AI_MAX_ATTACHMENT_CHARS) || 8000;

const CATEGORIES = [
  "job-application",
  "interview",
  "offer",
  "rejection",
  "recruiter-outreach",
  "assessment",
  "job-alert",
  "newsletter",
  "account-security",
  "other"
];
const PRIORITIES = ["high", "medium", "low"];

const SYSTEM_PROMPT = `You are an assistant that triages a job-seeking client's inbox for a recruiting operations team.

You receive one email: its sender, subject, body, and the text of any attached files.

Return ONLY a JSON object with exactly these keys:
{
  "summary": "2-4 sentences, plain text, no markdown. What this email says and why it matters to the client. Be specific: name the company, role, deadline, or amount when present.",
  "keyPoints": ["up to 5 short bullet strings, each under 120 characters"],
  "category": "one of: ${CATEGORIES.join(" | ")}",
  "priority": "high | medium | low",
  "actionRequired": "One sentence naming the concrete next step the operations team must take, or an empty string if none.",
  "primaryUrl": "the single most important URL from the email, copied EXACTLY from the text, or an empty string"
}

Rules:
- Never invent facts, links, companies, or deadlines. Only use what appears in the email.
- "primaryUrl" MUST be copied character-for-character from the email text. If you are not certain, return "".
- priority "high" = needs a human today (interview invite, offer, deadline within 48h, security alert).
  priority "medium" = a real reply or action is expected but not urgent.
  priority "low" = informational, automated alerts, newsletters.
- Write "summary" for a reader who has not seen the email.
- Output raw JSON only. No markdown fences, no commentary.`;

function clamp(text, max) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n…[truncated, ${s.length - max} more characters]`;
}

function buildUserPrompt({ from, subject, date, bodyText, attachments }) {
  const parts = [
    `From: ${from || "unknown"}`,
    `Subject: ${subject || "(no subject)"}`,
    `Date: ${date ? new Date(date).toISOString() : "unknown"}`,
    "",
    "--- EMAIL BODY ---",
    clamp(bodyText, MAX_BODY_CHARS) || "(empty body)"
  ];

  if (attachments?.length) {
    let budget = MAX_ATTACHMENT_CHARS;
    for (const a of attachments) {
      if (budget <= 0) break;
      const slice = clamp(a.text, budget);
      budget -= slice.length;
      parts.push("", `--- ATTACHED FILE: ${a.filename} ---`, slice);
    }
  }

  return parts.join("\n");
}

// coerce: never trust the model's shape. Every field is validated or defaulted.
function coerce(parsed, allowedUrls) {
  const category = CATEGORIES.includes(parsed?.category) ? parsed.category : "other";
  const priority = PRIORITIES.includes(parsed?.priority) ? parsed.priority : "low";

  const keyPoints = Array.isArray(parsed?.keyPoints)
    ? parsed.keyPoints.filter((k) => typeof k === "string" && k.trim()).slice(0, 5).map((k) => k.trim().slice(0, 160))
    : [];

  // Only honour primaryUrl if it really appears in the mail. Guards against
  // the model inventing a plausible-looking link.
  const primaryUrl =
    typeof parsed?.primaryUrl === "string" && allowedUrls.includes(parsed.primaryUrl.trim())
      ? parsed.primaryUrl.trim()
      : "";

  return {
    summary: typeof parsed?.summary === "string" ? parsed.summary.trim().slice(0, 3500) : "",
    keyPoints,
    category,
    priority,
    actionRequired: typeof parsed?.actionRequired === "string" ? parsed.actionRequired.trim().slice(0, 900) : "",
    primaryUrl
  };
}

function failOpen(reason) {
  return {
    aiSucceeded: false,
    aiError: String(reason || "unknown").slice(0, 300),
    aiModel: MODEL,
    summary: "",
    keyPoints: [],
    category: "other",
    priority: "low",
    actionRequired: "",
    urls: []
  };
}

/**
 * Summarize one email.
 *
 * @param {Object} mail
 * @param {string} mail.from
 * @param {string} mail.subject
 * @param {Date|number|string} mail.date
 * @param {string} mail.bodyText   - plain-text body (html already flattened)
 * @param {Array}  [mail.attachments] - [{ filename, text }] decoded text files
 * @returns {Promise<Object>} digest fields, always resolves (never throws)
 */
export async function summarizeMail(mail) {
  // Deterministic first: links come from the raw text, not the model.
  const attachmentText = (mail.attachments || []).map((a) => a.text).join("\n");
  const urls = extractUrls(mail.bodyText, attachmentText, mail.subject);

  const ai = mailAiConfig(process.env);
  const apiKey = ai.apiKey;
  if (!apiKey) return { ...failOpen(MISSING_KEY_ERROR), urls };

  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(mail) }
    ],
    response_format: { type: "json_object" },
    temperature: 0
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ai.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ...failOpen(`OpenAI HTTP ${res.status}: ${text.slice(0, 200)}`), urls };
    }

    const data = await res.json();
    recordAiUsage({
      source: AI_USAGE_SOURCES.MAIL_SUMMARY,
      model: data?.model || MODEL,
      usage: data?.usage,
    });
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return { ...failOpen("OpenAI returned no content"), urls };

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { ...failOpen("OpenAI returned unparseable JSON"), urls };
    }

    const clean = coerce(parsed, urls);
    if (!clean.summary) return { ...failOpen("OpenAI returned an empty summary"), urls };

    // Float the model's chosen primary link to the front so the embed title
    // links to the URL that actually matters.
    const ordered = clean.primaryUrl ? [clean.primaryUrl, ...urls.filter((u) => u !== clean.primaryUrl)] : urls;

    return {
      aiSucceeded: true,
      aiError: "",
      aiModel: MODEL,
      summary: clean.summary,
      keyPoints: clean.keyPoints,
      category: clean.category,
      priority: clean.priority,
      actionRequired: clean.actionRequired,
      urls: ordered
    };
  } catch (e) {
    const msg = e?.name === "AbortError" ? `OpenAI timed out after ${TIMEOUT_MS}ms` : e?.message || String(e);
    return { ...failOpen(msg), urls };
  } finally {
    clearTimeout(timer);
  }
}
