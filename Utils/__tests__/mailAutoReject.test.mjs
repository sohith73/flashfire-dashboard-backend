// Auto-reject orchestration: gate, kill switch, idempotent claim, atomic apply,
// fail-soft. Model methods are swapped in place (no mongod needed), and the
// pipeline wiring is checked from source like rejectionAlerts.test.mjs does.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { JobModel } = await import("../../Schema_Models/JobModel.js");
const { MailDigest } = await import("../../Schema_Models/MailDigest.js");
const { ClientReminderConfig } = await import("../../Schema_Models/ClientReminderConfig.js");
const { autoRejectForDigest, autoRejectGate, isAutoRejectEnabled, isClientAutoRejectOn, AUTO_REJECT_STATUS } = await import(
  "../../src/services/mailAutoReject.js"
);

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const oid = () => new mongoose.Types.ObjectId(Math.floor(new Date("2026-10-01").getTime() / 1000));

const digest = (o = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  ownerEmail: "client@example.com",
  category: "rejection",
  verifyRan: true,
  verifyGenuine: true,
  verifyCategory: "rejection",
  verifyConfidence: "high",
  autoRejectStatus: "",
  from: "Acme Careers <no-reply@acme.com>",
  subject: "Your application to Acme",
  summary: "Thank you for applying for the Data Analyst role at Acme. We will not be moving forward.",
  snippet: "",
  urls: [],
  date: new Date("2026-11-10T12:00:00Z"),
  ...o
});
const acmeJob = (o = {}) => ({
  _id: oid(), jobID: "j1", companyName: "Acme", jobTitle: "Data Analyst",
  currentStatus: "applied by Rajdeep", appliedDate: "5/10/2026, 10:00:00 am", updatedAt: "5/10/2026, 10:00:00 am", ...o
});

let digestWrites, jobWrites, claimResult, jobResult, saved, toggleQueries, clientToggle;
beforeEach(() => {
  digestWrites = [];
  jobWrites = [];
  claimResult = { modifiedCount: 1 };
  jobResult = { modifiedCount: 1 };
  saved = { find: JobModel.find, jobUpdate: JobModel.updateOne, digestUpdate: MailDigest.updateOne, clientFind: ClientReminderConfig.findOne, env: process.env.MAIL_AUTO_REJECT };
  // Every existing test runs with the client switched ON; the toggle tests flip it.
  toggleQueries = [];
  clientToggle = () => ({ _id: "c1" });
  ClientReminderConfig.findOne = (filter) => {
    toggleQueries.push(filter);
    const chain = { select: () => chain, lean: async () => clientToggle(filter) };
    return chain;
  };
  delete process.env.MAIL_AUTO_REJECT;
  JobModel.updateOne = async (filter, update) => { jobWrites.push({ filter, update }); return jobResult; };
  MailDigest.updateOne = async (filter, update) => {
    digestWrites.push({ filter, update });
    return update.$set?.autoRejectStatus === "claimed" ? claimResult : { modifiedCount: 1 };
  };
});
afterEach(() => {
  JobModel.find = saved.find;
  JobModel.updateOne = saved.jobUpdate;
  MailDigest.updateOne = saved.digestUpdate;
  ClientReminderConfig.findOne = saved.clientFind;
  if (saved.env === undefined) delete process.env.MAIL_AUTO_REJECT; else process.env.MAIL_AUTO_REJECT = saved.env;
});

test("gate: only verified genuine, non-low-confidence rejections qualify", () => {
  assert.equal(autoRejectGate(digest()).ok, true);
  assert.equal(autoRejectGate(digest({ verifyConfidence: "medium" })).ok, true);
  assert.equal(autoRejectGate(digest({ verifyConfidence: "low" })).ok, false);
  assert.equal(autoRejectGate(digest({ verifyConfidence: "" })).ok, false);
  assert.equal(autoRejectGate(digest({ verifyGenuine: false })).ok, false);
  assert.equal(autoRejectGate(digest({ verifyRan: false })).ok, false);
  assert.equal(autoRejectGate(digest({ category: "interview" })).ok, false);
  assert.equal(autoRejectGate(digest({ ownerEmail: "" })).ok, false);
});

test("kill switch: MAIL_AUTO_REJECT=off disables, anything else leaves it on", () => {
  assert.equal(isAutoRejectEnabled({}), true);
  assert.equal(isAutoRejectEnabled({ MAIL_AUTO_REJECT: "on" }), true);
  for (const v of ["off", "OFF", "0", "false", "no", "disabled"]) assert.equal(isAutoRejectEnabled({ MAIL_AUTO_REJECT: v }), false, v);
});

test("a matching rejection claims the digest, moves the card atomically and records it", async () => {
  const r = await autoRejectForDigest(digest(), { jobs: [acmeJob()] });
  assert.equal(r.outcome, "applied");

  assert.equal(jobWrites.length, 1);
  const { filter, update } = jobWrites[0];
  assert.deepEqual(filter, { jobID: "j1", userID: "client@example.com", currentStatus: "applied by Rajdeep" }, "re-checks the status it read");
  assert.equal(update.$set.currentStatus, AUTO_REJECT_STATUS);
  assert.equal(AUTO_REJECT_STATUS, "rejected by Mail");
  assert.deepEqual(update.$push, { timeline: AUTO_REJECT_STATUS });
  assert.match(update.$set.updatedAt, /\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2} (am|pm)/, "en-IN locale string like the other writers");

  assert.equal(digestWrites[0].update.$set.autoRejectStatus, "claimed", "claim comes first");
  const last = digestWrites.at(-1).update.$set;
  assert.equal(last.autoRejectStatus, "applied");
  assert.equal(last.autoRejectJobId, "j1");
  assert.equal(last.autoRejectPreviousStatus, "applied by Rajdeep");
  assert.ok(last.autoRejectAt instanceof Date);
});

test("idempotent: a digest that was already handled is never applied again", async () => {
  const handled = await autoRejectForDigest(digest({ autoRejectStatus: "applied" }), { jobs: [acmeJob()] });
  assert.equal(handled.outcome, "already_handled");
  assert.equal(jobWrites.length + digestWrites.length, 0);

  claimResult = { modifiedCount: 0 }; // a racing worker won the claim
  const lost = await autoRejectForDigest(digest(), { jobs: [acmeJob()] });
  assert.equal(lost.outcome, "already_handled");
  assert.equal(jobWrites.length, 0, "the loser must not touch the card");
});

test("the card changed under us: nothing is written to it and the digest says so", async () => {
  jobResult = { modifiedCount: 0 };
  const r = await autoRejectForDigest(digest(), { jobs: [acmeJob()] });
  assert.equal(r.outcome, "skipped");
  assert.equal(digestWrites.at(-1).update.$set.autoRejectStatus, "skipped");
});

test("ambiguous and no_match are recorded on the digest and move nothing", async () => {
  const amb = await autoRejectForDigest(digest({ summary: "", subject: "Your application to Acme" }), {
    jobs: [acmeJob(), acmeJob({ jobID: "j2", jobTitle: "Product Manager" })]
  });
  assert.equal(amb.outcome, "ambiguous");
  assert.equal(digestWrites.at(-1).update.$set.autoRejectStatus, "ambiguous");

  const none = await autoRejectForDigest(digest(), { jobs: [acmeJob({ companyName: "Globex" })] });
  assert.equal(none.outcome, "no_match");
  assert.equal(jobWrites.length, 0);
});

test("dry run writes nothing at all", async () => {
  const r = await autoRejectForDigest(digest(), { jobs: [acmeJob()], dryRun: true });
  assert.equal(r.outcome, "matched");
  assert.equal(jobWrites.length + digestWrites.length, 0);
});

test("kill switch and gate short-circuit before any read or write", async () => {
  process.env.MAIL_AUTO_REJECT = "off";
  assert.equal((await autoRejectForDigest(digest(), { jobs: [acmeJob()] })).outcome, "skipped");
  delete process.env.MAIL_AUTO_REJECT;
  assert.equal((await autoRejectForDigest(digest({ verifyConfidence: "low" }), { jobs: [acmeJob()] })).outcome, "skipped");
  assert.equal(jobWrites.length + digestWrites.length, 0);
});

test("client toggle: OFF by default, nothing is claimed or moved", async () => {
  clientToggle = () => null; // no config with mailAutoRejectEnabled: true
  const r = await autoRejectForDigest(digest(), { jobs: [acmeJob()] });
  assert.equal(r.outcome, "client_off");
  assert.equal(jobWrites.length + digestWrites.length, 0, "the digest stays unclaimed for a later backfill");
  assert.deepEqual(toggleQueries[0], { clientEmail: "client@example.com", mailAutoRejectEnabled: true });
});

test("client toggle: owner email is matched lowercased; only === true counts", async () => {
  await isClientAutoRejectOn("  Client@Example.COM ");
  assert.deepEqual(toggleQueries.at(-1), { clientEmail: "client@example.com", mailAutoRejectEnabled: true });
  assert.equal(await isClientAutoRejectOn(""), false);
});

test("client toggle: a lookup error fails closed and records nothing", async () => {
  clientToggle = () => { throw new Error("mongo down"); };
  const r = await autoRejectForDigest(digest(), { jobs: [acmeJob()] });
  assert.equal(r.outcome, "client_off");
  assert.equal(jobWrites.length + digestWrites.length, 0);
});

test("client toggle: a pre-read clientOn skips the lookup (backfill path)", async () => {
  const off = await autoRejectForDigest(digest(), { jobs: [acmeJob()], clientOn: false });
  assert.equal(off.outcome, "client_off");
  const on = await autoRejectForDigest(digest(), { jobs: [acmeJob()], clientOn: true });
  assert.equal(on.outcome, "applied");
  assert.equal(toggleQueries.length, 0);
});

test("config: mailAutoRejectEnabled is off unless stored exactly true", async () => {
  const { mergeWithDefaults } = await import("../../Schema_Models/ClientReminderConfig.js");
  assert.equal(mergeWithDefaults(null).mailAutoRejectEnabled, false);
  assert.equal(mergeWithDefaults({ mailAutoRejectEnabled: "true" }).mailAutoRejectEnabled, false);
  assert.equal(mergeWithDefaults({ mailAutoRejectEnabled: true }).mailAutoRejectEnabled, true);
  assert.equal(new ClientReminderConfig({ clientEmail: "a@b.com" }).mailAutoRejectEnabled, false);
});

test("operations PUT: writes mailAutoRejectEnabled only when sent, strictly as a boolean", () => {
  const ctl = read("../../Controllers/operations/ClientReminders.js");
  assert.match(ctl, /set\.mailAutoRejectEnabled = mailAutoRejectEnabled === true/);
  assert.match(ctl, /if \(mailAutoRejectEnabled !== undefined\)/);
});

test("fail-soft: a database error is returned and recorded, never thrown", async () => {
  JobModel.find = () => { throw new Error("mongo down"); };
  const r = await autoRejectForDigest(digest());
  assert.equal(r.outcome, "error");
  assert.match(r.reason, /mongo down/);
  assert.equal(digestWrites.at(-1).update.$set.autoRejectStatus, "error");
  assert.equal(jobWrites.length, 0);
});

// -- pipeline wiring -------------------------------------------------------

test("pipeline: the rejection branch still notifies nobody", () => {
  const worker = read("../../src/services/mailPollWorker.js");
  const from = worker.indexOf('} else if (ai.category === "rejection") {');
  const branch = worker.slice(from, worker.indexOf("const uploadedNames", from));
  assert.match(branch, /clientNotifyEligible: false/);
  assert.match(branch, /opsNotifyEligible: false/);
  assert.match(branch, /rejection_recorded_only/);
  assert.equal(/clientNotifyEligible: true|opsNotifyEligible: true/.test(branch), false);
  assert.match(branch, /verifyCompany: verdict\.company/, "the verifier's employer and role are stored for the matcher");
});

test("pipeline: auto-reject runs after the digest is claimed, only for rejections, and sends nothing", () => {
  const worker = read("../../src/services/mailPollWorker.js");
  const create = worker.indexOf("digestDoc = await MailDigest.create(doc)");
  const call = worker.indexOf("autoRejectForDigest(digestDoc)");
  assert.ok(create > -1 && call > create, "needs the stored digest (audit + idempotency claim)");
  const around = worker.slice(call - 120, call + 200);
  assert.match(around, /category === "rejection"/);
  const block = worker.slice(worker.lastIndexOf("if (digestDoc.category", call), worker.indexOf("Discord update ONLY"));
  assert.equal(/deliver\(|notifyClientForDigest|notifyUsefulMailLine/.test(block), false, "moving a card must not notify anyone");
});

test("verifier: the rejection prompt asks for company and jobTitle; the milestone prompt does not", () => {
  const v = read("../../src/services/mailMilestoneVerifier.js");
  const rejection = v.slice(v.indexOf("const REJECTION_SYSTEM_PROMPT"), v.indexOf("function clamp"));
  assert.match(rejection, /"company":/);
  assert.match(rejection, /"jobTitle":/);
  const milestone = v.slice(v.indexOf("const SYSTEM_PROMPT"), v.indexOf("const REJECTION_SYSTEM_PROMPT"));
  assert.equal(/"company":/.test(milestone), false);
});
