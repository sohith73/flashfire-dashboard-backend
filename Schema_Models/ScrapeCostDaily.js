import mongoose from "mongoose";

// One document per IST day: the scrape-pipeline cost snapshot the admin
// dashboard charts as daily and monthly spend. Written by
// Utils/scrapeCostNotifier.js → snapshotTodayScrapeCost() on a 10-minute cron,
// upserted so the row for "today" keeps climbing as more jobs are scraped.
//
// Mirrors the shape of buildCostReport()'s return so the graph and the Discord
// embed always price the day the same way. Costs are stored in USD; INR is
// derived at read time from fxRate (the fixed ₹94/USD rate card value).
const scrapeCostDailySchema = new mongoose.Schema(
    {
        day: { type: String, required: true, unique: true, index: true }, // IST YYYY-MM-DD

        scraped: { type: Number, default: 0 },

        // Stage 1 — extension scraper judge (gpt-4o-mini).
        stage1Usd: { type: Number, default: 0 },
        stage1InputTokens: { type: Number, default: 0 },
        stage1CachedTokens: { type: Number, default: 0 },
        stage1OutputTokens: { type: Number, default: 0 },
        stage1Batches: { type: Number, default: 0 },
        stage1Measured: { type: Boolean, default: false },

        // Stage 2 — second judge.
        stage2Usd: { type: Number, default: 0 },

        // Scrape-pipeline total (stage 1 + stage 2) and unit economics.
        totalUsd: { type: Number, default: 0 },
        perJobUsd: { type: Number, default: 0 },

        // Context only — the non-scrape AI pipelines' spend, NOT part of totalUsd.
        otherUsd: { type: Number, default: 0 },
        otherCalls: { type: Number, default: 0 },

        fastScreenSavedUsd: { type: Number, default: 0 },
        cacheSavedUsd: { type: Number, default: 0 },
        fxRate: { type: Number, default: 94 },

        // Trust markers, carried through from the cost report.
        fullyMeasured: { type: Boolean, default: false },
        callsMissingUsage: { type: Number, default: 0 },
        sessions: { type: Number, default: 0 },
        duplicateRows: { type: Number, default: 0 },

        secondJudgeCompleted: { type: Number, default: 0 },
        secondJudgeFastKept: { type: Number, default: 0 },
        secondJudgeLlm: { type: Number, default: 0 },
    },
    { timestamps: true }
);

scrapeCostDailySchema.index({ day: -1 });

export const ScrapeCostDaily =
    mongoose.models.ScrapeCostDaily || mongoose.model("ScrapeCostDaily", scrapeCostDailySchema);
