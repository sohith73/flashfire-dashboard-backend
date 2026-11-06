import mongoose from "mongoose";
import { AutopilotRun } from "../Schema_Models/AutopilotRun.js";
import { AutopilotRunRequest } from "../Schema_Models/AutopilotRunRequest.js";
import { JobModel } from "../Schema_Models/JobModel.js";
import { parseDaysParam, startOfIstDayWindow, istWindowLabel } from "../Utils/istWindow.js";

// Autopilot run history + the scrape request queue.
//
// Writers (the autopilot posting results, claiming queue items) sit behind
// requireOpsKey. Readers are open, matching the other dashboard endpoints this
// portal already calls (/summaries-overview, /push-history); the Auto
// Extension tab is admin-gated in the UI. That is a UI gate, not a server one -
// worth tightening if these numbers ever become sensitive.

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

const clampLimit = (raw, fallback = DEFAULT_LIMIT) => {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, MAX_LIMIT);
};

const cleanEmail = (raw) => String(raw || "").toLowerCase().trim();

// Coerce anything the autopilot sends into a non-negative integer. A missing
// counter must read as 0, never NaN - NaN would poison every $sum downstream.
const num = (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
};

const cleanStr = (raw, max) => String(raw || "").slice(0, max);

const toDate = (raw) => {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Lowest ObjectId that could have been minted at or after `d`.
const oidAt = (d, extraSeconds = 0) =>
  new mongoose.Types.ObjectId(
    Math.floor(d.getTime() / 1000 + extraSeconds).toString(16).padStart(8, "0") + "0000000000000000"
  );

/**
 * How many jobs actually landed on this client's dashboard between `from` and
 * `to` - the server's own answer to "what did this run push".
 *
 * WHY THE SERVER COUNTS INSTEAD OF TRUSTING THE AUTOPILOT
 * The autopilot's number is read off the extension panel's DOM, and that read
 * swallows its errors and returns 0. On 2026-09-23 a run for
 * mittapallisharmelee9599@gmail.com reported captured 0 / pushed 0 while 33
 * operator jobs were created for that client inside the run's own window - the
 * autopilot UI (which asks the server) showed "cap 26/30" at the same moment.
 * The jobs themselves cannot be misread, so they are the count.
 *
 * Every operator-created job counts, including ones the second judge later
 * removed: this run DID push them, and "pushed" means "reached the dashboard".
 * The one thing this cannot tell apart is a human operator pushing to the same
 * client inside the same few minutes; that is rare, and over-counting a real
 * push beats reporting zero for 33.
 */
export async function countPushedDuring(clientEmail, from, to) {
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) return null;
  const end = to instanceof Date && !Number.isNaN(to.getTime()) ? to : new Date();
  return JobModel.countDocuments({
    userID: clientEmail,
    createdByRole: "operations",
    // +1s on the upper bound: ObjectIds carry whole seconds, so a job minted
    // in the run's final second would otherwise fall outside it.
    _id: { $gte: oidAt(from), $lt: oidAt(end, 1) }
  });
}

// A "running" row whose last progress is older than this is a run whose
// machine went away (closed laptop, crashed app). Reported as interrupted.
export const STALE_RUNNING_MS = 15 * 60 * 1000;

/**
 * POST /autopilot/runs/start   (ops key)
 *
 * Opens a run the moment it starts, so the portal shows it live instead of
 * finding out twenty minutes later - or never, if the laptop is shut mid-run.
 */
export const startAutopilotRun = async (req, res) => {
  try {
    const body = req.body || {};
    const clientEmail = cleanEmail(body.clientEmail);
    if (!clientEmail.includes("@")) {
      return res.status(400).json({ success: false, message: "clientEmail is required" });
    }
    const startedAt = toDate(body.startedAt) || new Date();
    const doc = await AutopilotRun.create({
      clientEmail,
      clientName: String(body.clientName || "").trim(),
      profile: String(body.profile || "").trim(),
      cap: num(body.cap),
      host: cleanStr(body.host, 120),
      trigger: ["schedule", "manual", "portal", "europe"].includes(body.trigger) ? body.trigger : "manual",
      requestedBy: cleanStr(body.requestedBy, 200),
      status: "running",
      outcome: "running",
      outcomeLabel: "Running",
      why: "Scrape in progress.",
      startedAt,
      finishedAt: startedAt
    });
    res.status(201).json({ success: true, id: doc._id });
  } catch (error) {
    console.error("startAutopilotRun failed:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /autopilot/runs/:id/progress   (ops key)
 * body: { captured?, pushedReported?, panelReadErrors?, stage?, pageUrl? }
 *
 * Called every few seconds while a run is live. `pushed` is recounted here from
 * the jobs themselves (see countPushedDuring), so the portal is right even when
 * the panel read is not.
 */
export const progressAutopilotRun = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "bad id" });
    }
    const run = await AutopilotRun.findById(id).select("clientEmail startedAt status captured").lean();
    if (!run) return res.status(404).json({ success: false, message: "run not found" });
    // A late progress call must never reopen a run that already finished.
    if (run.status !== "running") {
      return res.status(409).json({ success: false, message: "run already finished" });
    }

    const body = req.body || {};
    const now = new Date();
    const pushed = (await countPushedDuring(run.clientEmail, run.startedAt, now)) ?? 0;
    // The panel's capture counter only grows within a run; never let a stale
    // or failed read pull the live number backwards.
    const captured = Math.max(num(body.captured), run.captured || 0);

    const set = {
      captured,
      pushed,
      rejected: Math.max(captured - pushed, 0),
      pushedReported: num(body.pushedReported),
      panelReadErrors: num(body.panelReadErrors),
      finishedAt: now
    };
    if (body.stage !== undefined) set.stage = cleanStr(body.stage, 300);
    if (body.pageUrl !== undefined) set.pageUrl = cleanStr(body.pageUrl, 500);

    await AutopilotRun.updateOne({ _id: id, status: "running" }, { $set: set });
    res.status(200).json({ success: true, captured, pushed });
  } catch (error) {
    console.error("progressAutopilotRun failed:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /autopilot/runs   (ops key)
 *
 * The autopilot posts one of these when a client's run finishes, whatever the
 * outcome - a failed run is exactly the row ops needs to see, so failures are
 * recorded like any other.
 */
export const recordAutopilotRun = async (req, res) => {
  try {
    const body = req.body || {};
    const clientEmail = cleanEmail(body.clientEmail);
    if (!clientEmail.includes("@")) {
      return res.status(400).json({ success: false, message: "clientEmail is required" });
    }

    const captured = num(body.captured);
    const pushedReported = num(body.pushed);
    const startedAt = body.startedAt ? toDate(body.startedAt) : null;
    const finishedAt = toDate(body.finishedAt) || new Date();

    // The server's count wins whenever the run's window is known - see
    // countPushedDuring for the incident that made this necessary. A build
    // too old to send startedAt keeps its own number.
    const counted = startedAt ? await countPushedDuring(clientEmail, startedAt, finishedAt) : null;
    const pushed = counted ?? pushedReported;

    const fields = {
      clientEmail,
      clientName: String(body.clientName || "").trim(),
      profile: String(body.profile || "").trim(),

      captured,
      pushed,
      pushedReported,
      panelReadErrors: num(body.panelReadErrors),
      // Trust our own arithmetic over a number that travelled: rejected is
      // captured minus pushed by definition, and a run that pushed more than
      // it captured (panel counters read mid-update) must not go negative.
      rejected: Math.max(captured - pushed, 0),
      picks: num(body.picks),
      dupes: num(body.dupes),
      blocked: num(body.blocked),
      errorCount: num(body.errors),

      cap: num(body.cap),
      minutes: Number.isFinite(Number(body.minutes)) ? Math.max(Number(body.minutes), 0) : 0,
      attempts: Math.max(num(body.attempts) || 1, 1),

      outcome: String(body.outcome || "").slice(0, 200),
      outcomeLabel: String(body.outcomeLabel || "").slice(0, 120),
      why: String(body.why || "").slice(0, 600),
      severity: ["good", "warn", "bad"].includes(body.severity) ? body.severity : "",
      errorText: String(body.errorText || "").slice(0, 600),

      host: String(body.host || "").slice(0, 120),
      trigger: ["schedule", "manual", "portal", "europe"].includes(body.trigger) ? body.trigger : "manual",
      requestedBy: String(body.requestedBy || "").slice(0, 200),

      pageUrl: cleanStr(body.pageUrl, 500),
      report: cleanStr(body.report, 200),
      snapshot: cleanStr(body.snapshot, 200),
      stage: "",
      status: "finished",

      startedAt: startedAt || undefined,
      finishedAt
    };

    // A run opened with /autopilot/runs/start is closed in place, so the live
    // row and the final row are one document rather than two.
    if (body.runId && mongoose.isValidObjectId(body.runId)) {
      const updated = await AutopilotRun.findOneAndUpdate(
        { _id: body.runId, clientEmail },
        { $set: fields },
        { new: true, lean: true }
      );
      if (updated) return res.status(200).json({ success: true, id: updated._id, pushed });
      // The opening row is gone (or belongs to someone else): fall through
      // and record the run fresh rather than lose it.
    }

    const doc = await AutopilotRun.create(fields);
    res.status(201).json({ success: true, id: doc._id, pushed });
  } catch (error) {
    console.error("recordAutopilotRun failed:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /autopilot/runs?limit=&email=&since=&outcome=
 *
 * Flat, newest-first run list. Used by the "All runs" view.
 */
export const listAutopilotRuns = async (req, res) => {
  try {
    const filter = {};
    const email = cleanEmail(req.query.email);
    if (email) filter.clientEmail = email;
    if (req.query.outcome) filter.outcome = String(req.query.outcome);
    if (req.query.since) {
      const since = new Date(req.query.since);
      if (!Number.isNaN(since.getTime())) filter.finishedAt = { $gte: since };
    }

    const docs = await AutopilotRun.find(filter)
      .sort({ finishedAt: -1 })
      .limit(clampLimit(req.query.limit))
      .lean();

    res.status(200).json({ success: true, count: docs.length, data: docs });
  } catch (error) {
    console.error("listAutopilotRuns failed:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /autopilot/runs/summary?days=
 *
 * One row per client: their latest run plus totals over the window. This is
 * what the Auto Extension table renders, and it is a single aggregation rather
 * than N queries so 293 clients stay one round trip.
 */
export const getAutopilotRunsSummary = async (req, res) => {
  try {
    // days=N is N IST CALENDAR days, today included - not a rolling N*24h.
    // "Today" therefore starts at 00:00 IST and resets at midnight, which is
    // what the operators read it as and what the daily cap already uses. The
    // old rolling cutoff meant that at 18:00 the "Today" totals still carried
    // half of yesterday's runs and never reset.
    const days = parseDaysParam(req.query.days, { fallback: 30, max: 365 });
    const since = startOfIstDayWindow(days);
    const until = new Date();

    const rows = await AutopilotRun.aggregate([
      // $lte now: a run row whose finishedAt is in the future (a clock skew on
      // an autopilot host) would otherwise sit at the top of every window
      // forever, since $sort is on finishedAt descending.
      { $match: { finishedAt: { $gte: since, $lte: until } } },
      { $sort: { finishedAt: -1 } },
      {
        $group: {
          _id: "$clientEmail",
          // $first after the sort above = the most recent run.
          lastRun: { $first: "$$ROOT" },
          runs: { $sum: 1 },
          totalCaptured: { $sum: "$captured" },
          totalPushed: { $sum: "$pushed" },
          totalRejected: { $sum: "$rejected" },
          totalMinutes: { $sum: "$minutes" },
          failedRuns: { $sum: { $cond: [{ $eq: ["$severity", "bad"] }, 1, 0] } }
        }
      },
      { $sort: { "lastRun.finishedAt": -1 } }
    ]);

    const data = rows.map((r) => ({
      clientEmail: r._id,
      clientName: r.lastRun.clientName || "",
      profile: r.lastRun.profile || "",
      runs: r.runs,
      failedRuns: r.failedRuns,
      totalCaptured: r.totalCaptured,
      totalPushed: r.totalPushed,
      totalRejected: r.totalRejected,
      totalMinutes: Math.round(r.totalMinutes * 10) / 10,
      lastRunAt: r.lastRun.finishedAt,
      lastCaptured: r.lastRun.captured,
      lastPushed: r.lastRun.pushed,
      lastRejected: r.lastRun.rejected,
      lastCap: r.lastRun.cap,
      lastMinutes: r.lastRun.minutes,
      lastOutcome: r.lastRun.outcome,
      lastOutcomeLabel: r.lastRun.outcomeLabel,
      lastWhy: r.lastRun.why,
      lastSeverity: r.lastRun.severity,
      lastError: r.lastRun.errorText,
      lastTrigger: r.lastRun.trigger,
      // Live-run fields. A "running" row that stopped updating is reported as
      // interrupted, so a closed laptop never shows as eternally scraping.
      lastStatus:
        r.lastRun.status === "running" &&
        Date.now() - new Date(r.lastRun.finishedAt).getTime() > STALE_RUNNING_MS
          ? "interrupted"
          : r.lastRun.status || "finished",
      lastStage: r.lastRun.stage || "",
      lastPageUrl: r.lastRun.pageUrl || "",
      lastSnapshot: r.lastRun.snapshot || "",
      lastReport: r.lastRun.report || "",
      lastHost: r.lastRun.host || ""
    }));

    const totals = data.reduce(
      (acc, r) => ({
        clients: acc.clients + 1,
        runs: acc.runs + r.runs,
        captured: acc.captured + r.totalCaptured,
        pushed: acc.pushed + r.totalPushed,
        rejected: acc.rejected + r.totalRejected,
        failedRuns: acc.failedRuns + r.failedRuns
      }),
      { clients: 0, runs: 0, captured: 0, pushed: 0, rejected: 0, failedRuns: 0 }
    );

    res.status(200).json({
      success: true,
      days,
      // The client renders these, so it never has to re-derive the boundary
      // and can never disagree with the server about where "today" starts.
      windowStart: since.toISOString(),
      windowLabel: istWindowLabel(days),
      timezone: "Asia/Kolkata",
      totals,
      count: data.length,
      data
    });
  } catch (error) {
    console.error("getAutopilotRunsSummary failed:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /autopilot/runs/client/:email?limit=
 *
 * Full run history for one client - the detail view behind a table row.
 */
export const getAutopilotRunsForClient = async (req, res) => {
  try {
    const email = cleanEmail(req.params.email);
    if (!email.includes("@")) {
      return res.status(400).json({ success: false, message: "bad email" });
    }

    const [runs, requests] = await Promise.all([
      AutopilotRun.find({ clientEmail: email })
        .sort({ finishedAt: -1 })
        .limit(clampLimit(req.query.limit, 50))
        .lean(),
      AutopilotRunRequest.find({ clientEmail: email }).sort({ createdAt: -1 }).limit(10).lean()
    ]);

    const totals = runs.reduce(
      (acc, r) => ({
        runs: acc.runs + 1,
        captured: acc.captured + (r.captured || 0),
        pushed: acc.pushed + (r.pushed || 0),
        rejected: acc.rejected + (r.rejected || 0),
        minutes: acc.minutes + (r.minutes || 0)
      }),
      { runs: 0, captured: 0, pushed: 0, rejected: 0, minutes: 0 }
    );
    totals.minutes = Math.round(totals.minutes * 10) / 10;

    res.status(200).json({ success: true, clientEmail: email, totals, runs, requests });
  } catch (error) {
    console.error("getAutopilotRunsForClient failed:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /autopilot/queue   (ops key)   body: { clientEmail, clientName?, maxJobs?, requestedBy? }
 *
 * The portal's Scrape button. Returns 409 when the client already has a live
 * request, so a double click is a clear "already queued" rather than a second
 * browser fighting over the same Chrome profile.
 */
export const queueAutopilotRun = async (req, res) => {
  try {
    const clientEmail = cleanEmail(req.body?.clientEmail);
    if (!clientEmail.includes("@")) {
      return res.status(400).json({ success: false, message: "clientEmail is required" });
    }

    let maxJobs = null;
    if (req.body?.maxJobs !== undefined && req.body.maxJobs !== "" && req.body.maxJobs !== null) {
      // Number(), not parseInt(): parseInt("2.5") is 2, which would silently
      // accept a fractional cap as though the operator had asked for 2.
      const raw = req.body.maxJobs;
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isInteger(n) || n < 1 || n > 30) {
        return res.status(400).json({ success: false, message: "maxJobs must be a whole number between 1 and 30" });
      }
      maxJobs = n;
    }

    const doc = await AutopilotRunRequest.create({
      clientEmail,
      clientName: String(req.body?.clientName || "").trim(),
      maxJobs,
      requestedBy: String(req.body?.requestedBy || "").slice(0, 200),
      status: "queued"
    });

    res.status(201).json({ success: true, id: doc._id, status: doc.status });
  } catch (error) {
    // 11000 is the one_live_request_per_client partial unique index firing.
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "This client already has a scrape queued or running."
      });
    }
    console.error("queueAutopilotRun failed:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /autopilot/queue?status=&limit=
 *
 * What the portal shows as "queued / running" next to each client.
 */
export const listAutopilotQueue = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) {
      const wanted = String(req.query.status)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (wanted.length) filter.status = { $in: wanted };
    }
    const docs = await AutopilotRunRequest.find(filter)
      .sort({ createdAt: -1 })
      .limit(clampLimit(req.query.limit))
      .lean();
    res.status(200).json({ success: true, count: docs.length, data: docs });
  } catch (error) {
    console.error("listAutopilotQueue failed:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /autopilot/queue/claim   (ops key)   body: { claimedBy?, limit? }
 *
 * The autopilot's poll. Claims oldest-first, one document at a time via
 * findOneAndUpdate so the read and the write are a single atomic operation -
 * two pollers can never claim the same request.
 */
export const claimAutopilotRequests = async (req, res) => {
  try {
    const claimedBy = String(req.body?.claimedBy || "").slice(0, 120);
    const want = Math.min(Math.max(Number.parseInt(req.body?.limit, 10) || 1, 1), 20);

    const claimed = [];
    for (let i = 0; i < want; i += 1) {
      const doc = await AutopilotRunRequest.findOneAndUpdate(
        { status: "queued" },
        { $set: { status: "claimed", claimedBy, claimedAt: new Date() } },
        { sort: { createdAt: 1 }, new: true }
      ).lean();
      if (!doc) break;
      claimed.push(doc);
    }

    res.status(200).json({ success: true, count: claimed.length, data: claimed });
  } catch (error) {
    console.error("claimAutopilotRequests failed:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /autopilot/queue/:id/finish   (ops key)
 * body: { status: "done"|"failed", outcome?, outcomeLabel?, message?, runId? }
 *
 * Closes a claimed request. Once it leaves queued/claimed the partial unique
 * index releases, so the client can be queued again.
 */
export const finishAutopilotRequest = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "bad id" });
    }
    const status = ["done", "failed", "cancelled"].includes(req.body?.status) ? req.body.status : "done";

    const set = {
      status,
      finishedAt: new Date(),
      outcome: String(req.body?.outcome || "").slice(0, 200),
      outcomeLabel: String(req.body?.outcomeLabel || "").slice(0, 120),
      message: String(req.body?.message || "").slice(0, 600)
    };
    if (req.body?.runId && mongoose.isValidObjectId(req.body.runId)) set.runId = req.body.runId;

    const doc = await AutopilotRunRequest.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
    if (!doc) return res.status(404).json({ success: false, message: "request not found" });

    res.status(200).json({ success: true, data: doc });
  } catch (error) {
    console.error("finishAutopilotRequest failed:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /autopilot/queue/:id/cancel
 *
 * Only a request nobody has picked up yet can be cancelled. Once the autopilot
 * has claimed it a browser is already open, and cancelling the row here would
 * not stop it - that is what the autopilot's own Stop button is for.
 */
export const cancelAutopilotRequest = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "bad id" });
    }
    const doc = await AutopilotRunRequest.findOneAndUpdate(
      { _id: id, status: "queued" },
      { $set: { status: "cancelled", finishedAt: new Date(), message: "Cancelled from the portal." } },
      { new: true }
    ).lean();
    if (!doc) {
      return res.status(409).json({
        success: false,
        message: "Only a request that has not started yet can be cancelled."
      });
    }
    res.status(200).json({ success: true, data: doc });
  } catch (error) {
    console.error("cancelAutopilotRequest failed:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
