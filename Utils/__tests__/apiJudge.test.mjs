// Judging API-sourced jobs.
//
// A job from the Adzuna API must be judged by exactly the same standard as one
// the extension scraped - otherwise a client gets different work depending on
// where the job came from. These pin the rules that were each learned from a
// live incident, plus the ones specific to having no site match score.

import test from "node:test";
import assert from "node:assert/strict";
import { API_JUDGE_PROMPT, buildUserPrompt, judgeJobs, splitRoles, JUDGE_BATCH_SIZE, englishGloss } from "../apiJudge.js";

const JOBS = [
  { jobId: "adz-1", title: "Registered Nurse", company: "HCA", location: "Sydney", category: "Healthcare & Nursing Jobs" },
  { jobId: "adz-2", title: "Sales Engineer", company: "Snowflake", location: "Remote", category: "IT Jobs" },
];
const PROFILE = {
  preferredRoles: ["Registered Nurse", "Do not add Aged Care roles"],
  preferredLocations: ["Sydney"],
  experienceLevel: "Mid",
  excludedCompanies: ["Acme Staffing"],
};

// ── the rules survived the port ───────────────────────────────────────

test("the rules that cost real incidents are all still in the prompt", () => {
  for (const [label, needle] of [
    ["the recruiter test",            "would a recruiter send this"],
    ["generous at the edges",         "PICK IT with a lower score"],
    ["a different line of work",      "DIFFERENT LINE OF WORK"],
    ["a reworded title is not a miss","worded differently for the same work"],
    ["seniority can never skip",      "SENIORITY."],
    ["location can never skip",       "LOCATION."],
    ["relabelling is called out",     "same mistake with a different label"],
    ["exclusions are data",           "EXCLUSIONS ARE DATA"],
    ["an empty list means no rule",   "does not exist for this candidate"],
    ["an employer name is not a role","employer's name is not an excluded role"],
    ["matchedRole is a claim",        "matchedRole is a claim"],
  ]) {
    assert.ok(API_JUDGE_PROMPT.includes(needle), `missing: ${label}`);
  }
});

test("the prompt says there is no site score, instead of describing one", () => {
  // Scraped cards carry JobRight's match score; API results carry nothing.
  // Leaving the old paragraph in would have the model reasoning about a
  // field it will never be shown.
  assert.ok(API_JUDGE_PROMPT.includes("THERE IS NO SITE MATCH SCORE"));
  assert.ok(!API_JUDGE_PROMPT.includes("JOBRIGHT'S SCORE"));
  assert.ok(!API_JUDGE_PROMPT.includes("jrMatch"));
});

test("the prompt stays generic - no client names, no dates", () => {
  assert.equal(/\b20\d\d-\d\d-\d\d\b/.test(API_JUDGE_PROMPT), false);
  assert.equal(/\b(IBM|SThree|Infosys|Capgemini|Deloitte)\b/.test(API_JUDGE_PROMPT), false);
});

// ── the user prompt ───────────────────────────────────────────────────

test("no job description is sent, deliberately", () => {
  // Sending it made the model read an employer wish list as entry conditions.
  const withDesc = JOBS.map((j) => ({ ...j, description: "MUST HAVE 10 YEARS AND A DEGREE" }));
  const p = buildUserPrompt({ profile: PROFILE, jobs: withDesc, threshold: 50 });
  assert.ok(!p.includes("MUST HAVE 10 YEARS"));
  assert.ok(!/"description"/.test(p));
});

test("it sends what a title-level decision needs, and the threshold", () => {
  const p = buildUserPrompt({ profile: PROFILE, aiSummary: "A nurse, 4 years.", jobs: JOBS, threshold: 55 });
  assert.ok(p.includes("Threshold: 55"));
  assert.ok(p.includes("Registered Nurse") && p.includes("HCA") && p.includes("Sydney"));
  assert.ok(p.includes("Healthcare & Nursing Jobs"), "category is title-adjacent signal, and free");
  assert.ok(p.includes("A nurse, 4 years."));
});

test("a negative written into preferredRoles becomes an exclusion", () => {
  const { preferred, excluded } = splitRoles(["Registered Nurse", "Do not add Aged Care roles"]);
  assert.deepEqual(preferred, ["Registered Nurse"]);
  assert.deepEqual(excluded, ["Aged Care"]);
  assert.ok(buildUserPrompt({ profile: PROFILE, jobs: JOBS }).includes("Aged Care"));
});

// ── judging ───────────────────────────────────────────────────────────

const reply = (decisions) => async () => ({ ok: true, content: JSON.stringify({ decisions }) });

test("picks and skips come back normalised", async () => {
  const r = await judgeJobs({ profile: PROFILE, jobs: JOBS, threshold: 50 }, reply([
    { id: "adz-1", pick: true, score: 82, reason: "Pick - nurse.", matchedRole: "Registered Nurse" },
    { id: "adz-2", pick: false, score: 10, reason: "Skip - sales.", skipKind: "role-mismatch" },
  ]));
  assert.equal(r.ok, true);
  assert.equal(r.decisions.length, 2);
  assert.equal(r.decisions[0].pick, true);
  assert.equal(r.decisions[1].skipKind, "role-mismatch");
});

test("a pick under the operator's threshold is turned into a skip", async () => {
  // The one number the model does not get the last word on.
  const r = await judgeJobs({ profile: PROFILE, jobs: JOBS, threshold: 60 },
    reply([{ id: "adz-1", pick: true, score: 40, reason: "Pick." }]));
  assert.equal(r.decisions[0].pick, false);
  assert.equal(r.decisions[0].skipKind, "threshold");
  assert.match(r.decisions[0].reason, /under the operator's 60/);
});

test("a job the model forgot becomes a skip, never a silent pick", async () => {
  const r = await judgeJobs({ profile: PROFILE, jobs: JOBS, threshold: 50 },
    reply([{ id: "adz-1", pick: true, score: 80 }]));
  assert.equal(r.decisions.length, 2);
  const missing = r.decisions.find((d) => d.id === "adz-2");
  assert.equal(missing.pick, false);
  assert.match(missing.reason, /no verdict/);
});

test("an invented skipKind is replaced, not stored", async () => {
  const r = await judgeJobs({ profile: PROFILE, jobs: [JOBS[0]], threshold: 50 },
    reply([{ id: "adz-1", pick: false, score: 5, skipKind: "vibes" }]));
  assert.equal(r.decisions[0].skipKind, "threshold");
});

test("unparseable JSON fails loudly rather than pushing nothing quietly", async () => {
  const r = await judgeJobs({ profile: PROFILE, jobs: JOBS }, async () => ({ ok: true, content: "not json" }));
  assert.equal(r.ok, false);
  assert.equal(r.error, "BAD_AI_JSON");
});

test("an upstream failure is reported, not swallowed", async () => {
  const r = await judgeJobs({ profile: PROFILE, jobs: JOBS }, async () => ({ ok: false, error: "OPENAI_429" }));
  assert.equal(r.ok, false);
  assert.equal(r.error, "OPENAI_429");
});

test("a thrown call is caught", async () => {
  const r = await judgeJobs({ profile: PROFILE, jobs: JOBS }, async () => { throw new Error("boom"); });
  assert.equal(r.ok, false);
  assert.equal(r.error, "JUDGE_THREW");
});

test("an empty batch costs nothing", async () => {
  let called = false;
  const r = await judgeJobs({ profile: PROFILE, jobs: [] }, async () => { called = true; });
  assert.deepEqual(r, { ok: true, decisions: [] });
  assert.equal(called, false);
});

test("large sets are split into batches, and every job still gets a verdict", async () => {
  const many = Array.from({ length: JUDGE_BATCH_SIZE * 2 + 3 }, (_, i) => ({
    jobId: `adz-${i}`, title: "Registered Nurse", company: "X", location: "Y",
  }));
  let calls = 0;
  const r = await judgeJobs({ profile: PROFILE, jobs: many, threshold: 50 }, async ({ user }) => {
    calls += 1;
    const ids = [...user.matchAll(/"id": "(adz-\d+)"/g)].map((m) => m[1]);
    return { ok: true, content: JSON.stringify({ decisions: ids.map((id) => ({ id, pick: true, score: 70 })) }) };
  });
  assert.equal(calls, 3);
  assert.equal(r.decisions.length, many.length);
  assert.ok(r.decisions.every((d) => d.pick));
});

// ── which OpenAI key the judge uses ──────────────────────────────────
//
// This judge originally read process.env.OPENAI_API_KEY and nothing else,
// which made it the only AI path in the backend that could not fall back to
// the global key operators set from the admin page. Rotating that key fixed
// the summaries, the templates and the extension while API-mode runs kept
// failing on their own, with nothing in the UI to explain why.

import { readFileSync } from "node:fs";

const APIJUDGE_SRC = readFileSync(new URL("../apiJudge.js", import.meta.url), "utf8");

test("the judge falls back to the global key, like every other AI path", () => {
  assert.match(APIJUDGE_SRC, /getAppSettings/,
    "without the settings read there is no fallback to the global key");
  assert.match(APIJUDGE_SRC, /globalOpenaiKey/);
});

test("the call that reaches OpenAI actually goes through that resolution", () => {
  // Defining resolveOpenAIKey and then not calling it is the same bug with
  // more code, so assert on the call site rather than on the helper existing.
  const call = APIJUDGE_SRC.slice(APIJUDGE_SRC.indexOf("async function defaultCallOpenAi"));
  const upToRequest = call.slice(0, call.indexOf("fetch("));
  assert.match(upToRequest, /await resolveOpenAIKey\(\)/,
    "defaultCallOpenAi must resolve the key, not read process.env directly");
  assert.doesNotMatch(upToRequest, /process\.env\.OPENAI_API_KEY/,
    "reading the variable here bypasses the global-key fallback");
});

test("the environment still wins over the global key", () => {
  const body = APIJUDGE_SRC.slice(APIJUDGE_SRC.indexOf("async function resolveOpenAIKey"));
  const envAt = body.indexOf("process.env.OPENAI_API_KEY");
  const dbAt = body.indexOf("globalOpenaiKey");
  assert.ok(envAt !== -1 && dbAt !== -1);
  assert.ok(envAt < dbAt, "a host that sets the variable must keep control of the key");
});

test("a settings lookup that throws does not take the run down with it", () => {
  const body = APIJUDGE_SRC.slice(
    APIJUDGE_SRC.indexOf("async function resolveOpenAIKey"),
    APIJUDGE_SRC.indexOf("async function defaultCallOpenAi"));
  assert.match(body, /catch/, "the global key is a fallback, not a dependency");
});

test("no key anywhere is still reported as NO_OPENAI_KEY, not as a crash", () => {
  assert.match(APIJUDGE_SRC, /NO_OPENAI_KEY/);
});


test("roles typed together in one list entry reach the judge as separate roles", () => {
  const { preferred } = splitRoles(["CAMO Engineer/ Technical Services Engineer/ Supply Chain Analyst/ Analyst/ Buyer"]);
  assert.deepEqual(preferred, ["CAMO Engineer", "Technical Services Engineer", "Supply Chain Analyst", "Analyst", "Buyer"]);
});

test("a slash inside a title is not a role separator", () => {
  assert.deepEqual(splitRoles(["AI/ML Engineer", "Acheteur/Acheteuse"]).preferred, ["AI/ML Engineer", "Acheteur/Acheteuse"]);
  assert.deepEqual(splitRoles(["Nurse | Midwife; Doula"]).preferred, ["Nurse", "Midwife", "Doula"]);
});

test("the judge prompt says titles in another language are judged by meaning", () => {
  assert.match(API_JUDGE_PROMPT, /another language/);
  assert.match(API_JUDGE_PROMPT, /"Acheteur" is Buyer/);
  assert.match(API_JUDGE_PROMPT, /preferredRoles, in any language/);
});

test("a sector the brief prioritises raises the score but never skips other employers", () => {
  assert.match(API_JUDGE_PROMPT, /INDUSTRY OR SECTOR/);
  assert.match(API_JUDGE_PROMPT, /still a PICK, with a lower score/);
});

test("a title that is one of the preferredRoles is a pick by rule", () => {
  assert.match(API_JUDGE_PROMPT, /one of the\s+candidate's preferredRoles or plainly the same work\? Then it is a PICK/);
});

test("European titles get an English gloss for the judge", () => {
  assert.equal(englishGloss("Acheteur projets (H/F)"), "Buyer Projects");
  assert.equal(englishGloss("Acheteur Confirmé H/F"), "Buyer Experienced");
  assert.equal(englishGloss("Analyste Supply Chain - H/F"), "Analyst Supply Chain -");
  assert.equal(englishGloss("Einkäufer (m/w/d)"), "Buyer");
  assert.equal(englishGloss("Stage BAC+4/5 - Supply Chain Analyst"), "Internship BAC+4/5 - Supply Chain Analyst");
  assert.equal(englishGloss("Senior Software Engineer"), "", "an English title gets no gloss");
});

test("the gloss reaches the prompt next to the original title", () => {
  const prompt = buildUserPrompt({ profile: { preferredRoles: ["Buyer"] }, jobs: [
    { jobId: "a", title: "Acheteur projets (H/F)", company: "LGM" },
    { jobId: "b", title: "Buyer", company: "Renault" }] });
  assert.match(prompt, /"titleEnglish": "Buyer Projects"/);
  assert.equal((prompt.match(/titleEnglish/g) || []).length, 1, "only titles that changed get one");
});

test("FTC is defined as a fixed-term contract and deferred to the brief's employment stance", () => {
  assert.match(API_JUDGE_PROMPT, /"FTC" in a title means Fixed-Term Contract/);
  assert.match(API_JUDGE_PROMPT, /Read every one of them as the Contract\s+employment type/);
  // An FTC title the client declines is a contract-term skip, not a role mismatch.
  assert.match(API_JUDGE_PROMPT, /An FTC title is NOT a role-mismatch/);
  assert.match(API_JUDGE_PROMPT, /skip the FTC\s+title with skipKind "excluded"/);
});
