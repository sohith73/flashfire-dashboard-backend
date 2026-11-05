// Covers Controllers/JobApiScrape.js - the server-side half of the autopilot's
// "Scrape from Job APIs" mode.
//
// This mode has no browser and no extension, so nothing between Adzuna and a
// client's board is visible to an operator while it runs. The assertions that
// matter are therefore the ones about what reaches the board:
//
//   • the daily cap is the same allowance manual pushes spend, and a run must
//     never push past what is left of it
//   • a job already on the board is not judged again and not pushed again
//   • only what the judge picked is written, in the shape AddJob writes
//   • a failing judge writes NOTHING, rather than pushing unjudged jobs
//
// The models, the Adzuna client, the judge and the cap are all swapped with
// mock.module, so this exercises the shipping controller without a database,
// an API key or an OpenAI call.
//
// mock.module needs --experimental-test-module-mocks, which the repo's
// `npm test` script passes.

import test, { mock } from "node:test";
import assert from "node:assert/strict";

// ── the doubles ──────────────────────────────────────────────────────

let settingsDoc = null;
let settingsUpdate = null;
let savedSettings = null;

let capResult = { remaining: 30 };
let capThrows = null;

let profileDoc = null;
let existingLinks = [];
let existingOwner = "amelia@example.com";
let created = [];
let createThrowsFor = new Set();

let pages = [];          // one entry per page: {ok, results} or {ok:false,...}
let termPages = {};      // per-search-term pages, for the broadening ladder
let fetchCalls = [];
let judgeResult = null;
let judgeCalls = [];

mock.module("../../Schema_Models/JobApiSettings.js", {
  namedExports: {
    JobApiSettings: class {
      constructor(doc) { Object.assign(this, doc); }
      toObject() { return { ...this }; }
      static findOne() { return { lean: async () => settingsDoc }; }
      static findOneAndUpdate(_q, update) {
        savedSettings = update.$set;
        return { lean: async () => ({ ...settingsDoc, ...update.$set }) };
      }
      static updateOne(query, update) { settingsUpdate = { query, update }; return Promise.resolve({}); }
    },
  },
});

mock.module("../../Schema_Models/ProfileModel.js", {
  namedExports: {
    ProfileModel: { findOne: () => ({ lean: async () => profileDoc }) },
  },
});

// The client's "Included companies" (ClientOperations). [] = no rule.
let includedCompanies = [];
mock.module("../../Schema_Models/ClientOperationsModel.js", {
  namedExports: {
    ClientOperationsModel: { findOne: () => ({ select: () => ({ lean: async () => ({ includedCompanies }) }) }) },
  },
});

mock.module("../../Schema_Models/UserModel.js", {
  namedExports: {
    UserModel: { findOne: () => ({ select: () => ({ lean: async () => ({ name: "Amelia" }) }) }) },
  },
});

// The REAL schema, loaded under a different URL so the mock below does not
// replace it. The importer once wrote a `source` field the schema does not
// have: strict mode dropped it on every insert, and the old mock - which kept
// whatever it was handed - let a test assert that field was "saved". Checking
// every write against the real paths makes that class of bug fail here.
const { JobModel: RealJobModel } = await import("../../Schema_Models/JobModel.js?real-schema");
const SCHEMA_FIELDS = new Set(Object.keys(RealJobModel.schema.paths).map((p) => p.split(".")[0]));
const { jobLinkKey } = await import("../jobLinkKey.js");

mock.module("../../Schema_Models/JobModel.js", {
  namedExports: {
    JobModel: {
      // Existing rows are matched on the canonical key, like the real query.
      find: () => ({
        select: () => ({ lean: async () => existingLinks.map((l) => ({
          userID: existingOwner, joblinkKey: jobLinkKey(l), joblink: l })) }),
      }),
      create: async (doc) => {
        const unknown = Object.keys(doc).filter((k) => !SCHEMA_FIELDS.has(k));
        if (unknown.length) {
          throw new Error(`JobModel has no field(s) ${unknown.join(", ")} - strict mode would silently drop them`);
        }
        if (createThrowsFor.has(doc.joblink)) throw new Error("duplicate key");
        created.push(doc);
        return doc;
      },
    },
  },
});

mock.module("../../Utils/adzunaClient.js", {
  namedExports: {
    adzunaCredentials: () => ({ appId: "id", appKey: "key" }),
    // The real ladder, so these tests exercise the broadening the controller
    // actually does rather than a stand-in that cannot drift with it.
    searchLadder: (what) => {
      const w = String(what || "").trim();
      if (!w) return [];
      const parts = w.split(/\s+/);
      const out = [w];
      for (let n = parts.length - 1; n >= 1; n -= 1) {
        const t = parts.slice(-n).join(" ");
        if (!out.includes(t)) out.push(t);
      }
      return out;
    },
    fetchPage: async (settings, page) => {
      fetchCalls.push({ page, what: settings.what });
      const key = settings.what;
      const set = termPages[key];
      if (set) return set[page - 1] || { ok: true, results: [] };
      return pages[page - 1] || { ok: true, results: [] };
    },
    mapJob: (raw) => ({
      jobId: `adz-${raw.id}`,
      title: raw.title,
      company: raw.company,
      location: raw.location,
      description: raw.description || "",
      applyUrl: raw.redirect_url,
    }),
  },
});

mock.module("../../Utils/apiJudge.js", {
  namedExports: {
    judgeJobs: async (args) => { judgeCalls.push(args); return judgeResult; },
  },
});

mock.module("../../Utils/dailyCapGuard.js", {
  namedExports: {
    checkCap: async () => { if (capThrows) throw capThrows; return capResult; },
  },
});

// "UK visa sponsors only". null = gate off for this client (the default);
// otherwise the set of employers the register accepts.
let sponsorSet = null;
let sponsorThrows = null;
// "US H-1B sponsors only": off by default in these tests (no US client).
mock.module("../../Utils/usVisaSponsor.js", {
  namedExports: { usSponsorGate: async () => null },
});

mock.module("../../Utils/ukVisaSponsor.js", {
  namedExports: {
    ukSponsorGate: async () => {
      if (sponsorThrows) throw sponsorThrows;
      if (!sponsorSet) return null;
      return { check: async (company) => (sponsorSet.has(company) ? null : { error: "NOT_UK_VISA_SPONSOR" }) };
    },
  },
});

const { getJobApiSettings, putJobApiSettings, runJobApiScrape, ingestJobApiJobs,
        sanitizeIngestJob, MAX_INGEST_JOBS } =
  await import("../../Controllers/JobApiScrape.js");

// ── helpers ──────────────────────────────────────────────────────────

function res() {
  const r = { code: 0, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

const CLIENT = "amelia@example.com";

function adzJob(n, over = {}) {
  return {
    id: String(n),
    title: `Registered Nurse ${n}`,
    company: "Hospital",
    location: "Sydney",
    redirect_url: `https://adzuna.test/job/${n}`,
    ...over,
  };
}

/** Every pick, unless `picks` names the ids that should pass. */
function judgeAll(ids, picks = null) {
  return {
    ok: true,
    decisions: ids.map((id) => ({
      id: `adz-${id}`,
      pick: picks ? picks.includes(id) : true,
      score: 80,
      reason: "matches the role",
      matchedRole: "Registered Nurse",
    })),
  };
}

function reset() {
  settingsDoc = { clientEmail: CLIENT, provider: "adzuna", what: "registered nurse", maxPages: 5 };
  settingsUpdate = null; savedSettings = null;
  capResult = { remaining: 30 }; capThrows = null;
  profileDoc = { email: CLIENT, aiThreshold: 50, aiSummary: "RN, 5 years" };
  existingLinks = []; existingOwner = CLIENT; created = []; createThrowsFor = new Set();
  pages = []; termPages = {}; fetchCalls = []; judgeResult = null; judgeCalls = [];
  sponsorSet = null; sponsorThrows = null;
  includedCompanies = [];
}

async function run(body = {}) {
  const r = res();
  await runJobApiScrape({ params: { email: CLIENT }, body }, r);
  return r;
}

// ── saving the search (the pencil) ───────────────────────────────────

test("numbers arriving from the form as strings are stored as numbers", async () => {
  reset();
  const r = res();
  await putJobApiSettings(
    { params: { email: CLIENT }, body: { what: "nurse", maxDaysOld: "2", resultsPerPage: "50", maxPages: "5" } },
    r,
  );
  assert.equal(r.code, 200);
  assert.equal(savedSettings.maxDaysOld, 2);
  assert.equal(savedSettings.resultsPerPage, 50);
  assert.equal(savedSettings.maxPages, 5);
});

test("a cleared number field is stored as null, not as NaN or an empty string", async () => {
  reset();
  await putJobApiSettings({ params: { email: CLIENT }, body: { what: "nurse", distance: "", salaryMin: "" } }, res());
  assert.equal(savedSettings.distance, null);
  assert.equal(savedSettings.salaryMin, null);
});

test("results per page is clamped to Adzuna's maximum of 50", async () => {
  reset();
  await putJobApiSettings({ params: { email: CLIENT }, body: { what: "nurse", resultsPerPage: 500 } }, res());
  assert.equal(savedSettings.resultsPerPage, 50);
});

test("max pages is capped, so one client cannot walk the whole board", async () => {
  reset();
  await putJobApiSettings({ params: { email: CLIENT }, body: { what: "nurse", maxPages: 9999 } }, res());
  assert.equal(savedSettings.maxPages, 20);
});

test("a key the UI never sends is ignored rather than written", async () => {
  reset();
  await putJobApiSettings(
    { params: { email: CLIENT }, body: { what: "nurse", isAdmin: true, __proto__x: 1 } },
    res(),
  );
  assert.equal("isAdmin" in savedSettings, false);
  assert.equal("__proto__x" in savedSettings, false);
});

test("a body with nothing settable in it is refused", async () => {
  reset();
  const r = res();
  await putJobApiSettings({ params: { email: CLIENT }, body: { nonsense: 1 } }, r);
  assert.equal(r.code, 400);
});

test("a bad email is refused before any lookup", async () => {
  reset();
  const r = res();
  await putJobApiSettings({ params: { email: "not-an-email" }, body: { what: "nurse" } }, r);
  assert.equal(r.code, 400);
  assert.equal(savedSettings, null);
});

test("reading a client with nothing saved still returns a usable form", async () => {
  reset();
  settingsDoc = null;
  const r = res();
  await getJobApiSettings({ params: { email: CLIENT } }, r);
  assert.equal(r.code, 200);
  assert.equal(r.body.configured, false);
  assert.equal(r.body.credentialsPresent, true);
  assert.ok(r.body.settings, "the form needs defaults to render");
});

// ── the run: refusing to start ───────────────────────────────────────

test("a client with no saved search is told to open the pencil", async () => {
  reset();
  settingsDoc = null;
  const r = await run();
  assert.equal(r.code, 400);
  assert.equal(r.body.error, "NOT_CONFIGURED");
  assert.equal(created.length, 0);
});

test("a saved search with no keywords is refused rather than fetching everything", async () => {
  reset();
  settingsDoc = { clientEmail: CLIENT, provider: "adzuna", what: "", where: "Sydney" };
  const r = await run();
  assert.equal(r.code, 400);
  assert.equal(r.body.error, "NO_SEARCH_TERMS");
  assert.equal(fetchCalls.length, 0, "nothing should be fetched for an empty search");
});

test("a client already at today's cap fetches nothing at all", async () => {
  reset();
  capResult = { remaining: 0 };
  const r = await run();
  assert.equal(r.code, 200);
  assert.equal(r.body.outcome, "cap-hit");
  assert.equal(fetchCalls.length, 0);
  assert.equal(created.length, 0);
});

test("a cap we cannot read stops the run instead of guessing", async () => {
  reset();
  capThrows = new Error("cap service down");
  const r = await run();
  assert.equal(r.code, 503);
  assert.equal(r.body.error, "CAP_UNAVAILABLE");
  assert.equal(created.length, 0);
});

// ── the run: fetching ────────────────────────────────────────────────

test("paging stops as soon as a page comes back empty", async () => {
  reset();
  pages = [{ ok: true, results: [adzJob(1)] }, { ok: true, results: [] }];
  judgeResult = judgeAll([1]);
  await run();
  assert.deepEqual(fetchCalls.map((c) => c.page), [1, 2], "it must not keep asking for pages 3, 4, 5");
});

test("the same job on two pages is fetched once", async () => {
  reset();
  pages = [{ ok: true, results: [adzJob(1), adzJob(2)] }, { ok: true, results: [adzJob(2), adzJob(3)] },
           { ok: true, results: [] }];
  judgeResult = judgeAll([1, 2, 3], []);
  const r = await run();
  assert.equal(r.body.fetched, 3);
});

test("an Adzuna failure is reported as an api-error, not as an empty search", async () => {
  reset();
  pages = [{ ok: false, error: "ADZUNA_503", message: "service unavailable" }];
  const r = await run();
  assert.equal(r.code, 200);
  assert.equal(r.body.success, false);
  assert.equal(r.body.outcome, "api-error");
  assert.equal(r.body.error, "ADZUNA_503");
  assert.equal(created.length, 0);
});

test("a search that genuinely found nothing says so without claiming an error", async () => {
  reset();
  pages = [{ ok: true, results: [] }];
  const r = await run();
  assert.equal(r.body.success, true);
  assert.equal(r.body.outcome, "no-results");
});

// ── the run: judging and pushing ─────────────────────────────────────

test("a job already on the board is neither judged nor pushed again", async () => {
  reset();
  pages = [{ ok: true, results: [adzJob(1), adzJob(2)] }, { ok: true, results: [] }];
  existingLinks = ["https://adzuna.test/job/1"];
  judgeResult = judgeAll([2]);
  const r = await run();
  assert.equal(r.body.fetched, 2);
  assert.equal(r.body.alreadyHad, 1);
  assert.equal(r.body.judged, 1);
  assert.deepEqual(judgeCalls[0].jobs.map((j) => j.jobId), ["adz-2"]);
  assert.deepEqual(created.map((d) => d.joblink), ["https://adzuna.test/job/2"]);
  assert.equal(r.body.pushedJobs.length, 1);
});

test("only what the judge picked is written", async () => {
  reset();
  pages = [{ ok: true, results: [adzJob(1), adzJob(2), adzJob(3)] }, { ok: true, results: [] }];
  judgeResult = judgeAll([1, 2, 3], [2]);
  const r = await run();
  assert.equal(r.body.picked, 1);
  assert.equal(r.body.pushed, 1);
  assert.deepEqual(created.map((d) => d.joblink), ["https://adzuna.test/job/2"]);
  assert.equal(r.body.pushedJobs.length, 1);
});

test("a pushed job is queued for resume optimization, or skipped when it has no description", async () => {
  // Job API pushes used to leave autoOptimization.status null, and the
  // optimizer only claims "pending" cards, so none of them got a resume.
  reset();
  pages = [{ ok: true, results: [adzJob(1, { description: "Care for patients." }), adzJob(2)] }, { ok: true, results: [] }];
  judgeResult = judgeAll([1, 2], [1, 2]);
  await run();
  const byLink = Object.fromEntries(created.map((d) => [d.joblink, d.autoOptimization]));
  assert.deepEqual(byLink["https://adzuna.test/job/1"], { status: "pending", attempts: 0 });
  assert.equal(byLink["https://adzuna.test/job/2"].status, "skipped");
});

test("when nothing is good enough the closest job is reported, not pushed", async () => {
  reset();
  pages = [{ ok: true, results: [adzJob(1), adzJob(2)] }, { ok: true, results: [] }];
  judgeResult = judgeAll([1, 2], []);
  judgeResult.decisions[1].score = 45;
  judgeResult.decisions[0].score = 20;
  const r = await run();
  assert.equal(r.body.pushed, 0);
  assert.equal(created.length, 0);
  assert.equal(r.body.best.score, 45);
  assert.equal(r.body.best.applyUrl, "https://adzuna.test/job/2");
});

test("a run that picked something reports no closest-miss", async () => {
  reset();
  pages = [{ ok: true, results: [adzJob(1)] }, { ok: true, results: [] }];
  judgeResult = judgeAll([1], [1]);
  const r = await run();
  assert.equal(r.body.best, null);
});

test("a failing judge pushes nothing at all", async () => {
  reset();
  pages = [{ ok: true, results: [adzJob(1), adzJob(2)] }, { ok: true, results: [] }];
  judgeResult = { ok: false, error: "OPENAI_401", message: "key revoked" };
  const r = await run();
  assert.equal(r.code, 502);
  assert.equal(r.body.outcome, "judge-failed");
  assert.equal(created.length, 0, "unjudged jobs must never reach a client's board");
});

test("a run never pushes more than the cap has left", async () => {
  reset();
  capResult = { remaining: 2 };
  pages = [{ ok: true, results: [adzJob(1), adzJob(2), adzJob(3), adzJob(4)] }, { ok: true, results: [] }];
  judgeResult = judgeAll([1, 2, 3, 4]);
  const r = await run();
  assert.equal(created.length, 2);
  assert.equal(r.body.pushed, 2);
  assert.equal(r.body.outcome, "cap-reached");
  assert.equal(r.body.remainingBefore, 2);
});

test("the judge is asked with the client's own threshold and summary", async () => {
  reset();
  profileDoc = { email: CLIENT, aiThreshold: 72, aiSummary: "ICU nurse, Sydney" };
  pages = [{ ok: true, results: [adzJob(1)] }, { ok: true, results: [] }];
  judgeResult = judgeAll([1], []);
  await run();
  assert.equal(judgeCalls[0].threshold, 72);
  assert.equal(judgeCalls[0].aiSummary, "ICU nurse, Sydney");
});

test("a profile with no threshold falls back to 50 rather than to zero", async () => {
  reset();
  profileDoc = { email: CLIENT };
  pages = [{ ok: true, results: [adzJob(1)] }, { ok: true, results: [] }];
  judgeResult = judgeAll([1], []);
  await run();
  assert.equal(judgeCalls[0].threshold, 50, "a 0 threshold would pass every job through");
});

test("a pushed card carries the judge's reasoning and says where it came from", async () => {
  reset();
  pages = [{ ok: true, results: [adzJob(1)] }, { ok: true, results: [] }];
  judgeResult = judgeAll([1]);
  await run({ operatorName: "Sarah", operatorEmail: "Sarah@Flashfire.com" });
  const doc = created[0];
  assert.equal(doc.userID, CLIENT);
  assert.equal(doc.importSource, "adzuna-api");
  assert.equal(doc.currentStatus, "saved");
  assert.equal(doc.createdByRole, "operations");
  assert.equal(doc.operatorName, "Sarah");
  assert.equal(doc.operatorEmail, "sarah@flashfire.com", "the email is stored lowercased");
  assert.equal(doc.aiDecision.score, 80);
  assert.equal(doc.aiDecision.reason, "matches the role");
  assert.ok(doc.aiDecision.judgedAt instanceof Date);
});

test("one job failing to write does not abandon the rest of the run", async () => {
  reset();
  pages = [{ ok: true, results: [adzJob(1), adzJob(2)] }, { ok: true, results: [] }];
  createThrowsFor = new Set(["https://adzuna.test/job/1"]);
  judgeResult = judgeAll([1, 2]);
  const r = await run();
  assert.equal(r.body.pushed, 1);
  assert.equal(r.body.picked, 2);
  assert.equal(r.body.errors.length, 1);
  assert.match(r.body.errors[0], /adz-1/);
});

test("a finished run records when it last ran", async () => {
  reset();
  pages = [{ ok: true, results: [adzJob(1)] }, { ok: true, results: [] }];
  judgeResult = judgeAll([1]);
  await run();
  assert.ok(settingsUpdate, "lastRunAt is what stops the UI showing a stale 'never run'");
  assert.ok(settingsUpdate.update.$set.lastRunAt instanceof Date);
});

test("a job title longer than the board's column is truncated, not rejected", async () => {
  reset();
  const longTitle = "Registered Nurse ".repeat(10);
  pages = [{ ok: true, results: [adzJob(1, { title: longTitle })] }, { ok: true, results: [] }];
  judgeResult = judgeAll([1]);
  const r = await run();
  assert.equal(r.body.pushed, 1);
  assert.equal(created[0].jobTitle.length, 50);
});

// ── who is allowed to touch a saved search ───────────────────────────
//
// These shipped ungated. A saved search names the role, the location and the
// salary floor we look for on a client's behalf, so an open GET leaks it and
// an open PUT lets anyone who can guess an address redirect that client's
// next run onto jobs they never asked for. The run itself was always gated;
// the two routes that decide what it runs must be too.

import { readFileSync } from "node:fs";

const ROUTES_SRC = readFileSync(new URL("../../Routes.js", import.meta.url), "utf8");

function routeLine(method, path) {
  const re = new RegExp(`app\\.${method}\\("${path.replace(/[/:]/g, (c) => "\\" + c)}".*`);
  const m = ROUTES_SRC.match(re);
  assert.ok(m, `no ${method.toUpperCase()} route registered for ${path}`);
  return m[0];
}

test("reading a client's saved search needs the ops key", () => {
  assert.match(routeLine("get", "/job-api/settings/:email"), /requireOpsKey/);
});

test("overwriting a client's saved search needs the ops key", () => {
  assert.match(routeLine("put", "/job-api/settings/:email"), /requireOpsKey/);
});

test("starting a run needs the ops key", () => {
  assert.match(routeLine("post", "/job-api/scrape/:email"), /requireOpsKey/);
});

// ── broadening a search that finds nothing ───────────────────────────
//
// Adzuna's `what` needs every word to match. Measured over 50 clients on
// 2026-09-30: 11 got zero results because their saved role title was three or
// four words long, while a shorter form of the same role returned hundreds.
// The run now walks a ladder of progressively broader terms and stops at the
// first that finds anything.

test("a saved term that works is used verbatim and nothing is broadened", async () => {
  reset();
  termPages["senior data engineer"] = [{ ok: true, results: [adzJob(1)] }, { ok: true, results: [] }];
  settingsDoc = { ...settingsDoc, what: "senior data engineer" };
  judgeResult = judgeAll([1], []);
  const r = await run();
  assert.deepEqual([...new Set(fetchCalls.map((c) => c.what))], ["senior data engineer"]);
  assert.equal(r.body.broadened, false);
  assert.equal(r.body.searchTerm, "senior data engineer");
});

test("a term that finds nothing is retried broader until something lands", async () => {
  reset();
  // Only the two-word form has anything, exactly like the real failures.
  termPages["supply chain planning analyst"] = [{ ok: true, results: [] }];
  termPages["chain planning analyst"] = [{ ok: true, results: [] }];
  termPages["planning analyst"] = [{ ok: true, results: [adzJob(7)] }, { ok: true, results: [] }];
  settingsDoc = { ...settingsDoc, what: "supply chain planning analyst" };
  judgeResult = judgeAll([7]);
  const r = await run();
  assert.equal(r.body.fetched, 1, "the broader term's results must be kept");
  assert.equal(r.body.searchTerm, "planning analyst");
  assert.equal(r.body.broadened, true, "the operator should see it was widened");
});

test("broadening stops at the first term that returns results", async () => {
  reset();
  termPages["clinical data analyst"] = [{ ok: true, results: [] }];
  termPages["data analyst"] = [{ ok: true, results: [adzJob(1)] }, { ok: true, results: [] }];
  termPages["analyst"] = [{ ok: true, results: [adzJob(2), adzJob(3)] }];
  settingsDoc = { ...settingsDoc, what: "clinical data analyst" };
  judgeResult = judgeAll([1, 2, 3]);
  const r = await run();
  assert.equal(r.body.searchTerm, "data analyst");
  assert.equal(r.body.fetched, 1, "it must not keep widening past a term that worked");
  assert.equal(fetchCalls.some((c) => c.what === "analyst"), false);
});

test("an API failure stops the run instead of being read as an empty search", async () => {
  reset();
  termPages["data engineer"] = [{ ok: false, error: "ADZUNA_503", message: "unavailable" }];
  settingsDoc = { ...settingsDoc, what: "data engineer" };
  const r = await run();
  assert.equal(r.body.outcome, "api-error");
  assert.equal(fetchCalls.some((c) => c.what === "engineer"), false,
    "a 503 is not evidence the term was too narrow");
});

test("a genuinely empty search still reports no-results after widening", async () => {
  reset();
  settingsDoc = { ...settingsDoc, what: "underwater basket weaver" };
  const r = await run();
  assert.equal(r.body.outcome, "no-results");
  assert.ok(fetchCalls.length >= 2, "it should have tried broader forms before giving up");
});

// ── UK visa sponsors only ────────────────────────────────────────────

test("sponsor-only client: non-sponsors are dropped before the judge sees them", async () => {
  reset();
  sponsorSet = new Set(["Barclays"]);
  pages = [{ ok: true, results: [
    adzJob(1, { company: "Barclays" }),
    adzJob(2, { company: "Tiny Agency" }),
    adzJob(3, { company: "Barclays" }),
  ] }];
  judgeResult = judgeAll(["1", "3"]);
  const r = await run();
  assert.equal(r.code, 200);
  assert.deepEqual(judgeCalls[0].jobs.map((j) => j.jobId), ["adz-1", "adz-3"]);
  assert.equal(r.body.notSponsor, 1);
  assert.equal(r.body.pushed, 2);
  assert.ok(created.every((d) => d.companyName === "Barclays"));
});

test("sponsor-only client with no sponsors in the batch: nothing judged, nothing pushed", async () => {
  reset();
  sponsorSet = new Set();
  pages = [{ ok: true, results: [adzJob(1, { company: "Tiny Agency" })] }];
  const r = await run();
  assert.equal(r.code, 200);
  assert.equal(r.body.outcome, "no-sponsors");
  assert.equal(judgeCalls.length, 0);
  assert.equal(created.length, 0);
});

// ── only these companies ─────────────────────────────────────────────

test("company list: off-list employers are dropped before the judge sees them", async () => {
  reset();
  includedCompanies = ["Google", "Meta"];
  pages = [{ ok: true, results: [
    adzJob(1, { company: "Google LLC" }),
    adzJob(2, { company: "Infosys" }),
    adzJob(3, { company: "Meta Platforms, Inc." }),
  ] }];
  judgeResult = judgeAll(["1", "3"]);
  const r = await run();
  assert.equal(r.code, 200);
  assert.deepEqual(judgeCalls[0].jobs.map((j) => j.jobId), ["adz-1", "adz-3"]);
  assert.equal(r.body.notOnList, 1);
  assert.equal(r.body.pushed, 2);
});

test("company list with nothing on it in the batch: nothing judged, nothing pushed", async () => {
  reset();
  includedCompanies = ["Google"];
  pages = [{ ok: true, results: [adzJob(1, { company: "Infosys" })] }];
  const r = await run();
  assert.equal(r.code, 200);
  assert.equal(r.body.outcome, "no-allowed-companies");
  assert.equal(judgeCalls.length, 0);
  assert.equal(created.length, 0);
});

test("sponsor check failing refuses the run rather than pushing unchecked jobs", async () => {
  reset();
  sponsorThrows = Object.assign(new Error("register empty"), { code: "SPONSOR_REGISTER_EMPTY" });
  pages = [{ ok: true, results: [adzJob(1)] }];
  const r = await run();
  assert.equal(r.code, 503);
  assert.equal(r.body.error, "SPONSOR_REGISTER_EMPTY");
  assert.equal(judgeCalls.length, 0);
  assert.equal(created.length, 0);
});


// ── what importJobs does for every provider ──────────────────────────
//
// Adzuna runs and Indeed ingests share one import path. These cover the
// three things it gained when it was pulled out of the Adzuna handler:
// the /addjob link policy, canonical duplicate detection, and a card that
// records which API it came from in a field the schema actually has.

test("a job-board link is refused the same way /addjob refuses it", async () => {
  reset();
  pages = [{ ok: true, results: [
    adzJob(1, { redirect_url: "https://www.indeed.com/viewjob?jk=abc" }),
    adzJob(2, { redirect_url: "https://boards.greenhouse.io/acme/jobs/2" }),
  ] }, { ok: true, results: [] }];
  judgeResult = judgeAll([2]);
  const r = await run();
  assert.equal(r.body.blockedByPolicy, 1);
  assert.deepEqual(created.map((d) => d.joblink), ["https://boards.greenhouse.io/acme/jobs/2"]);
  assert.deepEqual(judgeCalls[0].jobs.map((j) => j.jobId), ["adz-2"],
    "a link the push would refuse must not cost judge tokens");
});

test("when every link is refused the run says why instead of 'no results'", async () => {
  reset();
  pages = [{ ok: true, results: [adzJob(1, { redirect_url: "https://www.linkedin.com/jobs/view/1" })] },
           { ok: true, results: [] }];
  const r = await run();
  assert.equal(r.body.outcome, "no-pushable-links");
  assert.equal(judgeCalls.length, 0);
});

test("the same posting behind a tracking parameter is one job, not two", async () => {
  reset();
  pages = [{ ok: true, results: [
    adzJob(1, { redirect_url: "https://acme.com/jobs/7" }),
    adzJob(2, { redirect_url: "https://acme.com/jobs/7?utm_source=adzuna" }),
  ] }, { ok: true, results: [] }];
  judgeResult = judgeAll([1, 2]);
  const r = await run();
  assert.equal(r.body.alreadyHad, 1);
  assert.equal(created.length, 1);
});

test("an existing row is matched on the canonical key, not the raw string", async () => {
  reset();
  existingLinks = ["https://acme.com/jobs/7"];
  pages = [{ ok: true, results: [adzJob(1, { redirect_url: "https://www.acme.com/jobs/7/?utm_campaign=x" })] },
           { ok: true, results: [] }];
  judgeResult = judgeAll([1]);
  const r = await run();
  assert.equal(r.body.alreadyHad, 1, "a raw-string compare would have pushed this again");
  assert.equal(created.length, 0);
});

test("another client's copy of the link does not block this client", async () => {
  reset();
  existingLinks = ["https://acme.com/jobs/7"];
  existingOwner = "someone.else@example.com";
  pages = [{ ok: true, results: [adzJob(1, { redirect_url: "https://acme.com/jobs/7" })] },
           { ok: true, results: [] }];
  judgeResult = judgeAll([1]);
  const r = await run();
  assert.equal(r.body.alreadyHad, 0);
  assert.equal(created.length, 1);
});

test("a pushed job carries its canonical key so later pushes can see it", async () => {
  reset();
  pages = [{ ok: true, results: [adzJob(1, { redirect_url: "https://acme.com/jobs/7?utm_source=x" })] },
           { ok: true, results: [] }];
  judgeResult = judgeAll([1]);
  await run();
  assert.ok(created[0].joblinkKey, "without the key, AddJob's duplicate check cannot see this job");
  assert.equal(created[0].joblinkKey, jobLinkKey("https://acme.com/jobs/7"));
});

// ── POST /job-api/ingest/:email ──────────────────────────────────────

function indeedJob(n, over = {}) {
  return {
    jobId: `ind-${n}`,
    title: `Software Engineer ${n}`,
    company: "Acme",
    location: "New York, NY",
    description: "Build things.",
    applyUrl: `https://boards.greenhouse.io/acme/jobs/${n}`,
    publishedAt: "2026-10-16T08:00:00Z",
    ...over,
  };
}

function judgeIds(ids, picks = null) {
  return { ok: true, decisions: ids.map((id) => ({
    id, pick: picks ? picks.includes(id) : true, score: 77,
    reason: "title matches", matchedRole: "Software Engineer" })) };
}

async function ingest(body) {
  const r = res();
  await ingestJobApiJobs({ params: { email: CLIENT }, body }, r);
  return r;
}

test("ingest pushes judged picks and marks them as Indeed imports", async () => {
  reset();
  judgeResult = judgeIds(["ind-1", "ind-2"], ["ind-2"]);
  const r = await ingest({ provider: "indeed", jobs: [indeedJob(1), indeedJob(2)], operatorName: "Sarah" });
  assert.equal(r.code, 200);
  assert.equal(r.body.pushed, 1);
  assert.equal(created[0].importSource, "indeed-api");
  assert.equal(created[0].joblink, "https://boards.greenhouse.io/acme/jobs/2");
  assert.equal(created[0].operatorName, "Sarah");
  assert.equal(r.body.provider, "indeed");
  assert.equal(r.body.fetched, 2);
});

test("ingest takes Glassdoor jobs and marks them as Glassdoor scrapes", async () => {
  reset();
  judgeResult = judgeIds(["gd-1"]);
  const r = await ingest({ provider: "glassdoor", jobs: [indeedJob(1, { jobId: "gd-1" })] });
  assert.equal(r.code, 200);
  assert.equal(r.body.pushed, 1);
  assert.equal(r.body.provider, "glassdoor");
  assert.equal(created[0].importSource, "glassdoor-scrape");
});

test("ingest refuses a Glassdoor link that never reached the employer", async () => {
  reset();
  judgeResult = judgeIds(["gd-2"]);
  const r = await ingest({ provider: "glassdoor", jobs: [
    indeedJob(1, { jobId: "gd-1", applyUrl: "https://www.glassdoor.co.uk/partner/jobListing.htm?jl=1" }),
    indeedJob(2, { jobId: "gd-2" }),
  ] });
  assert.equal(r.code, 200);
  assert.equal(r.body.invalid, 1);
  assert.equal(r.body.pushed, 1);
  assert.deepEqual(created.map((j) => j.joblink), ["https://boards.greenhouse.io/acme/jobs/2"]);
  assert.deepEqual(judgeCalls.flatMap((c) => c.jobs.map((j) => j.jobId)), ["gd-2"],
    "a Glassdoor page must not even reach the judge");
});

test("ingest accepts HiringCafe employer jobs and refuses both board domains", async () => {
  reset();
  judgeResult = judgeIds(["hc-3"]);
  const r = await ingest({ provider: "hiringcafe", jobs: [
    indeedJob(1, { jobId: "hc-1", applyUrl: "https://hiring.cafe/job/1" }),
    indeedJob(2, { jobId: "hc-2", applyUrl: "https://www.hiringcafe.com/job/2" }),
    indeedJob(3, { jobId: "hc-3" }),
  ] });
  assert.equal(r.code, 200);
  assert.equal(r.body.invalid, 2);
  assert.equal(r.body.pushed, 1);
  assert.equal(created[0].importSource, "hiringcafe-scrape");
  assert.deepEqual(judgeCalls.flatMap((c) => c.jobs.map((j) => j.jobId)), ["hc-3"]);
});

test("ingest refuses a provider it does not know", async () => {
  reset();
  const r = await ingest({ provider: "monster", jobs: [indeedJob(1)] });
  assert.equal(r.code, 400);
  assert.equal(r.body.error, "UNKNOWN_PROVIDER");
  assert.equal(created.length, 0);
});

test("ingest refuses a body whose jobs are not a list", async () => {
  reset();
  const r = await ingest({ provider: "indeed", jobs: "lots" });
  assert.equal(r.code, 400);
});

test("ingest refuses an oversized batch outright", async () => {
  reset();
  const jobs = Array.from({ length: MAX_INGEST_JOBS + 1 }, (_, i) => indeedJob(i));
  const r = await ingest({ provider: "indeed", jobs });
  assert.equal(r.code, 413);
  assert.equal(judgeCalls.length, 0, "an oversized batch must not reach the judge");
});

test("ingest drops jobs with no title or no usable link, and counts them", async () => {
  reset();
  judgeResult = judgeIds(["ind-3"]);
  const r = await ingest({ provider: "indeed", jobs: [
    indeedJob(1, { title: "" }),
    indeedJob(2, { applyUrl: "javascript:alert(1)" }),
    indeedJob(3),
  ] });
  assert.equal(r.body.invalid, 2);
  assert.equal(r.body.pushed, 1);
});

test("a javascript: or data: link can never reach a client's board", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,hi", "ftp://x/y", "not a url", ""]) {
    assert.equal(sanitizeIngestJob(indeedJob(1, { applyUrl: bad })), null, bad);
  }
});

test("two jobs sending the same id still get separate verdicts", async () => {
  reset();
  judgeResult = { ok: true, decisions: [] };
  await ingest({ provider: "indeed", jobs: [
    indeedJob(1, { jobId: "dup", applyUrl: "https://acme.com/a" }),
    indeedJob(2, { jobId: "dup", applyUrl: "https://acme.com/b" }),
  ] });
  const ids = judgeCalls[0].jobs.map((j) => j.jobId);
  assert.equal(new Set(ids).size, 2, "the judge reports by id, so ids must be unique");
});

test("Indeed's own viewjob links are refused by the shared policy", async () => {
  reset();
  judgeResult = judgeIds(["ind-2"]);
  const r = await ingest({ provider: "indeed", jobs: [
    indeedJob(1, { applyUrl: "https://www.indeed.com/viewjob?jk=1" }),
    indeedJob(2),
  ] });
  assert.equal(r.body.blockedByPolicy, 1);
  assert.equal(created.length, 1);
});

test("ingest respects the same daily cap as everything else", async () => {
  reset();
  capResult = { remaining: 1 };
  judgeResult = judgeIds(["ind-1", "ind-2", "ind-3"]);
  const r = await ingest({ provider: "indeed", jobs: [indeedJob(1), indeedJob(2), indeedJob(3)] });
  assert.equal(created.length, 1);
  assert.equal(r.body.outcome, "cap-reached");
});

test("ingest at a full cap judges nothing", async () => {
  reset();
  capResult = { remaining: 0 };
  const r = await ingest({ provider: "indeed", jobs: [indeedJob(1)] });
  assert.equal(r.body.outcome, "cap-hit");
  assert.equal(judgeCalls.length, 0);
});

test("a failing judge on an ingest pushes nothing", async () => {
  reset();
  judgeResult = { ok: false, error: "OPENAI_401", message: "bad key" };
  const r = await ingest({ provider: "indeed", jobs: [indeedJob(1)] });
  assert.equal(r.code, 502);
  assert.equal(created.length, 0);
});

test("ingest keeps one response shape whether it pushes or not", async () => {
  reset();
  judgeResult = judgeIds(["ind-1"]);
  const pushed = await ingest({ provider: "indeed", jobs: [indeedJob(1)] });
  reset();
  capResult = { remaining: 0 };
  const capped = await ingest({ provider: "indeed", jobs: [indeedJob(1)] });
  for (const k of ["outcome", "provider", "fetched", "invalid", "pushed", "judged", "picked",
                   "alreadyHad", "blockedByPolicy", "remainingBefore", "minutes"]) {
    assert.ok(k in pushed.body, `pushed response lacks ${k}`);
    assert.ok(k in capped.body, `cap-hit response lacks ${k}`);
  }
});

test("the ingest route needs the ops key", () => {
  const routes = readFileSync(new URL("../../Routes.js", import.meta.url), "utf8");
  assert.match(routes, /app\.post\("\/job-api\/ingest\/:email", requireOpsKey, ingestJobApiJobs\)/);
});
