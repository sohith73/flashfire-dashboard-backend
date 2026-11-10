import mongoose from "mongoose";
import { JobApiSettings } from "../Schema_Models/JobApiSettings.js";
import { ProfileModel } from "../Schema_Models/ProfileModel.js";
import { JobModel } from "../Schema_Models/JobModel.js";
import { UserModel } from "../Schema_Models/UserModel.js";
import { fetchPage, mapJob, adzunaCredentials, searchLadder } from "../Utils/adzunaClient.js";
import { judgeJobs } from "../Utils/apiJudge.js";
import { checkCap, checkPlanCap, enforcePlanCapPostInsert } from "../Utils/dailyCapGuard.js";
import { ukSponsorGate } from "../Utils/ukVisaSponsor.js";
import { usSponsorGate } from "../Utils/usVisaSponsor.js";
import { companyAllowlistGate } from "../Utils/companyAllowlist.js";
import { jobLinkKey } from "../Utils/jobLinkKey.js";
import { classifyApplyUrl } from "../Utils/applyUrlPolicy.js";
import { initialAutoOptimization } from "../Utils/autoOptimizationState.js";

// How many jobs this client may still receive: the smaller of today's daily
// allowance and the lifetime PLAN allowance (Prime 160, Ignite 250, ...).
// /addjob has always checked both; these routes checked only the daily cap,
// so a Europe/Indeed/HiringCafe run kept pushing after the plan was used up.
// Reported 2026-11-10 on Ashutosh Taparia (Prime): 157 applied + 3 JobRight
// pushes reached 160, then the Europe run added 15 more through /job-api/ingest
// -> 175/160. Throws on DB error so callers fail closed.
async function remainingAllowance(clientEmail) {
  const cap = await checkCap(clientEmail);
  const daily = Math.max(0, Number(cap?.remaining) || 0);
  const plan = await checkPlanCap(clientEmail);
  if (!plan.allowed) return { remaining: 0, planHit: true, plan };
  const planLeft = plan.cap == null ? Infinity : Math.max(0, Number(plan.remaining) || 0);
  return { remaining: Math.min(daily, planLeft), planHit: planLeft === 0, plan };
}


// "Scrape from Job APIs" - the server-side half of the autopilot's second mode.
//
// The portal mode drives a browser: the extension scrapes a site, judges in
// the browser, and pushes. This mode has no browser at all. The server calls
// the job API, judges with the same rules (Utils/apiJudge.js), and writes the
// picks through the same JobModel the extension's pushes land in - so a client
// cannot tell where a card came from, and one daily cap covers both.

const cleanEmail = (raw) => String(raw || "").toLowerCase().trim();

// Fields the operator may set. Anything else in the body is ignored rather
// than written, so a stale UI cannot inject new keys into the document.
const STRING_FIELDS = ["country", "what", "whatPhrase", "whatExclude", "titleOnly", "where", "category", "sortBy"];
const NUMBER_FIELDS = ["distance", "salaryMin", "salaryMax", "maxDaysOld", "resultsPerPage", "maxPages"];
const BOOL_FIELDS = ["fullTime", "partTime", "permanent", "contract", "enabled"];

function sanitizeSettings(body = {}) {
  const set = {};
  for (const k of STRING_FIELDS) {
    if (body[k] !== undefined) set[k] = String(body[k] ?? "").trim().slice(0, 200);
  }
  for (const k of NUMBER_FIELDS) {
    if (body[k] === undefined) continue;
    const raw = body[k];
    if (raw === "" || raw === null) { set[k] = null; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) continue;
    set[k] = Math.round(n);
  }
  for (const k of BOOL_FIELDS) {
    if (body[k] !== undefined) set[k] = body[k] === true || body[k] === "true" || body[k] === 1;
  }
  // Hard bounds the UI cannot talk us out of. Adzuna caps a page at 50, and
  // maxPages is what stops one client's run walking the whole board.
  if (set.resultsPerPage != null) set.resultsPerPage = Math.min(Math.max(set.resultsPerPage, 1), 50);
  if (set.maxPages != null) set.maxPages = Math.min(Math.max(set.maxPages, 1), 20);
  if (set.country) set.country = set.country.toLowerCase().slice(0, 4);
  return set;
}

/** GET /job-api/settings/:email  -> the saved search, or sensible defaults. */
export const getJobApiSettings = async (req, res) => {
  try {
    const clientEmail = cleanEmail(req.params.email);
    if (!clientEmail.includes("@")) return res.status(400).json({ success: false, message: "bad email" });
    const doc = await JobApiSettings.findOne({ clientEmail, provider: "adzuna" }).lean();
    const { appId, appKey } = adzunaCredentials();
    // A brand-new client gets the schema defaults rather than an empty form,
    // so the operator only fills in the role.
    const defaults = new JobApiSettings({ clientEmail, provider: "adzuna" }).toObject();
    delete defaults._id;
    return res.status(200).json({
      success: true,
      configured: !!doc,
      // The API account is FlashFire's, not the client's - the UI shows
      // whether it is set up so a run that cannot possibly work says so
      // before anyone presses the button.
      credentialsPresent: !!(appId && appKey),
      settings: { ...defaults, ...(doc || {}) },
    });
  } catch (error) {
    console.error("getJobApiSettings failed:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** PUT /job-api/settings/:email  -> save what the pencil dialog changed. */
export const putJobApiSettings = async (req, res) => {
  try {
    const clientEmail = cleanEmail(req.params.email);
    if (!clientEmail.includes("@")) return res.status(400).json({ success: false, message: "bad email" });
    const set = sanitizeSettings(req.body);
    if (!Object.keys(set).length) return res.status(400).json({ success: false, message: "nothing to save" });
    set.updatedBy = String(req.body?.updatedBy || "").slice(0, 200);
    const doc = await JobApiSettings.findOneAndUpdate(
      { clientEmail, provider: "adzuna" },
      { $set: set },
      { new: true, upsert: true, lean: true, setDefaultsOnInsert: true },
    );
    return res.status(200).json({ success: true, settings: doc });
  } catch (error) {
    console.error("putJobApiSettings failed:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── importing a batch of jobs onto a client's board ──────────────────
//
// Everything after "here are some jobs" is the same whichever API they came
// from, so it lives in one place: Adzuna runs fetch on the server and call
// this, Indeed runs fetch on the operator's machine and POST the jobs to
// /job-api/ingest, which calls this too. Two copies of the gates below would
// drift, and a gate that drifts is a client getting jobs they ruled out.
//
// Order is deliberate: every filter that needs no AI runs before the judge,
// so tokens are only spent on jobs that could actually be pushed.
//
// Returns { status, body }. `body` holds the outcome and the counts; the
// caller adds what only it knows (how many it fetched, which term it used).

const MAX_DESCRIPTION_CHARS = 4000;

export async function importJobs({
  clientEmail, profile, jobs, remaining, importSource,
  operatorName = "Job API", operatorEmail = "",
}) {
  const counts = { alreadyHad: 0, blockedByPolicy: 0, notOnList: 0, notSponsor: 0,
                   judged: 0, picked: 0, pushed: 0 };

  // ---- same link already on this client's board ------------------------
  // Compared on joblinkKey, the canonical form Utils/jobLinkKey.js produces,
  // exactly as AddJob does. Comparing raw joblink strings missed the same
  // posting behind a different tracking parameter, and since the key was
  // never written either, nothing else could see these jobs as duplicates.
  const keyed = jobs.map((j) => ({ job: j, key: jobLinkKey(j.applyUrl) }));
  const keys = [...new Set(keyed.map((k) => k.key).filter(Boolean))];
  const onBoard = new Set();
  if (keys.length) {
    const rows = await JobModel.find({ joblinkKey: { $in: keys } }).select("userID joblinkKey").lean();
    for (const row of rows) {
      // Case-insensitive, like inspectJobLink: legacy rows stored mixed case.
      if (String(row.userID || "").trim().toLowerCase() === clientEmail) onBoard.add(row.joblinkKey);
    }
  }
  const seenKeys = new Set();
  let fresh = [];
  for (const { job, key } of keyed) {
    // A blank key means the link has no identity (blank or a placeholder).
    // It cannot be compared, so it is neither treated as a duplicate nor
    // allowed to collide with another blank one.
    if (key && (onBoard.has(key) || seenKeys.has(key))) { counts.alreadyHad += 1; continue; }
    if (key) seenKeys.add(key);
    fresh.push({ job, key });
  }

  // ---- links the push policy refuses -----------------------------------
  // The same rule /addjob applies (Utils/applyUrlPolicy.js): job boards and
  // aggregators are refused in favour of the employer's own apply link, and
  // do-not-apply employers are skipped. Indeed returns its own viewjob page
  // for some postings; those would be refused at /addjob, so they are here.
  fresh = fresh.filter(({ job }) => {
    const ok = classifyApplyUrl(job.applyUrl).verdict === "allowed";
    if (!ok) counts.blockedByPolicy += 1;
    return ok;
  });
  if (!fresh.length && counts.blockedByPolicy) {
    return { status: 200, body: { success: true, outcome: "no-pushable-links", ...counts,
      message: `All ${counts.blockedByPolicy} new jobs link to a job board or a do-not-apply employer, not an employer's own apply page.` } };
  }

  // ---- only these companies ---------------------------------------------
  // Before judging too, for the same reason: one read of the client's
  // included companies, then in-memory matching (Utils/companyAllowlist.js).
  let allowGate;
  try {
    allowGate = await companyAllowlistGate({ email: clientEmail });
  } catch (e) {
    return { status: 503, body: { success: false, outcome: "allowlist-check-failed",
      error: "COMPANY_ALLOWLIST_CHECK_FAILED", message: e.message, ...counts } };
  }
  if (allowGate) {
    const kept = fresh.filter(({ job }) => !allowGate.check(job.company));
    counts.notOnList = fresh.length - kept.length;
    fresh = kept;
  }
  if (counts.notOnList && !fresh.length) {
    return { status: 200, body: { success: true, outcome: "no-allowed-companies", ...counts,
      message: `None of the ${counts.notOnList} new jobs are from this client's company list.` } };
  }

  // ---- UK visa sponsors only -------------------------------------------
  // Filtered BEFORE judging, so the judge never spends tokens on a job the
  // push would refuse anyway. Same rule /addjob applies (Utils/ukVisaSponsor.js).
  // A client is UK or US, never both, so at most one of these gates applies
  // and both report into counts.notSponsor. The US one checks in memory.
  let sponsorKind = "UK visa";
  try {
    let gate = await ukSponsorGate({ email: clientEmail, profile });
    if (!gate) {
      const us = await usSponsorGate({ email: clientEmail, profile });
      if (us) {
        sponsorKind = "US H-1B";
        gate = { check: async (company, description) => us.check(company, description) };
      }
    }
    if (gate) {
      const kept = [];
      // Ten at a time: a page of results can name 250 employers and each
      // uncached lookup is a query; this keeps the pool free for the app.
      for (let i = 0; i < fresh.length; i += 10) {
        const slice = fresh.slice(i, i + 10);
        const verdicts = await Promise.all(slice.map(({ job }) => gate.check(job.company, job.description)));
        slice.forEach((entry, k) => { if (!verdicts[k]) kept.push(entry); });
      }
      counts.notSponsor = fresh.length - kept.length;
      fresh = kept;
    }
  } catch (e) {
    // Fail closed, like the cap: pushing unchecked jobs for a sponsor-only
    // client is the one outcome this switch exists to prevent.
    return { status: 503, body: { success: false, outcome: "sponsor-check-failed",
      error: e.code || "SPONSOR_CHECK_FAILED", message: e.message, ...counts } };
  }
  if (counts.notSponsor && !fresh.length) {
    return { status: 200, body: { success: true, outcome: "no-sponsors", ...counts,
      message: `None of the ${counts.notSponsor} new jobs are from ${sponsorKind} sponsors.` } };
  }

  // ---- judge ------------------------------------------------------------
  const threshold = Number(profile.aiThreshold) || 50;
  const toJudge = fresh.map(({ job }) => job);
  counts.judged = toJudge.length;
  const judged = await judgeJobs({ profile, aiSummary: profile.aiSummary || "", jobs: toJudge, threshold });
  if (!judged.ok) {
    return { status: 502, body: { success: false, outcome: "judge-failed", error: judged.error,
      message: judged.message, ...counts, judged: 0 } };
  }
  const byId = new Map(judged.decisions.map((d) => [d.id, d]));
  const picks = fresh.filter(({ job }) => byId.get(job.jobId)?.pick === true).slice(0, remaining);
  counts.picked = picks.length;

  // Nothing good enough: say which job came closest and why, so the operator
  // sees the judge worked and what it thought, instead of a bare zero.
  let best = null;
  if (!picks.length) {
    for (const { job } of fresh) {
      const d = byId.get(job.jobId);
      if (d && Number.isFinite(d.score) && (!best || d.score > best.score)) {
        best = { title: job.title, company: job.company, score: d.score,
                 reason: String(d.reason || "").slice(0, 300), applyUrl: job.applyUrl };
      }
    }
  }

  // ---- push -------------------------------------------------------------
  // Straight onto JobModel, in the same shape AddJob writes, rather than
  // calling our own HTTP endpoint from inside ourselves.
  const opName = String(operatorName || "Job API").slice(0, 80);
  const opEmail = String(operatorEmail || "").toLowerCase().trim();
  const failures = [];
  const pushedJobs = [];
  for (const { job, key } of picks) {
    const d = byId.get(job.jobId) || {};
    const jobDescription = String(job.description || "").slice(0, MAX_DESCRIPTION_CHARS);
    try {
      const created = await JobModel.create({
        userID: clientEmail,
        jobTitle: job.title.slice(0, 50),
        companyName: job.company,
        jobLocation: job.location,
        jobDescription,
        // Without this the card defaults to status null and the resume
        // optimizer never picks it up.
        autoOptimization: initialAutoOptimization(jobDescription),
        joblink: job.applyUrl,
        joblinkKey: key,
        currentStatus: "saved",
        createdByRole: "operations",
        operatorName: opName,
        operatorEmail: opEmail,
        addedBy: opName,
        importSource,
        aiDecision: {
          reason: String(d.reason || "").slice(0, 600),
          score: Number.isInteger(d.score) ? d.score : null,
          matchedRole: String(d.matchedRole || "").slice(0, 120),
          model: process.env.OPENAI_JUDGE_MODEL || "gpt-4o-mini",
          judgedAt: new Date(),
        },
      });
      // Same race guard as /addjob: two runs for one client can both pass the
      // pre-check, so re-count after the insert and roll back our own job if
      // it took the client past their plan. Then stop - the plan is full.
      const enforce = await enforcePlanCapPostInsert(clientEmail, created._id);
      if (!enforce.kept) {
        failures.push(`plan limit reached (${enforce.count}/${enforce.cap}) - stopped`);
        break;
      }
      counts.pushed += 1;
      pushedJobs.push({ title: job.title, company: job.company, score: Number.isInteger(d.score) ? d.score : null });
    } catch (e) {
      failures.push(`${job.jobId}: ${e.message}`.slice(0, 160));
    }
  }

  return { status: 200, body: {
    success: true,
    outcome: counts.pushed >= remaining ? "cap-reached" : "done",
    ...counts,
    errors: failures.slice(0, 5),
    best,
    pushedJobs,
  } };
}

/**
 * POST /job-api/scrape/:email   (ops key)
 *
 * Fetch -> judge -> push, for one client. Returns a summary the autopilot
 * shows on the row, in the same shape its browser runs report.
 */
export const runJobApiScrape = async (req, res) => {
  const startedAt = new Date();
  try {
    const clientEmail = cleanEmail(req.params.email);
    if (!clientEmail.includes("@")) return res.status(400).json({ success: false, message: "bad email" });

    const settings = await JobApiSettings.findOne({ clientEmail, provider: "adzuna" }).lean();
    if (!settings) {
      return res.status(400).json({ success: false, error: "NOT_CONFIGURED",
        message: "No Adzuna search saved for this client. Open the pencil and set the role." });
    }
    if (!settings.what && !settings.titleOnly && !settings.whatPhrase) {
      return res.status(400).json({ success: false, error: "NO_SEARCH_TERMS",
        message: "This client's Adzuna search has no keywords. Open the pencil and set the role." });
    }

    // How many this client may still receive today. The same cap /addjob
    // enforces and manual operator pushes share, so an API run cannot spend
    // an allowance the operator already used by hand.
    let remaining = 0;
    let allowance;
    try {
      allowance = await remainingAllowance(clientEmail);
      remaining = allowance.remaining;
    } catch (e) {
      return res.status(503).json({ success: false, error: "CAP_UNAVAILABLE", message: e.message });
    }
    if (allowance.planHit) {
      return res.status(200).json({ success: true, outcome: "plan-limit", fetched: 0, judged: 0,
        picked: 0, pushed: 0, message: allowance.plan.message || "Plan limit reached. No more jobs can be added for this client." });
    }
    if (remaining <= 0) {
      return res.status(200).json({ success: true, outcome: "cap-hit", fetched: 0, judged: 0,
        picked: 0, pushed: 0, message: "Already at today's cap. The allowance resets at 22:00 IST." });
    }

    const profile = await ProfileModel.findOne({ email: clientEmail }).lean();
    if (!profile) return res.status(404).json({ success: false, message: `no profile for ${clientEmail}` });
    const user = await UserModel.findOne({ email: clientEmail }).select("name").lean();

    // ---- fetch ------------------------------------------------------
    const maxPages = Math.min(Math.max(Number(settings.maxPages) || 5, 1), 20);
    const seen = new Set();
    const jobs = [];
    let fetchError = null;
    let usedTerm = settings.what || "";

    // Adzuna's `what` needs EVERY word to match, so a role title copied out
    // of a brief returns nothing the moment it gets specific - measured over
    // 50 clients, 11 got zero results for that reason alone while a term one
    // word shorter returned hundreds. Try what the operator saved first, then
    // progressively broader forms, and stop at the first that finds anything.
    // A term that already works never reaches the second rung.
    const ladder = searchLadder(settings.what);
    for (const term of (ladder.length ? ladder : [settings.what])) {
      for (let page = 1; page <= maxPages; page += 1) {
        const r = await fetchPage({ ...settings, what: term }, page);
        if (!r.ok) { fetchError = r; break; }
        if (!r.results.length) break;            // ran out of results
        for (const raw of r.results) {
          const m = mapJob(raw);
          if (m && !seen.has(m.jobId)) { seen.add(m.jobId); jobs.push(m); }
        }
        // No point fetching jobs the cap can never accept. Judging rejects
        // most of what it sees, so fetch a generous multiple, not exactly
        // `remaining`.
        if (jobs.length >= remaining * 10) break;
      }
      if (jobs.length || fetchError) { usedTerm = term; break; }
    }
    if (!jobs.length) {
      return res.status(200).json({
        success: !fetchError,
        outcome: fetchError ? "api-error" : "no-results",
        error: fetchError?.error, message: fetchError?.message
          || "Adzuna returned nothing for this search in the last 24 hours.",
        fetched: 0, judged: 0, picked: 0, pushed: 0,
      });
    }

    const r = await importJobs({
      clientEmail, profile, jobs, remaining, importSource: "adzuna-api",
      operatorName: req.body?.operatorName, operatorEmail: req.body?.operatorEmail,
    });
    if (r.status === 200 && (r.body.outcome === "done" || r.body.outcome === "cap-reached")) {
      await JobApiSettings.updateOne({ clientEmail, provider: "adzuna" }, { $set: { lastRunAt: new Date() } });
    }
    return res.status(r.status).json({
      ...r.body,
      fetched: jobs.length,
      // Which term actually returned these. Differs from the saved one when
      // the ladder had to broaden it, and the operator should see that.
      searchTerm: usedTerm,
      broadened: usedTerm !== (settings.what || ""),
      remainingBefore: remaining,
      minutes: Math.round(((Date.now() - startedAt.getTime()) / 60000) * 10) / 10,
    });
  } catch (error) {
    console.error("runJobApiScrape failed:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── POST /job-api/ingest/:email   (ops key) ───────────────────────────
//
// Jobs fetched somewhere else, judged and pushed here. Indeed's app API is
// called from the operator's own machine rather than from this server: that
// is the network path that was tested (a residential connection), and it
// keeps a job board's rate limits on the operator's IP instead of on the
// dashboard's. Judging stays here so no OpenAI key ever sits on a laptop.
//
// Glassdoor is scraped the same way, in the operator's own logged-in Chrome:
// the app clicks "Apply on employer site" and sends the employer link it
// landed on.
//
// Only providers named below are accepted. Each one gets its own
// importSource, so a card always says which API it came from.

export const INGEST_PROVIDERS = Object.freeze({ indeed: "indeed-api", glassdoor: "glassdoor-scrape", hiringcafe: "hiringcafe-scrape" });

// A provider's own pages are never an apply link. indeed.com is already on
// the blocked-host list; glassdoor is not, so a Glassdoor link that never
// resolved to the employer is refused here rather than pushed.
const PROVIDER_OWN_HOST = Object.freeze({ hiringcafe: /(^|\.)(hiring\.cafe|hiringcafe\.com)$/i, glassdoor: /(^|\.)glassdoor\.[a-z.]+$/i });

function isProviderOwnLink(provider, applyUrl) {
  const re = PROVIDER_OWN_HOST[provider];
  if (!re) return false;
  try { return re.test(new URL(applyUrl).hostname); } catch { return true; }
}
export const MAX_INGEST_JOBS = 500;

const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** One job from the request, cleaned, or null when it cannot be pushed. */
export function sanitizeIngestJob(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = clip(raw.title, 200);
  if (!title) return null;
  let applyUrl = "";
  try {
    const u = new URL(String(raw.applyUrl || "").trim());
    // http(s) only. A javascript: or data: "link" on a client's board is the
    // kind of thing that should never get past a boundary.
    if (u.protocol === "http:" || u.protocol === "https:") applyUrl = u.toString();
  } catch { applyUrl = ""; }
  if (!applyUrl) return null;
  return {
    jobId: clip(raw.jobId, 120),
    title,
    company: clip(raw.company, 200),
    location: clip(raw.location, 200),
    description: String(raw.description ?? "").trim().slice(0, MAX_DESCRIPTION_CHARS),
    applyUrl,
    publishedAt: clip(raw.publishedAt, 40),
  };
}

export const ingestJobApiJobs = async (req, res) => {
  const startedAt = new Date();
  try {
    const clientEmail = cleanEmail(req.params.email);
    if (!clientEmail.includes("@")) return res.status(400).json({ success: false, message: "bad email" });

    const provider = String(req.body?.provider || "").toLowerCase().trim();
    const importSource = INGEST_PROVIDERS[provider];
    if (!importSource) {
      return res.status(400).json({ success: false, error: "UNKNOWN_PROVIDER",
        message: `provider must be one of: ${Object.keys(INGEST_PROVIDERS).join(", ")}` });
    }
    const rawJobs = req.body?.jobs;
    if (!Array.isArray(rawJobs)) {
      return res.status(400).json({ success: false, error: "BAD_JOBS", message: "jobs must be an array" });
    }
    if (rawJobs.length > MAX_INGEST_JOBS) {
      return res.status(413).json({ success: false, error: "TOO_MANY_JOBS",
        message: `at most ${MAX_INGEST_JOBS} jobs per request; got ${rawJobs.length}` });
    }

    // Clean every job, and give each a unique id: the judge reports its
    // verdicts by id, so two jobs sharing one would share one verdict.
    const jobs = [];
    const ids = new Set();
    let invalid = 0;
    rawJobs.forEach((raw, i) => {
      const job = sanitizeIngestJob(raw);
      if (!job || isProviderOwnLink(provider, job.applyUrl)) { invalid += 1; return; }
      let id = job.jobId || `${provider}-${i}`;
      if (ids.has(id)) id = `${id}#${i}`;
      ids.add(id);
      jobs.push({ ...job, jobId: id, source: provider });
    });

    const base = { provider, fetched: rawJobs.length, invalid,
                   searchTerm: clip(req.body?.searchTerm, 120) };
    const elapsed = () => Math.round(((Date.now() - startedAt.getTime()) / 60000) * 10) / 10;

    if (!jobs.length) {
      return res.status(200).json({ success: true, outcome: "no-results", ...base,
        alreadyHad: 0, blockedByPolicy: 0, notOnList: 0, notSponsor: 0,
        judged: 0, picked: 0, pushed: 0, remainingBefore: null, minutes: elapsed(),
        message: invalid ? `None of the ${invalid} jobs had a title and a usable apply link.` : "No jobs were sent." });
    }

    // The same daily cap /addjob enforces and manual pushes share.
    let remaining = 0;
    let allowance;
    try {
      allowance = await remainingAllowance(clientEmail);
      remaining = allowance.remaining;
    } catch (e) {
      return res.status(503).json({ success: false, error: "CAP_UNAVAILABLE", message: e.message, ...base });
    }
    if (allowance.planHit) {
      return res.status(200).json({ success: true, outcome: "plan-limit", ...base,
        alreadyHad: 0, blockedByPolicy: 0, notOnList: 0, notSponsor: 0,
        judged: 0, picked: 0, pushed: 0, remainingBefore: 0, minutes: elapsed(),
        message: allowance.plan.message || "Plan limit reached. No more jobs can be added for this client." });
    }
    if (remaining <= 0) {
      return res.status(200).json({ success: true, outcome: "cap-hit", ...base,
        alreadyHad: 0, blockedByPolicy: 0, notOnList: 0, notSponsor: 0,
        judged: 0, picked: 0, pushed: 0, remainingBefore: 0, minutes: elapsed(),
        message: "Already at today's cap. The allowance resets at 22:00 IST." });
    }

    const profile = await ProfileModel.findOne({ email: clientEmail }).lean();
    if (!profile) return res.status(404).json({ success: false, message: `no profile for ${clientEmail}`, ...base });

    const r = await importJobs({
      clientEmail, profile, jobs, remaining, importSource,
      operatorName: req.body?.operatorName, operatorEmail: req.body?.operatorEmail,
    });
    return res.status(r.status).json({ ...r.body, ...base, remainingBefore: remaining, minutes: elapsed() });
  } catch (error) {
    console.error("ingestJobApiJobs failed:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
