// AI summary build lifecycle — the async build introduced when
// POST /build-ai-summary started 502ing behind Cloudflare.
//
// Everything here runs offline: axios is stubbed (resume API + OpenAI) and
// ProfileModel's statics are swapped for a tiny in-memory store, so the whole
// claim → build → persist → status path is exercised without Mongo or a key.
//
// What it pins down:
//   • the six-header contract is repaired in CANONICAL order, not appended
//   • only one build per profile at a time, whichever trigger fires
//   • a trigger skipped mid-build leaves summaryStale=true for the sweep
//   • mixed-case profile emails resolve on both new endpoints
//   • an abandoned build is reported as an error, not a permanent spinner

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import axios from "axios";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-key";
// Keep the budget small so the reroll-budget branch is reachable in a test.
process.env.SUMMARY_BUILD_BUDGET_MS = process.env.SUMMARY_BUILD_BUDGET_MS || String(8 * 60 * 1000);
mongoose.set("bufferCommands", false); // recordAiUsage must fail fast, not hang

const { ProfileModel } = await import("../../Schema_Models/ProfileModel.js");
const {
  default: BuildAiSummary,
  AiSummaryStatus,
  buildSummaryForEmail,
  ensureRequiredSections,
  missingSections,
} = await import("../../Controllers/BuildAiSummary.js");

const HEADERS = [
  "# Candidate Summary",
  "# Target Roles",
  "# Hard Constraints",
  "# Strong Signals",
  "# Hard Disqualifiers",
  "# Notes for Grader",
];

const WELL_FORMED = HEADERS.map((h) => `${h}\n- ${h.replace("# ", "")} line.`).join("\n\n");

// ── in-memory ProfileModel ────────────────────────────────────────────────
// Only the query shapes BuildAiSummary actually uses are supported. Anything
// else throws loudly rather than silently matching nothing.
let store = [];
const origStatics = {};

function getPath(doc, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), doc);
}

function setPath(doc, path, value) {
  const keys = path.split(".");
  let node = doc;
  for (const k of keys.slice(0, -1)) {
    if (typeof node[k] !== "object" || node[k] === null) node[k] = {};
    node = node[k];
  }
  node[keys.at(-1)] = value;
}

function matchClause(doc, key, cond) {
  const actual = getPath(doc, key);
  if (cond === null) return actual === null || actual === undefined;
  if (cond instanceof RegExp) return typeof actual === "string" && cond.test(actual);
  if (cond && typeof cond === "object" && !(cond instanceof Date)) {
    for (const [op, val] of Object.entries(cond)) {
      if (op === "$ne" && actual === val) return false;
      else if (op === "$lt" && !(actual != null && new Date(actual) < new Date(val))) return false;
      else if (op === "$exists" && (actual !== undefined) !== val) return false;
      else if (op === "$regex" && !(typeof actual === "string" && new RegExp(val).test(actual))) return false;
      else if (!["$ne", "$lt", "$exists", "$regex"].includes(op)) throw new Error(`unsupported op ${op}`);
    }
    return true;
  }
  return actual === cond;
}

function matches(doc, filter) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$or") {
      if (!cond.some((sub) => matches(doc, sub))) return false;
    } else if (!matchClause(doc, key, cond)) {
      return false;
    }
  }
  return true;
}

function applyUpdate(doc, update) {
  for (const [path, value] of Object.entries(update.$set || {})) setPath(doc, path, value);
}

// A thenable that also answers .select()/.lean()/.catch(), the way the
// controller chains its queries.
function query(resolve) {
  const p = {
    select: () => p,
    lean: () => p,
    then: (ok, err) => Promise.resolve().then(resolve).then(ok, err),
    catch: (err) => Promise.resolve().then(resolve).catch(err),
  };
  return p;
}

function installStubs() {
  for (const name of ["findOne", "findOneAndUpdate", "updateOne"]) {
    origStatics[name] = ProfileModel[name];
  }
  ProfileModel.findOne = (filter) => query(() => structuredClone(store.find((d) => matches(d, filter)) || null));
  ProfileModel.findOneAndUpdate = (filter, update, opts = {}) => query(() => {
    const doc = store.find((d) => matches(d, filter));
    if (!doc) return null;
    const before = structuredClone(doc);
    applyUpdate(doc, update);
    return opts.new ? structuredClone(doc) : before;
  });
  ProfileModel.updateOne = (filter, update) => query(() => {
    const doc = store.find((d) => matches(d, filter));
    if (doc) applyUpdate(doc, update);
    return { matchedCount: doc ? 1 : 0 };
  });
}

function restoreStubs() {
  for (const [name, fn] of Object.entries(origStatics)) ProfileModel[name] = fn;
}

// ── axios stub: resume API 404 (legitimate profile-only), OpenAI happy path ──
let openaiCalls = 0;
let openaiReply = () => WELL_FORMED;
const origPost = axios.post;

function installAxiosStub() {
  axios.post = async (url, body) => {
    if (url.includes("/api/resume-by-email")) {
      const err = new Error("not found");
      err.response = { status: 404, data: { error: "no resume assigned" } };
      throw err;
    }
    if (url.includes("api.openai.com")) {
      openaiCalls += 1;
      return {
        data: {
          model: "gpt-4o-mini",
          choices: [{ message: { content: openaiReply(openaiCalls, body) } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        },
      };
    }
    throw new Error(`unexpected axios.post to ${url}`);
  };
}

function makeProfile(email, extra = {}) {
  return {
    _id: `id-${email}`,
    email,
    firstName: "Test",
    lastName: "Client",
    summaryStale: true,
    aiSummary: "",
    aiSummaryMeta: {},
    ...extra,
  };
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

before(() => { installStubs(); installAxiosStub(); });
after(() => { restoreStubs(); axios.post = origPost; });
beforeEach(() => { store = []; openaiCalls = 0; openaiReply = () => WELL_FORMED; });

// ── ensureRequiredSections ────────────────────────────────────────────────

test("ensureRequiredSections is a no-op on a well-formed brief", () => {
  assert.equal(ensureRequiredSections(WELL_FORMED), WELL_FORMED.trimEnd());
  assert.deepEqual(missingSections(WELL_FORMED), []);
});

test("ensureRequiredSections restores missing headers in canonical order", () => {
  const partial = "# Candidate Summary\n- Backend engineer.\n\n# Notes for Grader\n- Prefers remote.";
  const fixed = ensureRequiredSections(partial);
  assert.deepEqual(missingSections(fixed), []);
  const order = fixed.split("\n").filter((l) => l.startsWith("# "));
  assert.deepEqual(order, HEADERS, "backfilled headers must slot into canonical order, not append at the end");
  assert.match(fixed, /# Candidate Summary\n- Backend engineer\./);
  assert.match(fixed, /# Notes for Grader\n- Prefers remote\./, "existing content is preserved verbatim");
  assert.match(fixed, /# Hard Disqualifiers\n- None specified\./);
});

test("ensureRequiredSections keeps non-required sections and any preamble", () => {
  const partial = "Intro line.\n\n# Candidate Summary\n- One.\n\n# Extra Section\n- Keep me.";
  const fixed = ensureRequiredSections(partial);
  assert.deepEqual(missingSections(fixed), []);
  assert.match(fixed, /^Intro line\./);
  assert.match(fixed, /# Extra Section\n- Keep me\./);
  const heads = fixed.split("\n").filter((l) => l.startsWith("# "));
  assert.deepEqual(heads.slice(0, 6), HEADERS);
  assert.equal(heads.at(-1), "# Extra Section", "extra sections land after the required six");
});

test("missingSections tolerates the parenthetical header suffixes the prompt allows", () => {
  const withSuffix = WELL_FORMED.replace("# Strong Signals", "# Strong Signals (auto-PICK if matched)");
  assert.deepEqual(missingSections(withSuffix), []);
});

// ── build lifecycle ───────────────────────────────────────────────────────

test("a successful build persists the brief and marks the profile done", async () => {
  store.push(makeProfile("client@example.com"));
  const result = await buildSummaryForEmail("client@example.com", "manual");
  assert.equal(result.success, true, JSON.stringify(result));
  const doc = store[0];
  assert.equal(doc.aiSummaryMeta.status, "done");
  assert.equal(doc.aiSummaryMeta.lastError, null);
  assert.equal(doc.summaryStale, false);
  assert.deepEqual(missingSections(doc.aiSummary), []);
  assert.ok(doc.aiSummaryMeta.buildStartedAt instanceof Date, "the claim timestamp is carried into the persisted meta");
});

test("a malformed round-1 brief is rerolled, then backfilled rather than failing the build", async () => {
  store.push(makeProfile("sparse@example.com"));
  // Every attempt drops two sections, so the reroll never succeeds and the
  // deterministic backfill has to carry the six-header contract.
  openaiReply = () => "# Candidate Summary\n- Only this.\n\n# Target Roles\n- And this.";
  const result = await buildSummaryForEmail("sparse@example.com", "manual");
  assert.equal(result.success, true, JSON.stringify(result));
  assert.ok(openaiCalls >= 3, `expected round-1 rerolls, got ${openaiCalls} OpenAI calls`);
  assert.deepEqual(missingSections(store[0].aiSummary), []);
  assert.equal(store[0].aiSummaryMeta.status, "done");
});

test("a failed build releases the claim and records the error", async () => {
  store.push(makeProfile("broken@example.com"));
  openaiReply = () => "";  // empty content → EMPTY_SUMMARY
  const result = await buildSummaryForEmail("broken@example.com", "manual");
  assert.equal(result.success, false);
  assert.equal(result.error, "EMPTY_SUMMARY");
  assert.equal(store[0].aiSummaryMeta.status, "error", "status must not be left at building");
  assert.equal(store[0].aiSummaryMeta.lastError.error, "EMPTY_SUMMARY");
});

test("a second trigger during a live build is skipped and leaves the profile stale", async () => {
  store.push(makeProfile("busy@example.com", {
    summaryStale: false,
    aiSummaryMeta: { status: "building", buildStartedAt: new Date() },
  }));
  const result = await buildSummaryForEmail("busy@example.com", "job-removal");
  assert.equal(result.success, false);
  assert.equal(result.skipped, true);
  assert.equal(result.error, "BUILD_IN_PROGRESS");
  assert.equal(openaiCalls, 0, "the duplicate build must not call OpenAI");
  assert.equal(store[0].summaryStale, true, "the sweep has to pick this up — the live build never saw the change");
  assert.ok(store[0].summaryRebuildRequestedAt instanceof Date);
});

test("a build whose claim went stale can be reclaimed", async () => {
  store.push(makeProfile("stuck@example.com", {
    aiSummaryMeta: { status: "building", buildStartedAt: new Date(Date.now() - 60 * 60 * 1000) },
  }));
  const result = await buildSummaryForEmail("stuck@example.com", "manual");
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(store[0].aiSummaryMeta.status, "done");
});

test("a rebuild requested mid-build keeps the profile stale after the running build finishes", async () => {
  store.push(makeProfile("racy@example.com"));
  // Simulate the skipped trigger landing while this build is in flight.
  openaiReply = () => {
    store[0].summaryRebuildRequestedAt = new Date(Date.now() + 1000);
    return WELL_FORMED;
  };
  const result = await buildSummaryForEmail("racy@example.com", "manual");
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(store[0].summaryStale, true, "the finished brief predates the change, so it must stay stale");
  assert.ok(store[0].summaryRebuildRequestedAt, "the pending-rebuild flag survives so the sweep's cooldown exemption fires");
});

test("a build that already reflects the request clears the pending-rebuild flag", async () => {
  store.push(makeProfile("consumed@example.com", {
    summaryRebuildRequestedAt: new Date(Date.now() - 60 * 1000), // requested BEFORE this build
  }));
  const result = await buildSummaryForEmail("consumed@example.com", "cron-sweep");
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(store[0].summaryRebuildRequestedAt, null, "otherwise the sweep exemption would fire forever");
  assert.equal(store[0].summaryStale, false);
});

test("buildSummaryForEmail resolves legacy mixed-case profile emails", async () => {
  store.push(makeProfile("Mixed.Case@Example.com"));
  const result = await buildSummaryForEmail("mixed.case@example.com", "manual");
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(store[0].aiSummaryMeta.status, "done");
});

// ── HTTP endpoints ────────────────────────────────────────────────────────

test("POST /build-ai-summary accepts a mixed-case profile instead of 404ing", async () => {
  store.push(makeProfile("Mixed.Case@Example.com"));
  const res = fakeRes();
  await BuildAiSummary({ body: { email: "mixed.case@example.com" } }, res);
  assert.equal(res.statusCode, 202, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.ok(res.body.buildStartedAt, "the poller needs a timestamp to reject a stale done");
});

test("POST /build-ai-summary still 404s when there is genuinely no profile", async () => {
  const res = fakeRes();
  await BuildAiSummary({ body: { email: "nobody@example.com" } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, "PROFILE_NOT_FOUND");
});

test("POST /build-ai-summary reports an in-flight build without starting a second one", async () => {
  const startedAt = new Date();
  store.push(makeProfile("busy@example.com", { aiSummaryMeta: { status: "building", buildStartedAt: startedAt } }));
  const res = fakeRes();
  await BuildAiSummary({ body: { email: "busy@example.com" } }, res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.alreadyRunning, true);
  assert.equal(res.body.buildStartedAt, startedAt.toISOString());
});

test("GET /ai-summary-status resolves mixed-case emails", async () => {
  store.push(makeProfile("Mixed.Case@Example.com", {
    aiSummary: WELL_FORMED,
    aiSummaryMeta: { status: "done", builtAt: new Date(), wordCount: 42 },
  }));
  const res = fakeRes();
  await AiSummaryStatus({ query: { email: "mixed.case@example.com" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "done");
  assert.equal(res.body.wordCount, 42);
});

test("GET /ai-summary-status reports an abandoned build as an error and persists it", async () => {
  store.push(makeProfile("dead@example.com", {
    aiSummaryMeta: { status: "building", buildStartedAt: new Date(Date.now() - 60 * 60 * 1000) },
  }));
  const res = fakeRes();
  await AiSummaryStatus({ query: { email: "dead@example.com" } }, res);
  assert.equal(res.body.status, "error");
  assert.equal(res.body.lastError.error, "BUILD_ABANDONED", "the UI must show a reason, not an empty failure");
  await new Promise((r) => setImmediate(r));
  assert.equal(store[0].aiSummaryMeta.status, "error", "the dead claim is cleared, not left building forever");
});

test("GET /ai-summary-status keeps reporting building while a build is genuinely running", async () => {
  store.push(makeProfile("live@example.com", {
    aiSummaryMeta: { status: "building", buildStartedAt: new Date(Date.now() - 60 * 1000) },
  }));
  const res = fakeRes();
  await AiSummaryStatus({ query: { email: "live@example.com" } }, res);
  assert.equal(res.body.status, "building");
});
