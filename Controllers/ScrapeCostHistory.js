import { ScrapeCostDaily } from "../Schema_Models/ScrapeCostDaily.js";

const round4 = (v) => Math.round((Number(v) || 0) * 1e4) / 1e4;
const round2 = (v) => Math.round((Number(v) || 0) * 1e2) / 1e2;

// GET /admin/scrape-cost/history?days=30&months=12
// Serves the admin dashboard's daily- and monthly-spend graphs from the
// ScrapeCostDaily snapshots. Daily = the last `days` dated rows; monthly = those
// rows grouped by YYYY-MM. Costs are stored in USD; INR is derived from each
// row's fxRate so a historical rate change never retro-repriced older days.
export default async function ScrapeCostHistory(req, res) {
    try {
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 180);
        const months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 36);

        // Pull enough rows to cover the longer of the two windows (a full year
        // of daily rows for the monthly rollup), newest first, then chronological.
        const limit = Math.max(days, months * 31);
        const rows = (
            await ScrapeCostDaily.find({}).sort({ day: -1 }).limit(limit).lean()
        ).reverse();

        const fx = rows.length ? rows[rows.length - 1].fxRate || 94 : 94;

        const daily = rows.slice(-days).map((r) => ({
            day: r.day,
            scraped: r.scraped || 0,
            totalUsd: round4(r.totalUsd),
            totalInr: round2((r.totalUsd || 0) * (r.fxRate || fx)),
            otherUsd: round4(r.otherUsd),
            perJobUsd: r.perJobUsd || 0,
            fullyMeasured: !!r.fullyMeasured,
        }));

        // Monthly rollup: sum each YYYY-MM.
        const byMonth = new Map();
        for (const r of rows) {
            const month = (r.day || "").slice(0, 7);
            if (!month) continue;
            const m = byMonth.get(month) || {
                month,
                totalUsd: 0,
                otherUsd: 0,
                scraped: 0,
                fxRate: r.fxRate || fx,
            };
            m.totalUsd += r.totalUsd || 0;
            m.otherUsd += r.otherUsd || 0;
            m.scraped += r.scraped || 0;
            m.fxRate = r.fxRate || m.fxRate;
            byMonth.set(month, m);
        }
        const monthly = [...byMonth.values()]
            .sort((a, b) => a.month.localeCompare(b.month))
            .slice(-months)
            .map((m) => ({
                month: m.month,
                scraped: m.scraped,
                totalUsd: round4(m.totalUsd),
                totalInr: round2(m.totalUsd * m.fxRate),
                otherUsd: round4(m.otherUsd),
            }));

        res.json({ success: true, fxRate: fx, daily, monthly });
    } catch (err) {
        console.error("ScrapeCostHistory failed:", err);
        res.status(500).json({ success: false, error: err.message });
    }
}
