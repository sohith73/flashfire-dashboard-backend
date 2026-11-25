// Which AI endpoint, key and model the mail pipeline calls (triage, verifier,
// summarizer, regex learner). One place, so switching provider is env only.
//
//   MAIL_AI_API_URL   OpenAI-compatible chat-completions URL. Default OpenAI.
//   MAIL_AI_API_KEY   Key for that URL. Used ONLY together with MAIL_AI_API_URL,
//                     so a key meant for another provider is never sent to OpenAI.
//   MAIL_AI_MODEL     Model name for that provider. Default gpt-4o-mini.
//   OPENAI_API_KEY    Fallback key when MAIL_AI_API_KEY is not set.
//
// Read per call, not at import, so a changed env takes effect on restart and
// tests can inject their own.

export const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
export const DEFAULT_MAIL_MODEL = "gpt-4o-mini";

const trim = (v) => String(v ?? "").trim();

/** @returns {{url:string, apiKey:string, model:string}} apiKey is "" when none is configured. */
export function mailAiConfig(env = process.env, { modelOverride = "" } = {}) {
  const url = trim(env.MAIL_AI_API_URL);
  const customKey = trim(env.MAIL_AI_API_KEY);
  return {
    url: url || OPENAI_CHAT_URL,
    apiKey: url && customKey ? customKey : trim(env.OPENAI_API_KEY),
    model: trim(modelOverride) || trim(env.MAIL_AI_MODEL) || DEFAULT_MAIL_MODEL,
  };
}

export const MISSING_KEY_ERROR = "no mail AI key configured (MAIL_AI_API_KEY with MAIL_AI_API_URL, or OPENAI_API_KEY)";
