// Base cover letter -> per-job letter: routes and the queue worker with every
// model, R2, OpenAI and the usage recorder mocked.
//
//   Operations tab:  GET/PUT /operations/base-cover-letter (ops key, operator check, queued count)
//   Extension:       GET /extension/speedyapply/cover-letters (optimized, baseLetter)
//                    GET /extension/speedyapply/cover-letters/job/:jobId (owner check, shape)
//   Worker:          processCoverLetterJob / enqueueCoverLetterIfEligible
//
// mock.module needs --experimental-test-module-mocks (npm test passes it).

import test, { mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const db = {};
const seen = {};

function reset() {
  db.operator = null;
  db.users = [];
  db.sa = null;
  db.dash = null;
  db.jobFindOne = null; // (query) => job | null
  db.jobsFind = [];
  db.counts = { optimized: 0, pending: 0, failed: 0 };
  db.claimed = { _id: "c1" }; // findOneAndUpdate result for the completion step
  db.r2 = {};
  db.r2PutFails = false;
  db.optimized = null;
  seen.jobUpdates = [];
  seen.userUpdates = [];
  seen.jobFind = null;
  seen.jobFindSort = null;
  seen.jobFindLimit = null;
  seen.jobFindOne = [];
  seen.r2Puts = [];
  seen.usage = [];
  process.env.auto_fill_chatgpt_API = "test-key";
}
reset();

const chain = (value) => {
  const q = {
    select() { return q; },
    sort() { return q; },
    limit() { return q; },
    lean() { return Promise.resolve(typeof value === "function" ? value() : value); },
  };
  return q;
};

function findUser(query) {
  const e = query?.email;
  if (typeof e === "string") return db.users.find((u) => u.email === e) || null;
  if (e?.$regex) return db.users.find((u) => e.$regex.test(u.email)) || null;
  return null;
}

mock.module("../../Schema_Models/Operations.js", {
  defaultExport: { findOne: () => chain(() => db.operator) },
});
mock.module("../../Schema_Models/UserModel.js", {
  namedExports: {
    UserModel: {
      findOne: (q) => chain(() => findUser(q)),
      updateOne: async (filter, update) => { seen.userUpdates.push({ filter, update }); return { matchedCount: 1 }; },
    },
  },
});
mock.module("../../Schema_Models/ProfileModel.js", {
  namedExports: { ProfileModel: { findOne: () => chain(() => db.dash) } },
});
mock.module("../../Schema_Models/SpeedyApplyProfile.js", {
  namedExports: { SpeedyApplyProfile: { findOne: () => chain(() => db.sa) } },
});
mock.module("../../Schema_Models/JobModel.js", {
  namedExports: {
    JobModel: {
      findOne: (q) => { seen.jobFindOne.push(q); return chain(() => (db.jobFindOne ? db.jobFindOne(q) : null)); },
      find: (q) => {
        seen.jobFind = q;
        const c = chain(() => db.jobsFind);
        c.sort = (x) => { seen.jobFindSort = x; return c; };
        c.limit = (n) => { seen.jobFindLimit = n; return c; };
        return c;
      },
      updateMany: async (filter, update) => {
        seen.jobUpdates.push({ op: "updateMany", filter, update });
        return { matchedCount: filter?._id?.$in?.length ?? 0, modifiedCount: 0 };
      },
      updateOne: async (filter, update) => { seen.jobUpdates.push({ op: "updateOne", filter, update }); return { matchedCount: 1 }; },
      findOneAndUpdate: (filter, update) => { seen.jobUpdates.push({ op: "findOneAndUpdate", filter, update }); return chain(() => db.claimed); },
      countDocuments: async (f) => {
        if (f["optimizedCoverLetter.hasLetter"]) return db.counts.optimized;
        if (f["coverLetterOptimization.status"]?.$in) return db.counts.pending;
        return db.counts.failed;
      },
    },
  },
});
mock.module("../r2Storage.js", {
  namedExports: {
    getJSONFromR2: async (key) => (db.r2[key] ? { success: true, data: db.r2[key] } : { success: false, error: "NoSuchKey" }),
    getObjectFromR2: async () => ({ success: false, error: "NoSuchKey" }),
    putJSONToR2: async (key, data) => {
      seen.r2Puts.push({ key, data });
      if (db.r2PutFails) return { success: false, error: "boom" };
      db.r2[key] = data;
      return { success: true, key };
    },
    deleteFromR2: async (key) => { delete db.r2[key]; return { success: true, key }; },
  },
});
mock.module("../aiUsage.js", {
  namedExports: {
    AI_USAGE_SOURCES: { SPEEDYAPPLY_COVER_LETTER: "speedyapply-cover-letter", SPEEDYAPPLY_COVER_LETTER_AUTO: "speedyapply-cover-letter-auto" },
    recordAiUsage: (x) => { seen.usage.push(x.source); },
  },
});
mock.module("../optimizedResumeData.js", {
  namedExports: {
    loadOptimizedResumeData: async () => (db.optimized ? { ok: true, data: db.optimized } : { ok: false, reason: "missing" }),
  },
});

const { getBaseCoverLetter, putBaseCoverLetter } = await import("../../Controllers/operations/BaseCoverLetter.js");
const { listSpeedyApplyCoverLetters, getSpeedyApplyJobCoverLetter } = await import("../../Controllers/Extensions/speedyApplyCoverLetters.js");
const { processCoverLetterJob, enqueueCoverLetterIfEligible, requeueClientCards } = await import("../coverLetterAutoWriter.js");
const { clearBaseLetterCache } = await import("../baseCoverLetter.js");
const { default: requireOpsKey } = await import("../../Middlewares/RequireOpsKey.js");
const { TAILOR_COVER_LETTER_SYSTEM_PROMPT } = await import("../speedyApplyCoverLetterWriter.js");

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const CLIENT_ID = "6512aaaaaaaaaaaaaaaaaaaa";
const JOB_ID = "689602d987b7d2042d9eaa21";
const OPERATOR = { email: "sarah@flashfirehq", name: "Sarah", role: "operations", managedUsers: [CLIENT_ID] };
const STRANGER = { email: "omar@flashfirehq", name: "Omar", role: "operations", managedUsers: [] };
const ADMIN = { email: "admin@flashfirehq", name: "Priya", role: "admin", managedUsers: [] };
const BASE_KEY = "flashfirejobs/Jane_Example.com/cover-letter/base.json";
const BODY = [
  "I turn messy retail data into forecasts that store managers actually trust and use every week. Over four years I have built pipelines, dashboards and models that moved real decisions.",
  "At Acme I rebuilt the reporting stack in dbt and cut the weekly report time by 40 percent, which freed the analysts to work on pricing questions instead of copying numbers between sheets.",
  "I would like to bring the same habits to your team, and I would welcome the chance to talk about the role.",
].join("\n\n");

const client = (over = {}) => ({ _id: CLIENT_ID, name: "Jane Doe", email: "Jane@Example.com", planType: "Executive", ...over });

function res() {
  const r = { code: 0, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.set = (k, v) => { if (typeof k === "object") Object.assign(r.headers, k); else r.headers[k] = v; return r; };
  return r;
}

const realFetch = globalThis.fetch;
let fetchCalls = [];
function mockOpenAi(...contents) {
  fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, body: JSON.parse(init.body) });
    const next = contents[Math.min(fetchCalls.length - 1, contents.length - 1)];
    if (typeof next === "number") return new Response("no", { status: next });
    return new Response(
      JSON.stringify({ model: "gpt-4o-mini-2024-07-18", choices: [{ message: { content: next } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}
test.after(() => { globalThis.fetch = realFetch; });

const goodLetter = JSON.stringify({ paragraphs: Array.from({ length: 4 }, () => "work ".repeat(80).trim() + ".") });

// ---------------------------------------------------------------------------
// Ops key
// ---------------------------------------------------------------------------

test("ops key: missing or wrong x-ops-key is 401 with ok:false, right key passes", () => {
  delete process.env.OPS_SECRET_KEY;
  for (const headers of [{}, { "x-ops-key": "nope" }]) {
    const r = res();
    let nexted = false;
    requireOpsKey({ headers, method: "PUT", originalUrl: "/operations/base-cover-letter" }, r, () => { nexted = true; });
    assert.equal(r.code, 401);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, "unauthorized");
    assert.equal(nexted, false);
  }
  let nexted = false;
  requireOpsKey({ headers: { "x-ops-key": "flashfire@2025" } }, res(), () => { nexted = true; });
  assert.equal(nexted, true);
});

// ---------------------------------------------------------------------------
// Operator routes
// ---------------------------------------------------------------------------

test("operator GET: 400 without clientEmail, 403 for a non-operator, 404 unknown client", async () => {
  reset();
  let r = res();
  await getBaseCoverLetter({ query: { operatorEmail: "sarah@flashfirehq" } }, r);
  assert.equal(r.code, 400);
  assert.deepEqual([r.body.ok, r.body.error], [false, "client_required"]);

  db.users = [client()];
  r = res();
  await getBaseCoverLetter({ query: { clientEmail: "jane@example.com", operatorEmail: "jane@example.com" } }, r);
  assert.equal(r.code, 403);
  assert.equal(r.body.error, "not_your_client");

  db.operator = OPERATOR;
  r = res();
  await getBaseCoverLetter({ query: { clientEmail: "ghost@example.com", operatorEmail: "sarah@flashfirehq" } }, r);
  assert.equal(r.code, 404);
  assert.equal(r.body.error, "client_not_found");
});

test("operator GET: 403 not_your_client when the operator does not manage the client", async () => {
  reset();
  db.users = [client()];
  db.operator = STRANGER;
  const r = res();
  await getBaseCoverLetter({ query: { clientEmail: "jane@example.com", operatorEmail: "omar@flashfirehq" } }, r);
  assert.equal(r.code, 403);
  assert.equal(r.body.error, "not_your_client");
  assert.equal(r.body.text, undefined, "a refusal carries no letter");
});

test("operator GET: admin sees any client; contract shape with text, plan and stats", async () => {
  reset();
  clearBaseLetterCache();
  const at = new Date("2026-11-10T08:00:00Z");
  db.users = [client({ baseCoverLetter: { key: BASE_KEY, updatedAt: at, updatedBy: "Sarah", words: 70, hash: "h1" } })];
  db.r2[BASE_KEY] = { text: BODY, updatedAt: at.toISOString(), updatedBy: "Sarah" };
  db.operator = ADMIN;
  db.counts = { optimized: 12, pending: 3, failed: 1 };
  const r = res();
  await getBaseCoverLetter({ query: { clientEmail: "JANE@example.com", operatorEmail: "admin@flashfirehq" } }, r);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, {
    ok: true,
    text: BODY,
    updatedAt: at.toISOString(),
    updatedBy: "Sarah",
    words: 70,
    plan: "Executive",
    executive: true,
    stats: { optimized: 12, pending: 3, failed: 1 },
  });
});

test("operator GET: no base letter is text '' and any plan works (executive:false)", async () => {
  reset();
  db.users = [client({ planType: "Professional" })];
  db.operator = OPERATOR;
  const r = res();
  await getBaseCoverLetter({ query: { clientEmail: "jane@example.com", operatorEmail: "sarah@flashfirehq" } }, r);
  assert.equal(r.code, 200);
  assert.equal(r.body.text, "");
  assert.equal(r.body.updatedAt, null);
  assert.equal(r.body.words, 0);
  assert.equal(r.body.plan, "Professional");
  assert.equal(r.body.executive, false);
});

test("operator PUT: saves to R2 + user pointer and returns the queued count", async () => {
  reset();
  db.users = [client()];
  db.operator = OPERATOR;
  db.jobsFind = [{ _id: "j3" }, { _id: "j2" }, { _id: "j1" }];
  const r = res();
  await putBaseCoverLetter(
    { body: { clientEmail: "jane@example.com", operatorEmail: "sarah@flashfirehq", operatorName: "Sarah K", text: `Dear Hiring Manager,\n\n${BODY}\n\nSincerely,\nJane Doe` } },
    r,
  );
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body).sort(), ["ok", "queued", "updatedAt", "words"]);
  assert.equal(r.body.queued, 3);
  assert.ok(r.body.words > 50);

  // R2: the cleaned body only.
  assert.equal(seen.r2Puts.length, 1);
  assert.equal(seen.r2Puts[0].key, BASE_KEY);
  assert.equal(seen.r2Puts[0].data.text, BODY);
  assert.equal(seen.r2Puts[0].data.updatedBy, "Sarah");

  // User pointer.
  const set = seen.userUpdates[0].update.$set.baseCoverLetter;
  assert.equal(set.key, BASE_KEY);
  assert.match(set.hash, /^[0-9a-f]{16}$/);
  assert.equal(set.words, r.body.words);

  // Enqueue selection: saved cards with a resume and another base hash.
  assert.deepEqual(seen.jobFind.userID.$in.sort(), ["Jane@Example.com", "jane@example.com"].sort());
  assert.equal(seen.jobFind.currentStatus, "saved");
  assert.equal(seen.jobFind["optimizedResume.hasResume"], true);
  assert.deepEqual(seen.jobFind["optimizedCoverLetter.baseHash"], { $ne: set.hash });
  const upd = seen.jobUpdates.find((u) => u.op === "updateMany");
  assert.deepEqual(upd.filter, { _id: { $in: ["j3", "j2", "j1"] } });
  assert.equal(upd.update.$set["coverLetterOptimization.status"], "pending");
});

test("operator PUT: a non-Executive client is saved but nothing is queued", async () => {
  reset();
  db.users = [client({ planType: "Ignite" })];
  db.operator = OPERATOR;
  db.jobsFind = [{ _id: "j1" }];
  const r = res();
  await putBaseCoverLetter({ body: { clientEmail: "jane@example.com", operatorEmail: "sarah@flashfirehq", text: BODY } }, r);
  assert.equal(r.code, 200);
  assert.equal(r.body.queued, 0);
  assert.equal(seen.r2Puts.length, 1);
  assert.equal(seen.jobUpdates.length, 0);
});

test("operator PUT: 400 too short / too long, empty deletes, R2 failure is 500", async () => {
  reset();
  db.users = [client({ baseCoverLetter: { key: BASE_KEY } })];
  db.operator = OPERATOR;
  db.r2[BASE_KEY] = { text: BODY };
  const base = { clientEmail: "jane@example.com", operatorEmail: "sarah@flashfirehq" };

  let r = res();
  await putBaseCoverLetter({ body: { ...base, text: "Too short." } }, r);
  assert.deepEqual([r.code, r.body.error], [400, "base_letter_too_short"]);

  r = res();
  await putBaseCoverLetter({ body: { ...base, text: "a".repeat(8001) } }, r);
  assert.deepEqual([r.code, r.body.error], [400, "base_letter_too_long"]);

  r = res();
  await putBaseCoverLetter({ body: { ...base, text: "" } }, r);
  assert.equal(r.code, 200);
  assert.deepEqual([r.body.words, r.body.queued], [0, 0]);
  assert.equal(db.r2[BASE_KEY], undefined, "base.json deleted");
  assert.deepEqual(seen.userUpdates.at(-1).update, { $unset: { baseCoverLetter: 1 } });
  assert.equal(seen.jobUpdates.length, 0, "generated letters are left alone");

  db.r2PutFails = true;
  r = res();
  await putBaseCoverLetter({ body: { ...base, text: BODY } }, r);
  assert.equal(r.code, 500);
  assert.equal(r.body.ok, false);
});

test("operator PUT: another operator's client is 403 and nothing is written", async () => {
  reset();
  db.users = [client()];
  db.operator = STRANGER;
  const r = res();
  await putBaseCoverLetter({ body: { clientEmail: "jane@example.com", operatorEmail: "omar@flashfirehq", text: BODY } }, r);
  assert.equal(r.code, 403);
  assert.equal(seen.r2Puts.length, 0);
  assert.equal(seen.userUpdates.length, 0);
});

test("requeue: capped at 500, newest first; nothing to queue writes nothing", async () => {
  reset();
  db.jobsFind = [{ _id: "j9" }];
  assert.equal(await requeueClientCards(["a@x.com"], "h"), 1);
  assert.deepEqual(seen.jobFindSort, { _id: -1 });
  assert.equal(seen.jobFindLimit, 500);

  reset();
  db.jobsFind = [];
  assert.equal(await requeueClientCards(["a@x.com"], "h"), 0);
  assert.equal(seen.jobUpdates.length, 0);
});

// ---------------------------------------------------------------------------
// Extension routes
// ---------------------------------------------------------------------------

const letterJob = (over = {}) => ({
  _id: JOB_ID,
  userID: "Jane@Example.com",
  jobTitle: "Data Analyst",
  companyName: "Acme",
  optimizedCoverLetter: { hasLetter: true, dataKey: `flashfirejobs/Jane_Example.com/cover-letter-data/${JOB_ID}.json`, createdAt: new Date("2026-11-12T10:00:00Z") },
  ...over,
});

test("extension list: `optimized` from the job card saved for the page, plus `baseLetter`", async () => {
  reset();
  db.users = [client({ baseCoverLetter: { key: BASE_KEY } })];
  db.jobFindOne = (q) => (q["optimizedCoverLetter.hasLetter"] ? letterJob() : null);
  const r = res();
  await listSpeedyApplyCoverLetters({ speedyApplyEmail: "jane@example.com", query: { url: "https://boards.greenhouse.io/acme/jobs/123" } }, r);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.optimized, {
    id: `job:${JOB_ID}`,
    jobId: JOB_ID,
    companyName: "Acme",
    jobRole: "Data Analyst",
    createdAt: "2026-11-12T10:00:00.000Z",
  });
  assert.equal(r.body.baseLetter, true);
  const q = seen.jobFindOne.find((x) => x["optimizedCoverLetter.hasLetter"]);
  assert.ok(q.joblinkKey.$in.length > 0);
  assert.deepEqual(q.userID.$in.sort(), ["Jane@Example.com", "jane@example.com"].sort());
});

test("extension list: no page url means optimized null and no job query", async () => {
  reset();
  db.users = [client()];
  const r = res();
  await listSpeedyApplyCoverLetters({ speedyApplyEmail: "jane@example.com", query: {} }, r);
  assert.equal(r.code, 200);
  assert.equal(r.body.optimized, null);
  assert.equal(r.body.baseLetter, false);
  assert.equal(seen.jobFindOne.length, 0);
});

test("extension job letter: 200 contract shape with contact built from the DB", async () => {
  reset();
  db.users = [client()];
  db.sa = { profile: { firstName: "Jane", lastName: "Doe", phone: "+1 555 0100", email: "jane@example.com", address: { city: "Durham", state: "NC", country: "USA" } } };
  db.jobFindOne = () => letterJob();
  db.r2[letterJob().optimizedCoverLetter.dataKey] = { paragraphs: ["One.", "Two.", "Three.", "Four."], jobTitle: "Data Analyst", companyName: "Acme" };
  const r = res();
  await getSpeedyApplyJobCoverLetter({ speedyApplyEmail: "jane@example.com", params: { jobId: JOB_ID } }, r);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, {
    ok: true,
    letter: {
      name: "Jane Doe",
      phone: "+1 555 0100",
      email: "jane@example.com",
      location: "Durham, NC, USA",
      salutation: "Dear Hiring Manager,",
      paragraphs: ["One.", "Two.", "Three.", "Four."],
      closing: "Sincerely,",
      signature: "Jane Doe",
    },
    company: "Acme",
    jobTitle: "Data Analyst",
    createdAt: "2026-11-12T10:00:00.000Z",
  });
});

test("extension job letter: another client's card, a bad id, no letter are all 404; R2 down is 502", async () => {
  reset();
  db.users = [client()];
  const call = async (jobId, email = "jane@example.com") => {
    const r = res();
    await getSpeedyApplyJobCoverLetter({ speedyApplyEmail: email, params: { jobId } }, r);
    return r;
  };

  db.jobFindOne = () => letterJob({ userID: "mallory@example.com" });
  let r = await call(JOB_ID);
  assert.deepEqual([r.code, r.body.ok, r.body.error], [404, false, "not_found"]);

  r = await call("not-an-object-id");
  assert.equal(r.code, 404);

  db.jobFindOne = () => letterJob({ optimizedCoverLetter: { hasLetter: false } });
  r = await call(JOB_ID);
  assert.equal(r.code, 404);

  db.jobFindOne = () => null;
  r = await call(JOB_ID);
  assert.equal(r.code, 404);

  db.jobFindOne = () => letterJob();
  r = await call(JOB_ID);
  assert.deepEqual([r.code, r.body.error], [502, "storage"]);
});

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

const queuedJob = (over = {}) => ({
  _id: JOB_ID,
  userID: "Jane@Example.com",
  jobTitle: "Data Analyst",
  companyName: "Acme",
  jobDescription: "SQL, dbt and Looker for retail forecasting.",
  optimizedResume: { hasResume: true, storageType: "r2", resumeDataKey: "k" },
  optimizedCoverLetter: { version: 1 },
  coverLetterOptimization: { status: "processing", attempts: 1 },
  ...over,
});

const touchesResume = (u) => JSON.stringify(u.update).match(/autoOptimization|optimizedResume"/);

test("worker: tailors the base letter, stores the R2 JSON and completes the card", async () => {
  reset();
  clearBaseLetterCache();
  db.users = [client({ baseCoverLetter: { key: BASE_KEY, updatedAt: new Date("2026-11-10T00:00:00Z"), hash: "h1" } })];
  db.r2[BASE_KEY] = { text: BODY };
  db.optimized = { workExperience: [{ position: "Data Analyst", company: "Acme", responsibilities: ["Cut report time 40%"] }] };
  mockOpenAi(goodLetter);

  const out = await processCoverLetterJob(queuedJob());
  assert.equal(out.status, "completed");

  const sent = fetchCalls[0].body;
  assert.equal(sent.model, "gpt-4o-mini");
  assert.deepEqual(sent.response_format, { type: "json_object" });
  assert.equal(sent.messages[0].content, TAILOR_COVER_LETTER_SYSTEM_PROMPT);
  assert.ok(sent.messages[1].content.includes("forecasts that store managers actually trust"));
  assert.ok(sent.messages[1].content.includes("Cut report time 40%"), "optimized resume is the candidate data");
  assert.deepEqual(seen.usage, ["speedyapply-cover-letter-auto"]);

  const key = `flashfirejobs/Jane_Example.com/cover-letter-data/${JOB_ID}.json`;
  assert.equal(out.key, key);
  const put = seen.r2Puts.find((p) => p.key === key);
  assert.deepEqual(Object.keys(put.data).sort(), ["baseHash", "companyName", "createdAt", "jobTitle", "model", "paragraphs"]);
  assert.equal(put.data.paragraphs.length, 4);
  assert.equal(put.data.baseHash, "h1");
  assert.ok(!JSON.stringify(put.data).includes("jane@example.com"), "no contact details stored");

  const done = seen.jobUpdates.find((u) => u.op === "findOneAndUpdate");
  assert.deepEqual(done.filter, { _id: JOB_ID, "coverLetterOptimization.status": "processing" });
  assert.equal(done.update.$set.optimizedCoverLetter.version, 2);
  assert.equal(done.update.$set.optimizedCoverLetter.hasLetter, true);
  assert.equal(done.update.$set.optimizedCoverLetter.dataKey, key);
  assert.equal(done.update.$set["coverLetterOptimization.status"], "completed");
  assert.ok(seen.jobUpdates.every((u) => !touchesResume(u)), "resume state is never written");
});

test("worker: requeued during the run keeps the letter but stays pending", async () => {
  reset();
  clearBaseLetterCache();
  db.users = [client({ baseCoverLetter: { key: BASE_KEY, updatedAt: new Date(), hash: "h1" } })];
  db.r2[BASE_KEY] = { text: BODY };
  db.claimed = null; // status was reset to pending by a base letter save
  mockOpenAi(goodLetter);
  await processCoverLetterJob(queuedJob());
  const after = seen.jobUpdates.at(-1);
  assert.equal(after.op, "updateOne");
  assert.ok(after.update.$set.optimizedCoverLetter.hasLetter);
  assert.equal(after.update.$set["coverLetterOptimization.status"], undefined);
});

test("worker: not Executive or no base letter at processing time is skipped, no AI call", async () => {
  for (const user of [client({ planType: "Prime", baseCoverLetter: { key: BASE_KEY } }), client()]) {
    reset();
    db.users = [user];
    mockOpenAi(goodLetter);
    const out = await processCoverLetterJob(queuedJob());
    assert.equal(out.status, "skipped");
    assert.equal(fetchCalls.length, 0);
    const u = seen.jobUpdates.at(-1);
    assert.equal(u.update.$set["coverLetterOptimization.status"], "skipped");
    assert.ok(!touchesResume(u));
  }
});

test("worker: unusable output twice throws (the worker backs off), nothing stored", async () => {
  reset();
  clearBaseLetterCache();
  db.users = [client({ baseCoverLetter: { key: BASE_KEY, updatedAt: new Date(), hash: "h1" } })];
  db.r2[BASE_KEY] = { text: BODY };
  mockOpenAi(JSON.stringify({ paragraphs: ["short"] }), "not json");
  await assert.rejects(processCoverLetterJob(queuedJob()), /usable letter/);
  assert.equal(fetchCalls.length, 2, "one retry");
  assert.equal(seen.r2Puts.length, 0);
  assert.equal(seen.jobUpdates.length, 0);
});

test("enqueue after a resume save: Executive with a base letter only, never throws", async () => {
  reset();
  db.users = [client({ baseCoverLetter: { key: BASE_KEY } })];
  assert.equal(await enqueueCoverLetterIfEligible({ _id: JOB_ID, userID: "jane@example.com" }), true);
  const u = seen.jobUpdates.at(-1);
  assert.deepEqual(u.filter, { _id: JOB_ID });
  assert.equal(u.update.$set["coverLetterOptimization.status"], "pending");
  assert.equal(u.update.$set["coverLetterOptimization.attempts"], 0);

  reset();
  db.users = [client({ planType: "Professional", baseCoverLetter: { key: BASE_KEY } })];
  assert.equal(await enqueueCoverLetterIfEligible({ _id: JOB_ID, userID: "jane@example.com" }), false);
  db.users = [client()];
  assert.equal(await enqueueCoverLetterIfEligible({ _id: JOB_ID, userID: "jane@example.com" }), false);
  assert.equal(seen.jobUpdates.length, 0);

  db.users = null; // findUser throws on a broken lookup
  assert.equal(await enqueueCoverLetterIfEligible({ _id: JOB_ID, userID: "jane@example.com" }), false);
});
