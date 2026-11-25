// aiUsage — record REAL token usage from any LLM call, and read a day back.
//
// One import, one call, fire-and-forget:
//     recordAiUsage({ source: AI_USAGE_SOURCES.SECOND_JUDGE, model, usage });
//
// `usage` is passed through VERBATIM from the provider response. Both shapes are
// understood, so no call site has to normalise anything:
//   OpenAI  { prompt_tokens, completion_tokens, prompt_tokens_details:{cached_tokens} }
//   Vertex  { promptTokenCount, candidatesTokenCount, totalTokenCount }
//
// Recording NEVER throws and never blocks the caller. A cost-reporting write must
// not be able to fail a resume build or a job screen — if Mongo is unhappy we
// lose a cost datapoint, which is strictly better than losing the actual work.

import { AiUsageDaily, AI_USAGE_SOURCES } from "../Schema_Models/AiUsageDaily.js";
import { priceTokens, inr, FX_USD_INR } from "./aiRateCard.js";

export { AI_USAGE_SOURCES };

// IST day bucket. Matches the /addjob daily cap window and the milestone
// notifier, so every "today" in this codebase means the same 24 hours.
export function istDay(now = new Date()) {
    return new Date(now.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// normaliseUsage — provider payload → { inputTokens, cachedTokens, outputTokens }
// Returns null when the provider sent nothing usable, so the caller can count
// the call as "missing usage" rather than recording a silent zero.
export function normaliseUsage(usage) {
    if (!usage || typeof usage !== "object") return null;
    const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);

    // OpenAI
    if (usage.prompt_tokens != null || usage.completion_tokens != null) {
        return {
            inputTokens: n(usage.prompt_tokens),
            cachedTokens: n(usage.prompt_tokens_details?.cached_tokens),
            outputTokens: n(usage.completion_tokens),
        };
    }
    // TypeSafe Jev (and Anthropic-style) { input_tokens, output_tokens }
    if (usage.input_tokens != null || usage.output_tokens != null) {
        return {
            inputTokens: n(usage.input_tokens),
            cachedTokens: n(usage.cache_read_input_tokens),
            outputTokens: n(usage.output_tokens),
        };
    }
    // Vertex / Gemini
    if (usage.promptTokenCount != null || usage.candidatesTokenCount != null) {
        return {
            inputTokens: n(usage.promptTokenCount),
            // Vertex does not report implicit-cache hits per call.
            cachedTokens: n(usage.cachedContentTokenCount),
            outputTokens: n(usage.candidatesTokenCount),
        };
    }
    return null;
}

// recordAiUsage — fire-and-forget. Await it only if you actually need ordering.
export async function recordAiUsage({ source, model, usage, calls = 1, day = null }) {
    try {
        if (!source || !model) return;
        const parsed = normaliseUsage(usage);
        const key = { day: day || istDay(), source: String(source), model: String(model) };
        const incr = parsed
            ? {
                calls,
                inputTokens: parsed.inputTokens,
                cachedInputTokens: parsed.cachedTokens,
                outputTokens: parsed.outputTokens,
            }
            // No usage came back: still count the CALL so the report can tell
            // you the day's cost is incomplete instead of pretending it is exact.
            : { calls, callsMissingUsage: calls };
        await AiUsageDaily.updateOne(key, { $inc: incr }, { upsert: true });
    } catch (err) {
        console.warn("[aiUsage] record failed (cost datapoint lost, work unaffected):", err?.message);
    }
}

// getDailyUsage — every (source, model) bucket for one IST day, priced.
// Returns rows plus a total, and `complete:false` when any call came back
// without usage so the caller can label the number as a floor, not a fact.
export async function getDailyUsage(day = istDay()) {
    let docs = [];
    try {
        docs = await AiUsageDaily.find({ day }).lean();
    } catch (err) {
        console.warn("[aiUsage] read failed:", err?.message);
        return { day, rows: [], totalUsd: 0, totalInr: 0, complete: true, fxRate: FX_USD_INR };
    }
    const rows = docs.map((d) => {
        const p = priceTokens({
            model: d.model,
            inputTokens: d.inputTokens,
            cachedTokens: d.cachedInputTokens,
            outputTokens: d.outputTokens,
        });
        return {
            source: d.source,
            model: d.model,
            calls: d.calls || 0,
            callsMissingUsage: d.callsMissingUsage || 0,
            inputTokens: d.inputTokens || 0,
            cachedTokens: d.cachedInputTokens || 0,
            outputTokens: d.outputTokens || 0,
            usd: p.usd,
            inr: inr(p.usd),
            cacheSavedUsd: p.cacheSavedUsd,
        };
    });
    const totalUsd = rows.reduce((a, r) => a + r.usd, 0);
    const missing = rows.reduce((a, r) => a + r.callsMissingUsage, 0);
    return {
        day,
        rows: rows.sort((a, b) => b.usd - a.usd),
        totalUsd,
        totalInr: inr(totalUsd),
        cacheSavedUsd: rows.reduce((a, r) => a + r.cacheSavedUsd, 0),
        callsMissingUsage: missing,
        complete: missing === 0,
        fxRate: FX_USD_INR,
    };
}
