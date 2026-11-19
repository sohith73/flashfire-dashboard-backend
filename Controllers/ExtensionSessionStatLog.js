// POST /extension/session-stat
// Body: {
//   operatorEmail, operatorName?, clientEmail, clientName?,
//   captures, linkedinSkipped, judged, picks, pushed, duplicates, blocked, errors,
//   startedAt?, endedAt?, extensionVersion?
// }
// Logs one extension session — called by the JR-direct extension's SW when
// the operator stops capture or runs flush. Idempotent insert (no upsert key
// since each session is its own row). Drives the "who is working" panel on
// the AI Summaries page.

import { ExtensionSessionStat } from "../Schema_Models/ExtensionSessionStat.js";
import { checkAndNotifyScrapeMilestone } from "../Utils/scrapeCostNotifier.js";

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export default async function ExtensionSessionStatLog(req, res) {
    try {
        const b = req.body || {};
        const operatorEmail = String(b.operatorEmail || "").trim().toLowerCase();
        const operatorName = String(b.operatorName || "").trim().slice(0, 200);
        const clientEmail = String(b.clientEmail || "").trim().toLowerCase();
        if (!operatorName) {
            return res.status(400).json({ success: false, error: "BAD_INPUT", message: "operatorName required" });
        }
        if (!clientEmail || !clientEmail.includes("@")) {
            return res.status(400).json({ success: false, error: "BAD_INPUT", message: "clientEmail required" });
        }
        // Normalise the per-skipKind tallies. Accept both raw skipsByKind
        // (free-form) AND the canonical 7-key rollup the extension sends.
        const sb = (b.skipsByKind && typeof b.skipsByKind === "object") ? b.skipsByKind : {};
        const sr = b.skipsRollup || {};
        const sessionId = String(b.sessionId || "").trim().slice(0, 64);
        const baseDoc = {
            sessionId,
            operatorEmail,
            operatorName,
            extensionCode: String(b.extensionCode || "").trim().slice(0, 64),
            clientEmail,
            clientName: String(b.clientName || "").slice(0, 200),
            captures: num(b.captures),
            linkedinSkipped: num(b.linkedinSkipped),
            judged: num(b.judged),
            picks: num(b.picks),
            pushed: num(b.pushed),
            duplicates: num(b.duplicates),
            blocked: num(b.blocked),
            errors: num(b.errors),
            skipsByKind: sb,
            skipsRollup: {
                roleMismatch:      num(sr.roleMismatch),
                seniorityMismatch: num(sr.seniorityMismatch),
                locationMismatch:  num(sr.locationMismatch),
                authMismatch:      num(sr.authMismatch),
                threshold:         num(sr.threshold),
                companyBlocked:    num(sr.companyBlocked),
                cardScore:         num(sr.cardScore),
                intern:            num(sr.intern),
                disciplineMismatch: num(sr.disciplineMismatch),
                other:             num(sr.other),
            },
            modelStats: {
                geminiBatches: num((b.modelStats || {}).geminiBatches),
                geminiErrors:  num((b.modelStats || {}).geminiErrors),
                openaiBatches: num((b.modelStats || {}).openaiBatches),
                inputTokens:   num((b.modelStats || {}).inputTokens),
                outputTokens:  num((b.modelStats || {}).outputTokens),
                cachedTokens:  num((b.modelStats || {}).cachedTokens),
                claudeBatches:      num((b.modelStats || {}).claudeBatches),
                claudeInputTokens:  num((b.modelStats || {}).claudeInputTokens),
                claudeOutputTokens: num((b.modelStats || {}).claudeOutputTokens),
            },
            startedAt: b.startedAt ? new Date(b.startedAt) : null,
            endedAt: b.endedAt ? new Date(b.endedAt) : new Date(),
            extensionVersion: String(b.extensionVersion || "").slice(0, 32),
        };
        // When sessionId present → upsert. Heartbeats during capture write
        // updated counters into the same row instead of creating duplicates.
        // No sessionId → fall back to insert (backwards compat).
        let doc;
        if (sessionId) {
            doc = await ExtensionSessionStat.findOneAndUpdate(
                { sessionId },
                { $set: baseDoc },
                { upsert: true, new: true, setDefaultsOnInsert: true },
            );
        } else {
            doc = await ExtensionSessionStat.create(baseDoc);
        }
        // Fire-and-forget — check whether today's cumulative scrape count
        // just crossed a 5000-multiple. Posts to Discord webhook when so.
        // Never blocks the response path.
        checkAndNotifyScrapeMilestone().catch((err) => {
            console.warn("scrape milestone check threw:", err?.message);
        });
        return res.json({ success: true, id: doc._id });
    } catch (err) {
        console.error("ExtensionSessionStatLog error:", err);
        return res.status(500).json({ success: false, error: "INTERNAL", message: err.message });
    }
}
