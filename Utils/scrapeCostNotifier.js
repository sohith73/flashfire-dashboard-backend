// scrapeCostNotifier — fires a Discord webhook each time today's cumulative
// extension scrape count crosses a 5000-multiple milestone (5k, 10k, 15k,
// 20k, …). Idempotent per day: the last-fired milestone is stored in
// AppSettings so a duplicate POST never fires even when the backend
// restarts mid-day.
//
// Cost model — MEASURED, not guessed
// ---------------------------------------------------------------------------
// This used to price the day from hardcoded per-batch averages
// (ceil(jobs/8) × 3500 input tokens, etc.). Measured against the real OpenAI
// invoice that ran ~2x LOW: the card assumed 3,900 tok/request while the
// account's actual figure was ~8,990 tok/request. It also silently EXCLUDED
// every non-judge pipeline (resume summaries, recruiter templates on gpt-4o,
// job extraction) while calling its number "TOTAL cost".
//
// Both are fixed. This embed now reports EXACTLY the two stages a scraped job
// passes through, priced from token counts the providers actually reported:
//   Stage 1 — the extension's first judge, on JobRight's own description.
//             Usage comes from ExtensionSessionStat.modelStats, summed from the
//             `usage` block on each judge response (the extension calls OpenAI
//             directly, so this is the only place stage-1 usage exists).
//   Stage 2 — secondJudgeWorker re-judging the real employer posting. Usage
//             comes from AiUsageDaily, written by Utils/aiUsage.js.
//
// Nothing else is in the total. Resume auto-optimization, AI summaries,
// recruiter templates, job extraction and mail are all excluded: none is caused
// by scraping a job, so including them would make "cost per job" move on days
// nobody scraped. They are still recorded, and reported by GET /admin/ai-cost.
//
// The per-batch estimate survives ONLY as a fallback for old extension builds
// that predate token reporting, and when it is used the embed says so out loud
// rather than passing a guess off as a measurement.

import axios from "axios";
import cron from "node-cron";
import { AppSettingsModel } from "../Schema_Models/AppSettings.js";
import { ExtensionSessionStat } from "../Schema_Models/ExtensionSessionStat.js";
import { JobModel } from "../Schema_Models/JobModel.js";
import { ScrapeCostDaily } from "../Schema_Models/ScrapeCostDaily.js";
import { getDailyUsage, istDay } from "./aiUsage.js";
import { priceTokens, inr, FX_USD_INR } from "./aiRateCard.js";

// ─── Constants: all in code, none from the environment ───────────────
// Every number below is product/measurement fact, not deployment config. An
// env-tunable cost constant is how the 2.3x under-report survived unnoticed for
// as long as it did: the correct value sat in env.example while production
// silently ran a different one from a code default. Nothing here is overridable,
// so the value you read in this file is the value that shipped.

const MILESTONE_STEP = 5000;

// Jobs per judge batch. Mirrors the extension's DEFAULTS.autoBatchSize (8).
// Display + fallback only — real batch counts now come from the extension's
// reported openaiBatches/geminiBatches, so this cannot skew a measured figure.
const BATCH_SIZE = 8;

// The stage-1 judge model, HARDCODED to match the extension, which pins
// `model: 'gpt-4o-mini'` in background.js with the comment "Locked — judging is
// tuned for gpt-4o-mini's reasoning + cost profile."
// This used to read process.env.OPENAI_MODEL, which was a live mis-pricing bug:
// setting that var to gpt-4o (as the recruiter pipeline does for itself) would
// have priced stage 1 at ~16x while the extension still called mini. The judge
// model is not a deployment choice, so it is not read from the environment.
//
// Caveat, deliberate: ExtensionSessionStat.modelStats carries ONE token pool for
// the session, not a per-model split, so if a future build routes some batches
// to Gemini those tokens get priced at mini's rate too. Gemini Flash Lite is
// CHEAPER than mini ($0.10/$0.40 vs $0.15/$0.60), so that over-states rather
// than flatters. Splitting the pool needs an extension change, not a change here.
const STAGE1_MODEL = "gpt-4o-mini";

// ─── FALLBACK-ONLY estimate ──────────────────────────────────────────
// Used ONLY when an extension build is too old to report token usage at all.
// Calibrated against the real invoice (~8,990 tok/request observed over 33,571
// requests), NOT the old "conservative" 3,500 that under-reported by 2.3x.
// Biased deliberately HIGH: a cost estimate that reads low is worse than no
// estimate, because it reads as reassurance. Any figure derived from these is
// labelled ESTIMATED in the embed and turns the card amber.
const EST_TOKENS_IN_PER_BATCH = 8800;
const EST_TOKENS_OUT_PER_BATCH = 500;
const EST_CACHED_PER_BATCH = 1800;

function startOfTodayIST() {
    const offsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + offsetMs);
    istNow.setUTCHours(0, 0, 0, 0);
    return new Date(istNow.getTime() - offsetMs);
}

function todayMatch() {
    const todayStart = startOfTodayIST();
    return {
        $or: [
            { endedAt: { $gte: todayStart } },
            { startedAt: { $gte: todayStart } },
            { updatedAt: { $gte: todayStart } },
        ],
    };
}

// ─── Collapse service-worker-eviction duplicates ─────────────────────
// Chrome evicts an MV3 service worker after ~30s idle. The extension's
// restoreState() brings back capture.jobs (the full cumulative capture count)
// but NOT capture.sessionId — it is absent from PERSIST_KEYS. So the next
// heartbeat POSTs sessionId:'' , ExtensionSessionStatLog falls out of its
// upsert branch into create(), and a SECOND row appears for the same capture
// session carrying the SAME cumulative captures. Summing rows therefore
// double-counts every job captured before the eviction — which is why the
// milestone totals read high.
//
// Rows from one capture session are identified by (operator, client, startedAt):
// startedAt IS persisted and restored, so it survives eviction unchanged, while
// a genuinely new session gets a fresh ISO-millisecond timestamp.
//
// The two counter families then merge DIFFERENTLY, because they behave
// differently across an eviction:
//   captures — restored from the persisted jobs Map, so EVERY row already holds
//       the session running total → take the MAX (they fully overlap).
//   tokens / batches — live in auto.stats, which is NOT persisted. They climb
//       cumulatively while one service worker is alive, then RESET to zero when
//       it is evicted and start climbing again → a resetting counter (below).
// Get this backwards and you either double-count jobs or mis-count tokens.
//
// Why not a plain sum for tokens: without a sessionId EVERY heartbeat inserts
// its own row, and within one service-worker lifetime those rows are cumulative
// (100, then 250, then 400 …). Summing them would over-count badly. Only a drop
// in the value marks a genuine reset.
//
// sumWithResets — total of a counter that climbs, then restarts at zero.
// Values must be in chronological order.
//   [100, 250]        → 250  (one lifetime, still climbing)
//   [6600, 4400]      → 11000 (dropped ⇒ evicted ⇒ two lifetimes)
//   [100, 250, 50, 80] → 330  (lifetime 1 ended at 250, lifetime 2 at 80)
export function sumWithResets(values) {
    let total = 0, prev = 0;
    for (const raw of values) {
        const v = Math.max(0, Number(raw) || 0);
        total += v >= prev ? v - prev : v; // climbing → add delta; dropped → fresh count
        prev = v;
    }
    return total;
}

// Exported for tests. Pure — takes rows, returns totals.
export function mergeSessionRows(rows) {
    // Chronological: sumWithResets can only spot a reset in time order.
    const ordered = [...(rows || [])].sort((a, b) => {
        const ta = new Date(a.endedAt || a.updatedAt || a.startedAt || 0).getTime();
        const tb = new Date(b.endedAt || b.updatedAt || b.startedAt || 0).getTime();
        return ta - tb;
    });

    const bySession = new Map();
    for (const r of ordered) {
        // Null startedAt (pre-sessionId rows) can't be grouped safely: fall back
        // to the row id so those stay distinct instead of collapsing together.
        const key = r.startedAt
            ? `${r.operatorName || ""}|${r.clientEmail || ""}|${new Date(r.startedAt).toISOString()}`
            : `row:${r._id}`;
        const m = r.modelStats || {};
        let cur = bySession.get(key);
        if (!cur) {
            cur = { captures: 0, series: { openaiBatches: [], geminiBatches: [], inputTokens: [], outputTokens: [], cachedTokens: [] }, rows: 0 };
            bySession.set(key, cur);
        }
        cur.captures = Math.max(cur.captures, r.captures || 0); // fully overlapping
        cur.series.openaiBatches.push(m.openaiBatches || 0);
        cur.series.geminiBatches.push(m.geminiBatches || 0);
        cur.series.inputTokens.push(m.inputTokens || 0);
        cur.series.outputTokens.push(m.outputTokens || 0);
        cur.series.cachedTokens.push(m.cachedTokens || 0);
        cur.rows += 1;
    }
    for (const s of bySession.values()) {
        s.openaiBatches = sumWithResets(s.series.openaiBatches);
        s.geminiBatches = sumWithResets(s.series.geminiBatches);
        s.inputTokens = sumWithResets(s.series.inputTokens);
        s.outputTokens = sumWithResets(s.series.outputTokens);
        s.cachedTokens = sumWithResets(s.series.cachedTokens);
    }
    const out = {
        captures: 0, openaiBatches: 0, geminiBatches: 0,
        inputTokens: 0, outputTokens: 0, cachedTokens: 0,
        sessions: bySession.size,
        // How many rows were folded away. Non-zero means evictions happened and
        // the OLD totals were inflated by exactly this much duplication.
        duplicateRows: 0,
    };
    for (const s of bySession.values()) {
        out.captures += s.captures;
        out.openaiBatches += s.openaiBatches;
        out.geminiBatches += s.geminiBatches;
        out.inputTokens += s.inputTokens;
        out.outputTokens += s.outputTokens;
        out.cachedTokens += s.cachedTokens;
        out.duplicateRows += s.rows - 1;
    }
    return out;
}

// Today's captures + real judge-token usage, with eviction duplicates collapsed.
// Deliberately a find() + JS merge rather than an aggregation: the merge rule
// differs per field (max vs sum), which is far clearer — and unit-testable —
// in code than in a pipeline. Volume is one row per operator-session per day.
async function getTodayExtensionTotals() {
    const rows = await ExtensionSessionStat.find(todayMatch())
        .select("captures modelStats startedAt endedAt updatedAt operatorName clientEmail")
        .lean();
    return mergeSessionRows(rows);
}

// Count today's second-stage screening outcomes (IST). `fastKept` is the
// saving the regex fast-screen bought us — those jobs never hit OpenAI.
async function getTodaySecondJudgeRuns() {
    const start = startOfTodayIST();
    try {
        const [completed, fastKept, skipped] = await Promise.all([
            JobModel.countDocuments({ "secondJudge.completedAt": { $gte: start } }),
            JobModel.countDocuments({
                "secondJudge.completedAt": { $gte: start },
                "secondJudge.status": "passed",
                "secondJudge.reason": /^Kept — fast/,
            }),
            JobModel.countDocuments({
                "secondJudge.completedAt": { $gte: start },
                "secondJudge.status": "skipped",
            }),
        ]);
        return { completed, fastKept, skipped, llm: Math.max(0, completed - fastKept - skipped) };
    } catch {
        return { completed: 0, fastKept: 0, skipped: 0, llm: 0 };
    }
}

// ─── Stage 1 cost: measured when possible ────────────────────────────
// Returns { measured, batches, inputTokens, cachedTokens, outputTokens, usd, cacheSavedUsd }
export function stage1Cost(ext, scrapedJobs) {
    const hasRealTokens = (ext.inputTokens || 0) > 0 || (ext.outputTokens || 0) > 0;
    if (hasRealTokens) {
        const p = priceTokens({
            model: STAGE1_MODEL,
            inputTokens: ext.inputTokens,
            cachedTokens: ext.cachedTokens,
            outputTokens: ext.outputTokens,
        });
        return {
            measured: true,
            batches: (ext.openaiBatches || 0) + (ext.geminiBatches || 0),
            inputTokens: ext.inputTokens,
            cachedTokens: ext.cachedTokens,
            outputTokens: ext.outputTokens,
            usd: p.usd,
            cacheSavedUsd: p.cacheSavedUsd,
        };
    }
    // Fallback — extension build too old to report usage.
    const batches = Math.ceil(Math.max(0, Number(scrapedJobs) || 0) / BATCH_SIZE);
    const inputTokens = batches * EST_TOKENS_IN_PER_BATCH;
    const outputTokens = batches * EST_TOKENS_OUT_PER_BATCH;
    const cachedTokens = Math.min(inputTokens, batches * EST_CACHED_PER_BATCH);
    const p = priceTokens({ model: STAGE1_MODEL, inputTokens, cachedTokens, outputTokens });
    return {
        measured: false,
        batches,
        inputTokens,
        cachedTokens,
        outputTokens,
        usd: p.usd,
        cacheSavedUsd: p.cacheSavedUsd,
    };
}

// ─── SCOPE: the scrape pipeline, and nothing else ────────────────────
// This is a SCRAPE milestone, so it prices exactly the two stages a scraped job
// passes through:
//   Stage 1 — the extension's first judge, on JobRight's own description
//   Stage 2 — secondJudgeWorker, re-judging the real employer posting
//
// Everything else the backend spends on AI is deliberately EXCLUDED: resume
// auto-optimization, AI summaries, recruiter templates, job extraction, mail.
// None of them is caused by scraping a job, so folding them in would make
// "cost per job" a number that moves when nobody scraped anything.
//
// Auto-optimization in particular is not merely excluded, it is not on this
// bill at all: autoOptimizationWorker calls RESUME_API_URL/api/optimize-with-
// gemini, a separate microservice on Google's Gemini, so it never touches this
// OpenAI account.
//
// Those pipelines ARE still recorded (Utils/aiUsage.js) — they are simply
// reported separately, via GET /admin/ai-cost, where a per-pipeline total is
// meaningful. The embed labels its figure "scrape pipeline" rather than "TOTAL"
// so a scoped number is never again mistaken for the whole invoice.
const SCRAPE_PIPELINE_SOURCES = new Set(["first-judge", "second-judge"]);

// buildCostReport — the day's SCRAPE-pipeline spend, measured where possible.
export async function buildCostReport({ scrapedJobs, ext, usage, secondStats }) {
    const s1 = stage1Cost(ext, scrapedJobs);

    const allRows = usage.rows || [];
    // Only the scrape stages count toward this report. `first-judge` rows appear
    // solely if a future extension build routes through the backend proxy;
    // today it calls OpenAI directly, so they are empty and cannot double-count
    // against s1.
    const rows = allRows.filter((r) => SCRAPE_PIPELINE_SOURCES.has(r.source));
    const second = rows.find((r) => r.source === "second-judge") || null;
    const stage2Usd = rows.reduce((a, r) => a + r.usd, 0);

    // Context only, never added to the total: what the non-scrape pipelines spent
    // today. Shown as one line so the embed cannot be read as the whole bill.
    const otherRows = allRows.filter((r) => !SCRAPE_PIPELINE_SOURCES.has(r.source));
    const otherUsd = otherRows.reduce((a, r) => a + r.usd, 0);

    // What the stage-2 fast-screen avoided: price ONE measured LLM run and
    // multiply by the jobs it skipped. With no measured run yet, contribute 0
    // rather than inventing a per-run token count.
    const perLlmUsd = second && second.calls > 0 ? second.usd / second.calls : 0;
    const fastScreenSavedUsd = (secondStats.fastKept || 0) * perLlmUsd;

    // Missing-usage count for the SCRAPE stages only.
    const scrapeMissingUsage = rows.reduce((a, r) => a + (r.callsMissingUsage || 0), 0);

    const totalUsd = s1.usd + stage2Usd;
    const cacheSavedUsd = s1.cacheSavedUsd + rows.reduce((a, r) => a + (r.cacheSavedUsd || 0), 0);
    const n = Math.max(0, Number(scrapedJobs) || 0);

    return {
        scraped: n,
        model: STAGE1_MODEL,
        stage1: s1,
        rows,                 // scrape-pipeline rows only
        stage2Usd,
        // Context, NOT part of totalUsd — see SCRAPE_PIPELINE_SOURCES above.
        otherUsd,
        otherCalls: otherRows.reduce((a, r) => a + r.calls, 0),
        secondStats,
        fastScreenSavedUsd,
        cacheSavedUsd,
        totalUsd,
        perJobUsd: n ? totalUsd / n : 0,
        fxRate: FX_USD_INR,
        // Scoped to the scrape stages: a recruiter-template call that came back
        // without a usage block says nothing about whether THIS figure is exact.
        fullyMeasured: s1.measured && scrapeMissingUsage === 0,
        callsMissingUsage: scrapeMissingUsage,
        // Eviction-duplicate rows folded away. Non-zero proves SW evictions are
        // happening; the pre-fix totals were inflated by exactly this overlap.
        sessions: ext.sessions || 0,
        duplicateRows: ext.duplicateRows || 0,
    };
}

// Atomically claim a milestone. Returns the milestone integer (5000 * k)
// on success, null when already fired today. Idempotent across restarts.
async function claimMilestone(today, currentTotal) {
    const target = Math.floor(currentTotal / MILESTONE_STEP) * MILESTONE_STEP;
    if (target < MILESTONE_STEP) return null;
    const fieldKey = `scrapeMilestones.${today}`;
    await AppSettingsModel.findOneAndUpdate(
        { key: "singleton" },
        { $max: { [fieldKey]: target } },
        { upsert: true, new: true, lean: true },
    );
    const firedKey = `scrapeMilestonesFired.${today}.${target}`;
    const claim = await AppSettingsModel.findOneAndUpdate(
        { key: "singleton", [firedKey]: { $exists: false } },
        { $set: { [firedKey]: new Date() } },
        { new: false },
    );
    if (!claim) return null; // someone else fired it
    return target;
}

const usd = (v) => `$${v.toFixed(4)}`;
const both = (v) => `$${v.toFixed(4)} · ₹${inr(v).toFixed(2)}`;

// fireDiscord: post the embed. Pulls webhook from env on each call so
// .env edits take effect without restart. No-op when webhook missing.
async function fireDiscord(milestone, r, today) {
    const webhook = (process.env.DISCORD_SCRAPE_WEBHOOK_URL || "").trim();
    if (!webhook) {
        console.log(`[scrapeCostNotifier] milestone ${milestone} reached but DISCORD_SCRAPE_WEBHOOK_URL not set — skipping`);
        return;
    }

    const s1 = r.stage1;
    const cachePct = s1.inputTokens ? Math.round((s1.cachedTokens / s1.inputTokens) * 100) : 0;
    const tag = s1.measured ? "measured" : "ESTIMATED";

    const second = r.rows.find((x) => x.source === "second-judge") || null;
    const stage1Pct = r.totalUsd > 0 ? Math.round((s1.usd / r.totalUsd) * 100) : 0;

    const fields = [
        { name: "Today scraped", value: `**${r.scraped.toLocaleString()}** jobs`, inline: true },
        { name: "Judge batches", value: `${s1.batches.toLocaleString()} × ${BATCH_SIZE} jobs`, inline: true },
        { name: "Model", value: `\`${r.model}\``, inline: true },

        { name: `Input tokens (${tag})`, value: s1.inputTokens.toLocaleString(), inline: true },
        { name: `Output tokens (${tag})`, value: s1.outputTokens.toLocaleString(), inline: true },
        { name: "Cached input (50% off)", value: `${s1.cachedTokens.toLocaleString()} (${cachePct}%)`, inline: true },

        {
            name: `1️⃣ Stage 1 — extension scraper judge (${tag})`,
            value: `${both(s1.usd)} · ${stage1Pct}% of scrape cost`,
            inline: false,
        },
        {
            name: "2️⃣ Stage 2 — second judge (measured)",
            value: second
                ? `${both(second.usd)} · ${second.calls.toLocaleString()} LLM runs · ${second.inputTokens.toLocaleString()} in / ${second.outputTokens.toLocaleString()} out`
                : `${both(0)} · no LLM runs recorded today`,
            inline: false,
        },
        {
            name: "💵 SCRAPE PIPELINE COST (stage 1 + stage 2)",
            value: `**${both(r.totalUsd)}**  ·  per job $${r.perJobUsd.toFixed(6)} · ₹${inr(r.perJobUsd).toFixed(4)}`,
            inline: false,
        },

        { name: "🟢 Fast-screen saved", value: `${r.secondStats.fastKept.toLocaleString()} jobs w/o LLM · ${both(r.fastScreenSavedUsd)}`, inline: true },
        { name: "💰 Prompt-cache saved", value: both(r.cacheSavedUsd), inline: true },
        { name: "FX rate (fixed)", value: `₹${r.fxRate} / USD`, inline: true },
    ];

    // Other AI pipelines are NOT in the total above. One context line so the
    // scrape figure is never mistaken for the whole bill — the exact confusion
    // the old "TOTAL cost" label created.
    if (r.otherUsd > 0) {
        fields.push({
            name: "ℹ️ Other AI today (NOT counted above)",
            value: `${both(r.otherUsd)} · ${r.otherCalls.toLocaleString()} calls — summaries, recruiter templates, extraction. Full breakdown: \`GET /admin/ai-cost\``,
            inline: false,
        });
    }

    // Say plainly how trustworthy the number is. A cost report that cannot be
    // reconciled against the invoice is worse than useless.
    const caveats = [];
    if (!s1.measured) {
        caveats.push(`⚠️ Stage 1 is ESTIMATED (${EST_TOKENS_IN_PER_BATCH}/${EST_TOKENS_OUT_PER_BATCH} tok/batch) — this extension build does not report token usage. Update the extension for exact numbers.`);
    }
    if (r.callsMissingUsage > 0) {
        caveats.push(`⚠️ ${r.callsMissingUsage} backend call(s) returned no usage block — total is a FLOOR.`);
    }
    if (r.duplicateRows > 0) {
        caveats.push(`🧹 Collapsed ${r.duplicateRows} duplicate session row(s) across ${r.sessions} session(s) — Chrome evicted the extension's service worker mid-capture. Before this fix those rows were summed, inflating the job count.`);
    }
    if (!caveats.length) {
        caveats.push("✅ Every figure above is measured from provider-reported token counts.");
    }
    caveats.push("Covers this backend's OpenAI/Vertex calls only — it will not match the OpenAI invoice if other services share the key.");

    const embed = {
        title: `📈 Scrape milestone: ${milestone.toLocaleString()} jobs today`,
        description:
            `Today (${today} IST) the JR-Direct extension has captured **${milestone.toLocaleString()}** jobs across all operators.\n\n` +
            caveats.join("\n"),
        color: r.fullyMeasured ? 0x10b981 : 0xf59e0b,
        fields,
        footer: {
            text: `Priced from provider-reported tokens · rate card in Utils/aiRateCard.js · ₹${r.fxRate}/USD`,
        },
        timestamp: new Date().toISOString(),
    };
    try {
        await axios.post(webhook, { embeds: [embed] }, { timeout: 8000 });
        console.log(`[scrapeCostNotifier] fired milestone ${milestone} → Discord (fullyMeasured=${r.fullyMeasured})`);
    } catch (err) {
        console.warn(`[scrapeCostNotifier] Discord POST failed for milestone ${milestone}:`, err.message);
    }
}

// ─── Daily snapshot for the admin dashboard graphs ───────────────────
// Persist today's scrape-pipeline cost as a dated row so /admin/scrape-cost/
// history can chart daily and monthly spend. Unlike the Discord milestone
// (which only fires at 5000-job thresholds), this runs unconditionally on a
// cron, so even a low-volume day still gets a row. Idempotent: one upsert per
// IST day, overwriting as the day's numbers climb. Never throws.
export async function snapshotTodayScrapeCost() {
    try {
        const day = istDay();
        const ext = await getTodayExtensionTotals();
        const [secondStats, usage] = await Promise.all([
            getTodaySecondJudgeRuns(),
            getDailyUsage(day),
        ]);
        const r = await buildCostReport({ scrapedJobs: ext.captures, ext, usage, secondStats });
        await ScrapeCostDaily.updateOne(
            { day },
            {
                $set: {
                    day,
                    scraped: r.scraped,
                    stage1Usd: r.stage1.usd,
                    stage1InputTokens: r.stage1.inputTokens,
                    stage1CachedTokens: r.stage1.cachedTokens,
                    stage1OutputTokens: r.stage1.outputTokens,
                    stage1Batches: r.stage1.batches,
                    stage1Measured: r.stage1.measured,
                    stage2Usd: r.stage2Usd,
                    totalUsd: r.totalUsd,
                    perJobUsd: r.perJobUsd,
                    otherUsd: r.otherUsd,
                    otherCalls: r.otherCalls,
                    fastScreenSavedUsd: r.fastScreenSavedUsd,
                    cacheSavedUsd: r.cacheSavedUsd,
                    fxRate: r.fxRate,
                    fullyMeasured: r.fullyMeasured,
                    callsMissingUsage: r.callsMissingUsage,
                    sessions: r.sessions,
                    duplicateRows: r.duplicateRows,
                    secondJudgeCompleted: r.secondStats.completed,
                    secondJudgeFastKept: r.secondStats.fastKept,
                    secondJudgeLlm: r.secondStats.llm,
                },
            },
            { upsert: true }
        );
        return r;
    } catch (err) {
        console.warn("[scrapeCostSnapshot] failed:", err.message);
        return null;
    }
}

let snapshotTask = null;
// Snapshot on boot, then every 10 minutes (IST). Guarantees a dated row for the
// current day regardless of whether a Discord milestone ever fires.
export function startScrapeCostSnapshotWorker() {
    snapshotTodayScrapeCost();
    if (snapshotTask) return snapshotTask;
    snapshotTask = cron.schedule("*/10 * * * *", () => snapshotTodayScrapeCost(), { timezone: "Asia/Kolkata" });
    console.log("[scrapeCostSnapshot] worker registered (cron='*/10 * * * *')");
    return snapshotTask;
}

// checkAndNotify: call after every ExtensionSessionStat upsert. Cheap when
// no milestone. No-op when webhook env unset. Always fire-and-forget.
export async function checkAndNotifyScrapeMilestone() {
    try {
        const today = istDay();
        const ext = await getTodayExtensionTotals();
        if (ext.captures < MILESTONE_STEP) return; // nothing to do under first threshold
        const milestone = await claimMilestone(today, ext.captures);
        if (!milestone) return; // already announced
        const [secondStats, usage] = await Promise.all([
            getTodaySecondJudgeRuns(),
            getDailyUsage(today),
        ]);
        // Report on the ACTUAL scraped count, not the rounded milestone: the
        // token totals are real and belong to real jobs, so rounding the job
        // count down would silently inflate per-job cost.
        const report = await buildCostReport({ scrapedJobs: ext.captures, ext, usage, secondStats });
        await fireDiscord(milestone, report, today);
    } catch (err) {
        console.warn("[scrapeCostNotifier] check failed:", err.message);
    }
}
