// AiUsageDaily — REAL token usage, rolled up per (IST day, source, model).
//
// Why this exists
// ---------------
// Every LLM call in this backend already gets exact token counts back from the
// provider (`usage` on OpenAI, `usageMetadata` on Vertex) and every single call
// site was THROWING THEM AWAY. The Discord scrape-milestone embed therefore
// priced the day from hardcoded per-batch guesses, which measured ~2x under the
// real OpenAI bill. This collection is the fix: providers report, we record,
// the reports read measured numbers instead of guessing.
//
// Shape: a daily ROLLUP, not a row per call. One `$inc` upsert per LLM call
// against a doc keyed (day, source, model) — so a day of traffic is a handful
// of documents rather than thousands, and "what did today cost" is one cheap
// find() instead of an aggregation over a growing log.
//
// `source` is the pipeline that spent the money, which is the thing nobody
// could see before: judging, second-stage screening, resume summaries, and
// recruiter templates all landed in one undifferentiated OpenAI invoice.

import mongoose from "mongoose";

export const AI_USAGE_SOURCES = {
    FIRST_JUDGE: "first-judge",       // extension auto-judge (batched)
    SECOND_JUDGE: "second-judge",     // secondJudgeWorker real-site re-screen
    AI_SUMMARY: "ai-summary",         // BuildAiSummary
    RECRUITER_TEMPLATE: "recruiter-template", // RecruiterAiTemplate (gpt-4o!)
    JOB_EXTRACT: "job-extract",       // extractJobData
    MAIL_SUMMARY: "mail-summary",     // mailAiSummarizer (disabled by default)
    MAIL_VERIFY: "mail-verify",       // mailMilestoneVerifier second-stage check
    MAIL_REGEX: "mail-regex",         // mailRegexLearner exclusion-pattern proposals
};

const aiUsageDailySchema = new mongoose.Schema({
    day: { type: String, required: true },   // IST YYYY-MM-DD
    source: { type: String, required: true },
    model: { type: String, required: true },
    calls: { type: Number, default: 0 },
    // inputTokens is the provider's TOTAL prompt tokens and already CONTAINS
    // cachedInputTokens. Do not add the two together when pricing.
    inputTokens: { type: Number, default: 0 },
    cachedInputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    // Calls that came back without usage — if this is non-zero the day's cost
    // is an UNDER-count, and the report says so instead of quietly rounding down.
    callsMissingUsage: { type: Number, default: 0 },
}, { timestamps: true });

aiUsageDailySchema.index({ day: 1, source: 1, model: 1 }, { unique: true });
aiUsageDailySchema.index({ day: -1 });

export const AiUsageDaily = mongoose.model("AiUsageDaily", aiUsageDailySchema);
