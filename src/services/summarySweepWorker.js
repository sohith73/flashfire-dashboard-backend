// summarySweepWorker — every 30 min sweeps profiles that need a summary:
//   • summaryStale === true     (profile or resume changed since last build)
//   • aiSummary missing/empty   (new client never built)
//
// For each candidate, fires buildSummaryForEmail with reason `cron-sweep` so
// the dashboard log + AI Summaries UI source field show the auto origin.
//
// Concurrency: capped at SWEEP_CONCURRENCY (default 3) so we don't spike
// OpenAI / Gemini quota when there's a big backlog. Per-tick batch size
// capped at SWEEP_BATCH_SIZE (default 30) so a 1000-client backlog clears
// over ~9 cycles (~4.5h) without flooding.
//
// Idempotency: buildSummaryForEmail clears summaryStale=false and bumps
// aiSummaryMeta.builtAt on success, so the same profile is not picked up
// next tick unless it changes again.
//
// Errors are logged and DO NOT throw — a single bad profile must not stop
// the sweep for the rest.

import cron from "node-cron";
import { ProfileModel } from "../../Schema_Models/ProfileModel.js";
import { buildSummaryForEmail } from "../../Controllers/BuildAiSummary.js";

const SWEEP_CONCURRENCY = Math.max(1, Number(process.env.SUMMARY_SWEEP_CONCURRENCY) || 3);
const SWEEP_BATCH_SIZE = Math.max(1, Number(process.env.SUMMARY_SWEEP_BATCH_SIZE) || 30);
// Skip clients whose last build attempt failed within the cooldown — avoids
// burning the OpenAI budget retrying a broken profile every half-hour.
const FAILED_COOLDOWN_MIN = Math.max(0, Number(process.env.SUMMARY_SWEEP_FAILED_COOLDOWN_MIN) || 120);

let running = false; // overlap guard — skip a tick if previous still running

// findCandidates: pull stale + missing-summary profiles. Limits the query so
// huge backlogs don't OOM the worker.
async function findCandidates() {
    const failedCutoff = new Date(Date.now() - FAILED_COOLDOWN_MIN * 60 * 1000);
    const candidates = await ProfileModel.find(
        {
            email: { $exists: true, $ne: "" },
            $or: [
                { summaryStale: true },
                { aiSummary: { $in: [null, "", undefined] } },
                { aiSummary: { $exists: false } },
            ],
            // Skip rows that had a failed build attempt very recently.
            $and: [
                {
                    $or: [
                        { "aiSummaryMeta.lastAttemptAt": { $exists: false } },
                        { "aiSummaryMeta.lastAttemptAt": { $lt: failedCutoff } },
                        // Successful builds reset summaryStale, so any stale-true
                        // row with a recent timestamp implies failure; cooldown
                        // skips it. One exception: a rebuild requested WHILE a
                        // build was running is skipped as a duplicate, so the
                        // finished brief never saw that change. That row is
                        // deliberately left stale right after a successful
                        // build, and the cooldown must not hide it for 2h.
                        { $expr: { $gt: ["$summaryRebuildRequestedAt", "$aiSummaryMeta.builtAt"] } },
                    ],
                },
            ],
        },
        { email: 1, summaryStale: 1, aiSummary: 1, "aiSummaryMeta.builtAt": 1 },
    )
        .sort({ "aiSummaryMeta.builtAt": 1 }) // oldest first
        .limit(SWEEP_BATCH_SIZE)
        .lean();
    return candidates;
}

// runWithConcurrency: dead-simple worker pool. No external dep.
async function runWithConcurrency(items, limit, worker) {
    const queue = items.slice();
    const running = [];
    const results = [];
    while (queue.length || running.length) {
        while (queue.length && running.length < limit) {
            const item = queue.shift();
            const p = worker(item)
                .then((r) => results.push({ ok: true, item, r }))
                .catch((e) => results.push({ ok: false, item, error: e?.message || String(e) }))
                .finally(() => {
                    const i = running.indexOf(p);
                    if (i !== -1) running.splice(i, 1);
                });
            running.push(p);
        }
        if (running.length) await Promise.race(running);
    }
    return results;
}

async function sweepOnce() {
    if (running) {
        console.log("[summary-sweep] previous tick still running — skip");
        return;
    }
    running = true;
    const startedAt = Date.now();
    try {
        const candidates = await findCandidates();
        if (!candidates.length) {
            console.log("[summary-sweep] no candidates");
            return;
        }
        console.log(`[summary-sweep] tick start — candidates=${candidates.length} concurrency=${SWEEP_CONCURRENCY}`);
        const results = await runWithConcurrency(candidates, SWEEP_CONCURRENCY, async (p) => {
            const email = p.email;
            // Stamp lastAttemptAt regardless of outcome so the cooldown clause
            // can avoid hammering broken profiles every tick.
            await ProfileModel.findOneAndUpdate(
                { email },
                { $set: { "aiSummaryMeta.lastAttemptAt": new Date() } },
            ).catch(() => {});
            return buildSummaryForEmail(email, "cron-sweep");
        });
        const ok = results.filter((r) => r.ok && r.r?.success).length;
        // A profile already being built by another trigger (Build button, job
        // removal, resume attach) is skipped by buildSummaryForEmail's claim,
        // not failed — it stays stale and the next tick picks it up.
        const skipped = results.filter((r) => r.ok && r.r?.skipped).length;
        const fail = results.length - ok - skipped;
        console.log(`[summary-sweep] tick done — ok=${ok} skipped=${skipped} fail=${fail} elapsedMs=${Date.now() - startedAt}`);
        if (fail > 0) {
            // Surface first few failures so ops sees what's wrong without
            // tailing the entire log.
            const sample = results.filter((r) => !(r.ok && (r.r?.success || r.r?.skipped))).slice(0, 5);
            for (const s of sample) {
                console.warn(`[summary-sweep] fail email=${s.item.email} err=${s.r?.error || s.error}`);
            }
        }
    } catch (err) {
        console.error("[summary-sweep] tick crashed:", err);
    } finally {
        running = false;
    }
}

// startSummarySweepWorker: register the 30-min cron. Tolerates being called
// more than once (idempotent — node-cron returns a new task each time but
// we track the handle to avoid duplicates).
let task = null;
export function startSummarySweepWorker() {
    if (task) {
        console.log("[summary-sweep] already running — skip duplicate start");
        return task;
    }
    // Every 30 min on the half hour. Pass `*/30 * * * *` to align with :00/:30.
    const expr = process.env.SUMMARY_SWEEP_CRON || "*/30 * * * *";
    task = cron.schedule(expr, sweepOnce, { timezone: "Asia/Kolkata" });
    console.log(`[summary-sweep] worker registered (cron='${expr}', concurrency=${SWEEP_CONCURRENCY}, batch=${SWEEP_BATCH_SIZE})`);
    // Optional kick on boot so a fresh deploy doesn't wait up to 30 min.
    if (process.env.SUMMARY_SWEEP_RUN_ON_BOOT === "1") {
        setTimeout(() => sweepOnce().catch((e) => console.error("[summary-sweep] boot tick failed:", e)), 5000);
    }
    return task;
}

// Exposed for manual triggers / tests.
export { sweepOnce };
