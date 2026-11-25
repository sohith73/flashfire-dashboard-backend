// aiRateCard — the ONE place model pricing lives.
//
// Every cost number the backend shows (the Discord scrape-milestone embed, the
// "Daily AI cost" tile on the AI Summaries page) prices tokens through this
// table. Previously each of those had its own hardcoded rates, so they drifted.
//
// Rates are USD per 1M tokens. `cachedIn` is what OpenAI bills for a prompt-cache
// HIT — for the 4o family that is 50% of the input rate, so it is written out
// explicitly rather than derived, because that ratio is NOT universal across
// models and a future model with a different discount would silently mis-price.
//
// Source: https://openai.com/api/pricing/ and https://ai.google.dev/pricing
// Update `asOf` whenever you touch a number — the UI surfaces it so ops can see
// how stale the card is.

export const AI_RATES = {
    "gpt-4o-mini": { in: 0.15, cachedIn: 0.075, out: 0.60, asOf: "2025-04-01" },
    "gpt-4o": { in: 2.50, cachedIn: 1.25, out: 10.00, asOf: "2025-04-01" },
    // Vertex / Gemini judge path (/extension/gemini-judge). No prompt-cache
    // discount is claimed: Vertex implicit caching is not reported per-call in
    // usageMetadata, so we price every input token at full rate. That makes the
    // Gemini figure a deliberate OVER-estimate rather than a flattering one.
    "gemini-2.5-flash-lite": { in: 0.10, cachedIn: 0.10, out: 0.40, asOf: "2025-04-01" },
    "gemini-2.5-flash": { in: 0.30, cachedIn: 0.30, out: 2.50, asOf: "2025-04-01" },
};

// Unknown models must NOT silently price at zero — that is how a cost report
// quietly under-reports. Fall back to the most expensive card we know so an
// unpriced model shows up as suspiciously high rather than invisible.
const FALLBACK = { in: 2.50, cachedIn: 1.25, out: 10.00, asOf: "unknown-model" };

// A model served by another provider (MAIL_AI_API_URL + MAIL_AI_MODEL) has no
// card above. Its price comes from env, in USD per 1M tokens:
//   MAIL_AI_RATE_IN, MAIL_AI_RATE_OUT, and optionally MAIL_AI_RATE_CACHED_IN.
// Without them it falls back to FALLBACK, which over-states the cost on purpose.
export function envRateFor(model, env = process.env) {
    const configured = String(env.MAIL_AI_MODEL || "").trim().toLowerCase();
    const key = String(model || "").trim().toLowerCase();
    if (!configured || !key || !(key === configured || key.startsWith(configured))) return null;
    const num = (v) => (v === undefined || v === "" ? NaN : Number(v));
    const rIn = num(env.MAIL_AI_RATE_IN);
    const rOut = num(env.MAIL_AI_RATE_OUT);
    if (!(rIn >= 0) || !(rOut >= 0)) return null;
    const rCached = num(env.MAIL_AI_RATE_CACHED_IN);
    return { in: rIn, cachedIn: rCached >= 0 ? rCached : rIn, out: rOut, asOf: "env" };
}

/** True when a model would be priced at the over-stated FALLBACK card. */
export function isUnpricedModel(model) {
    return rateFor(model) === FALLBACK;
}

export function rateFor(model) {
    const key = String(model || "").trim().toLowerCase();
    if (AI_RATES[key]) return AI_RATES[key];
    const fromEnv = envRateFor(key);
    if (fromEnv) return fromEnv;
    // OpenAI returns dated ids like "gpt-4o-mini-2024-07-18"; match the family.
    const hit = Object.keys(AI_RATES).find((k) => key.startsWith(k));
    return hit ? AI_RATES[hit] : FALLBACK;
}

// priceTokens — USD for one bucket of usage.
//   inputTokens  — TOTAL input tokens, cached ones INCLUDED (that is how both
//                  OpenAI's `prompt_tokens` and Vertex's `promptTokenCount`
//                  report it). Passing cached separately and adding would
//                  double-count, which is the classic bug here.
//   cachedTokens — the subset of inputTokens that hit the prompt cache.
export function priceTokens({ model, inputTokens = 0, cachedTokens = 0, outputTokens = 0 }) {
    const r = rateFor(model);
    const inTok = Math.max(0, Number(inputTokens) || 0);
    const outTok = Math.max(0, Number(outputTokens) || 0);
    const cached = Math.min(inTok, Math.max(0, Number(cachedTokens) || 0));
    const fresh = inTok - cached;
    const usd =
        (fresh / 1_000_000) * r.in +
        (cached / 1_000_000) * r.cachedIn +
        (outTok / 1_000_000) * r.out;
    // What the cache actually saved = what those tokens WOULD have cost at the
    // full input rate, minus what they did cost.
    const cacheSavedUsd = (cached / 1_000_000) * (r.in - r.cachedIn);
    return { usd, cacheSavedUsd, inputTokens: inTok, cachedTokens: cached, outputTokens: outTok };
}

// ─── FX ──────────────────────────────────────────────────────────────
// Fixed USD→INR rate for the ₹ figures shown alongside every $ figure.
// Deliberately NOT an env var and deliberately NOT a live lookup:
//   • env — a per-environment FX rate means staging and production quote
//     different rupee costs for the same tokens, and nobody notices which is
//     which. This is a presentation constant, so it belongs in the diff.
//   • live rate — the ₹ number would drift day to day while the underlying
//     token spend was flat, making cost trends unreadable. A fixed rate keeps
//     ₹ movement meaning "we spent more", never "the rupee moved".
// Update here when it drifts far enough to matter, and the change is reviewable.
export const FX_USD_INR = 94;
export const inr = (usd) => usd * FX_USD_INR;
