// One OpenAI round trip for a cover letter, shared by the on-demand writer
// (Controllers/Extensions/speedyApplyCoverLetterWriter.js) and the background
// queue (Utils/coverLetterAutoWriter.js).
//
// gpt-4o-mini, JSON mode, 30 s per call. Unusable output is retried once with
// the reason fed back into the prompt; network, timeout and HTTP errors are
// thrown as CoverLetterUpstreamError and never retried here (the queue has its
// own backoff, the extension user can press the button again).
//
// The key is the backend env var `auto_fill_chatgpt_API`. Token usage goes to
// AiUsageDaily under the caller's source.

import { recordAiUsage } from "./aiUsage.js";
import { parseCoverLetterOutput } from "./speedyApplyCoverLetterWriter.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
export const COVER_LETTER_MODEL = "gpt-4o-mini";
const TEMPERATURE = 0.5;
const MAX_TOKENS = 1000;
export const COVER_LETTER_TIMEOUT_MS = 30000;
const ATTEMPTS = 2; // one retry, only for unusable output

export const coverLetterOpenAiKey = () => String(process.env.auto_fill_chatgpt_API || "").trim();

export class CoverLetterUpstreamError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function callCoverLetterOpenAi(apiKey, messages, { source } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COVER_LETTER_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(OPENAI_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: COVER_LETTER_MODEL,
        messages,
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        response_format: { type: "json_object" },
      }),
    });
  } catch (err) {
    if (err?.name === "AbortError") throw new CoverLetterUpstreamError(504, "timeout", "The AI took too long to write the letter. Try again.");
    console.warn("[cover-letter-ai] OpenAI request failed:", err?.message || err);
    throw new CoverLetterUpstreamError(502, "network", "Could not reach the AI service. Try again in a minute.");
  } finally {
    clearTimeout(timer);
  }
  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => "");
    console.warn(`[cover-letter-ai] OpenAI ${upstream.status}:`, txt.slice(0, 300));
    throw new CoverLetterUpstreamError(502, `openai_${upstream.status}`, `The AI service returned an error (${upstream.status}). Try again in a minute.`);
  }
  const data = await upstream.json().catch(() => null);
  if (source) recordAiUsage({ source, model: data?.model || COVER_LETTER_MODEL, usage: data?.usage });
  return { content: data?.choices?.[0]?.message?.content, model: data?.model || COVER_LETTER_MODEL };
}

/**
 * Ask for the letter, validate it with parseCoverLetterOutput, retry once on
 * unusable output. `buildMessages(retryReason)` returns the chat messages.
 * Resolves to { ok: true, paragraphs, words, model } or
 * { ok: false, reason, model } after the last attempt.
 */
export async function writeCoverLetterParagraphs({ apiKey, buildMessages, name = "", source, logTag = "[cover-letter-ai]" }) {
  let model = COVER_LETTER_MODEL;
  let retryReason = "";
  let result = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const reply = await callCoverLetterOpenAi(apiKey, buildMessages(retryReason), { source });
    model = reply.model;
    result = parseCoverLetterOutput(reply.content, { name });
    if (result.ok) return { ok: true, paragraphs: result.paragraphs, words: result.words, model };
    retryReason = result.reason;
    console.warn(`${logTag} unusable output on attempt ${attempt}: ${result.reason}`);
  }
  return { ok: false, reason: result?.reason || "unusable output", model };
}
