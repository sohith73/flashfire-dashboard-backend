// ExtensionSessionStat: every JR-direct extension capture session emits one
// row when the operator stops or flushes. Powers the per-operator + per-client
// stats card on the AI Summaries admin page so we can see who's working and
// who's idle without manual reporting.
//
// One row per (operator, client, session). Aggregation in SummariesOverview
// sums these up. No PII beyond the operator email + client email both already
// carried by the dashboard.

import mongoose from "mongoose";

const extensionSessionStatSchema = new mongoose.Schema({
    // Extension only has operator NAME (extension-code-verify returns name,
    // not email). Email left optional for forward-compat if we add operator
    // accounts later. operatorName is the primary identifier.
    // Stable per-session id minted by the extension at start-capture time.
    // Every subsequent heartbeat / batch / stop POST upserts on this id so
    // the live "scraped today" counter reflects scrolling in near-real-time
    // without inserting a new row per heartbeat. Optional to keep backwards
    // compat with old extension builds that only send on stop/flush.
    sessionId:     { type: String, default: "", index: true },
    operatorEmail: { type: String, default: "", index: true },
    operatorName:  { type: String, required: true, index: true },
    // 5-digit extension code the operator typed at panel login. Indexed so
    // the per-code daily breakdown is one query, not a join. Empty when the
    // operator skipped/failed code verification.
    extensionCode: { type: String, default: "", index: true },
    clientEmail:   { type: String, required: true, index: true },
    clientName:    { type: String, default: "" },
    captures:      { type: Number, default: 0 },
    linkedinSkipped: { type: Number, default: 0 },
    judged:        { type: Number, default: 0 },
    picks:         { type: Number, default: 0 },
    pushed:        { type: Number, default: 0 },
    duplicates:    { type: Number, default: 0 },
    blocked:       { type: Number, default: 0 },
    errors:        { type: Number, default: 0 },
    // Per-skipKind tally so admin can see WHY pick rate is low (role-miss
    // dominates → wrong preferredRoles; threshold dominates → operator slider
    // too aggressive). Free-form Object so new skipKinds don't need migrations.
    skipsByKind:   { type: Object, default: {} },
    skipsRollup:   {
        roleMismatch:        { type: Number, default: 0 },
        seniorityMismatch:   { type: Number, default: 0 },
        locationMismatch:    { type: Number, default: 0 },
        authMismatch:        { type: Number, default: 0 },
        threshold:           { type: Number, default: 0 },
        companyBlocked:      { type: Number, default: 0 },
        // Dropped by the extension's card score floor BEFORE any OpenAI call,
        // so these cost nothing. Separate from `threshold` (which the model
        // itself returns) precisely so the saving is measurable.
        cardScore:           { type: Number, default: 0 },
        // Internships skipped because the client did not ask for one. From
        // 2026-09-16 this is the only fit-based skip the judge makes; role and
        // seniority mismatch were retired.
        intern:              { type: Number, default: 0 },
        // A different engineering PROFESSION from the client's own (software vs
        // semiconductor/mechanical/field-service). Added 2026-09-16 after a
        // software client was pushed Process, ASIC and Service Engineer jobs.
        disciplineMismatch:  { type: Number, default: 0 },
        other:               { type: Number, default: 0 },
    },
    // Judge-model split — how many AI-judge batches this session ran on
    // Gemini 2.5 Flash Lite vs OpenAI gpt-4o-mini, plus failed Gemini calls
    // that fell back to OpenAI. Powers the per-model scrape-cost breakdown.
    modelStats: {
        geminiBatches: { type: Number, default: 0 },
        geminiErrors:  { type: Number, default: 0 },
        openaiBatches: { type: Number, default: 0 },
        // Real token usage summed from the judge responses → exact milestone cost.
        inputTokens:   { type: Number, default: 0 },
        outputTokens:  { type: Number, default: 0 },
        cachedTokens:  { type: Number, default: 0 }, // cached input (billed at 50%)
        // Batches judged by Claude (via a local OpenAI-compatible bridge). Kept
        // apart from the OpenAI fields above so they are never priced as gpt-4o-mini.
        claudeBatches:      { type: Number, default: 0 },
        claudeInputTokens:  { type: Number, default: 0 },
        claudeOutputTokens: { type: Number, default: 0 },
    },
    startedAt:     { type: Date, default: null },
    endedAt:       { type: Date, default: () => new Date(), index: true },
    extensionVersion: { type: String, default: "" },
}, { timestamps: true });

extensionSessionStatSchema.index({ clientEmail: 1, operatorEmail: 1, endedAt: -1 });

export const ExtensionSessionStat = mongoose.model("ExtensionSessionStat", extensionSessionStatSchema);
