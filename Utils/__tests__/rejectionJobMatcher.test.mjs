// The rejection -> job matcher. Pure: no Mongo, no network.
//
// Every "matched" below is a card that would be moved to Rejected on a client's
// board, so the "must NOT match" cases matter more than the matching ones.

import { test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

const { matchRejectionToJob, companyTokens, titleTokens, titleSimilarity, extractMailFacts, senderDomainLabels } = await import(
  "../rejectionJobMatcher.js"
);

const MAIL_DATE = "2026-11-10T12:00:00.000Z";
// ObjectId whose timestamp is 2026-10-01, i.e. before MAIL_DATE.
const oid = (iso = "2026-10-01T00:00:00.000Z") => new mongoose.Types.ObjectId(Math.floor(new Date(iso).getTime() / 1000));

let n = 0;
const job = (companyName, jobTitle, currentStatus = "applied by Rajdeep", extra = {}) => ({
  _id: oid(),
  jobID: `job-${++n}`,
  companyName,
  jobTitle,
  currentStatus,
  appliedDate: "5/10/2026, 10:00:00 am",
  updatedAt: "5/10/2026, 10:00:00 am",
  ...extra
});
const mail = (o) => ({ date: MAIL_DATE, summary: "", snippet: "", urls: [], ...o });

// -- normalisation -------------------------------------------------------

test("company names drop case, punctuation, legal suffixes and a leading 'the'", () => {
  assert.deepEqual(companyTokens("The Acme Corp., Inc."), ["acme"]);
  assert.deepEqual(companyTokens("ACME LLC"), ["acme"]);
  assert.deepEqual(companyTokens("Hearth &amp; Home Technologies, LLC"), ["hearth", "and", "home", "technologies"]);
  assert.deepEqual(companyTokens("Siemens GmbH"), ["siemens"]);
  assert.deepEqual(companyTokens("Inc"), ["inc"], "a name that is only a suffix is kept");
});

test("titles normalise abbreviations, levels and noise", () => {
  assert.deepEqual(titleTokens("Sr. SW Eng (Remote)"), ["senior", "software", "engineer"]);
  assert.deepEqual(titleTokens("Software Engineers II"), ["software", "engineer", "2"]);
  assert.equal(titleSimilarity("Sr. Software Engineer", "Senior Software Engineer"), 1);
  assert.ok(titleSimilarity("Software Engineer", "Senior Software Engineer") < 0.9, "seniority clash is penalised");
  assert.ok(titleSimilarity("Senior Financial Data Analyst", "Senior Sales Data Analyst") < 0.9);
});

test("sender domain labels skip ATS hosts and read careers URLs", () => {
  assert.deepEqual(senderDomainLabels({ from: "Acme <no-reply@careers.acme.com>" }), ["acme"]);
  assert.deepEqual(senderDomainLabels({ from: "x@us.greenhouse-mail.io" }), []);
  assert.deepEqual(senderDomainLabels({ from: "acme@myworkday.com", urls: ["https://acme.wd5.myworkdayjobs.com/en-US/ext"] }), ["acme"]);
  assert.deepEqual(senderDomainLabels({ from: "a@hire.lever.co", urls: ["https://jobs.lever.co/globex/123"] }), ["globex"]);
});

test("facts: company and role come from the verifier first, then sender/subject/summary", () => {
  const f = extractMailFacts({
    from: '"Sodalis, Inc. Hiring Team" <no-reply@ashbyhq.com>',
    subject: "Sodalis, Inc. Application Update",
    summary: "Thank you for applying for the Sr. ML Engineer, Clinical Automation role at Sodalis, Inc.. After reviewing"
  });
  assert.equal(f.jobTitle, "Sr. ML Engineer, Clinical Automation");
  assert.ok(f.companies.some((c) => c.name.startsWith("Sodalis")));
  const v = extractMailFacts({ from: "x@y.com", subject: "s", company: "Acme", jobTitle: "Data Analyst" });
  assert.equal(v.jobTitle, "Data Analyst");
  assert.equal(v.companies[0].source, "verifier");
});

// -- matching: the happy paths ---------------------------------------------

test("ATS sender (Ashby): company from the display name, role from the summary", () => {
  const jobs = [job("Sodalis", "Sr. ML Engineer, Clinical Automation"), job("Other Co", "Engineer")];
  const r = matchRejectionToJob(
    mail({
      from: '"Sodalis, Inc. Hiring Team" <no-reply@ashbyhq.com>',
      subject: "Sodalis, Inc. Application Update",
      summary: "Thank you for applying for the Sr. ML Engineer, Clinical Automation role at Sodalis, Inc.. After reviewing your application"
    }),
    jobs
  );
  assert.equal(r.status, "matched");
  assert.equal(r.jobId, jobs[0].jobID);
});

test("ATS sender (Greenhouse): company only in the subject, one job there", () => {
  const jobs = [job("FNS Customs Brokers", "Planning & Operations Innovation Specialist I")];
  const r = matchRejectionToJob(
    mail({
      from: "no-reply@us.greenhouse-mail.io",
      subject: "Update on your Planning & Operations Innovation Specialist I application at FNS Customs Brokers, Inc."
    }),
    jobs
  );
  assert.equal(r.status, "matched");
});

test("Workday sender: company on the subdomain of a careers URL", () => {
  const jobs = [job("ACCIONA", "Graduate Engineer, Electrical")];
  const r = matchRejectionToJob(
    mail({
      from: "Workday Communication <noreply@myworkday.com>",
      subject: "Thank you for applying",
      summary: "Thank you for applying for the Graduate Engineer, Electrical role in Perth. We regret to inform you",
      urls: ["https://acciona.wd3.myworkdayjobs.com/en-US/careers"]
    }),
    jobs
  );
  assert.equal(r.status, "matched");
  assert.match(r.reason, /acciona/i);
});

test("company with a legal suffix on one side only still matches", () => {
  const jobs = [job("Hearth & Home Technologies", "Financial Analyst")];
  const r = matchRejectionToJob(
    mail({
      from: '"Hearth & Home Technologies, LLC Recruiting Team" <no-reply@jobvite.com>',
      subject: "Your application for Financial Analyst at Hearth & Home Technologies, LLC"
    }),
    jobs
  );
  assert.equal(r.status, "matched");
});

test("several jobs at the company: the role picks exactly one", () => {
  const jobs = [
    job("Affirm", "Software Engineer II, Backend (Merchant Advocacy)"),
    job("Affirm", "Senior Software Engineer, Backend (Growth Platform)"),
    job("Affirm", "Data Analyst")
  ];
  const r = matchRejectionToJob(
    mail({
      from: "Affirm <no-reply@affirm.com>",
      subject: "Your Application to Affirm",
      summary: "Thank you for applying for the Senior Software Engineer, Backend (Growth Platform) role at Affirm."
    }),
    jobs
  );
  assert.equal(r.status, "matched");
  assert.equal(r.jobId, jobs[1].jobID);
});

test("verifier-supplied company and title are used", () => {
  const jobs = [job("Globex", "Platform Engineer"), job("Globex", "Data Engineer")];
  const r = matchRejectionToJob(
    mail({ from: "a@hire.lever.co", subject: "Update", company: "Globex Corporation", jobTitle: "Data Engineer" }),
    jobs
  );
  assert.equal(r.status, "matched");
  assert.equal(r.jobId, jobs[1].jobID);
});

test("an interview-stage card can be rejected", () => {
  const jobs = [job("Initech", "Backend Engineer", "interviewing by Ops")];
  const r = matchRejectionToJob(mail({ from: "Initech <jobs@initech.com>", subject: "Your Initech application" }), jobs);
  assert.equal(r.status, "matched");
});

// -- matching: must NOT move anything ---------------------------------------

test("no role in the mail and several jobs at the company: ambiguous", () => {
  const jobs = [job("Ramp", "Applied AI Engineer"), job("Ramp", "Software Engineer, Growth Platform")];
  const r = matchRejectionToJob(mail({ from: "Ramp <no-reply@ramp.com>", subject: "Update on your application to Ramp" }), jobs);
  assert.equal(r.status, "ambiguous");
  assert.equal(r.jobId, null);
  assert.equal(r.candidates.length, 2);
});

test("two identical postings at the company: ambiguous, never a coin flip", () => {
  const jobs = [job("Cape", "Software Engineer"), job("Cape", "Software Engineer")];
  const r = matchRejectionToJob(
    mail({ from: "Cape Hiring Team <x@ashbyhq.com>", subject: "Cape | Application Follow Up", summary: "Thank you for applying for the Software Engineer role at Cape." }),
    jobs
  );
  assert.equal(r.status, "ambiguous");
});

test("similar-looking company: 'Cape Analytics' mail must not reject a 'Cape' card", () => {
  const jobs = [job("Cape", "Software Engineer")];
  const r = matchRejectionToJob(
    mail({
      from: '"Cape Analytics Hiring Team" <x@ashbyhq.com>',
      subject: "Cape Analytics Application Update",
      summary: "Thank you for applying for the Software Engineer role at Cape Analytics."
    }),
    jobs
  );
  assert.equal(r.status, "matched", "role + a shorter relative of the name is weak evidence that the role confirms");
  // ...but with a different role it is nothing:
  const r2 = matchRejectionToJob(
    mail({
      from: '"Cape Analytics Hiring Team" <x@ashbyhq.com>',
      subject: "Cape Analytics Application Update",
      summary: "Thank you for applying for the Head of Sales role at Cape Analytics."
    }),
    jobs
  );
  assert.equal(r2.status, "no_match");
  // and with no role at all the weak match is not enough:
  const r3 = matchRejectionToJob(mail({ from: '"Cape Analytics Hiring Team" <x@ashbyhq.com>', subject: "Cape Analytics Application Update" }), jobs);
  assert.notEqual(r3.status, "matched");
});

test("a different company never matches on a shared word in the body", () => {
  const jobs = [job("Square", "Software Engineer")];
  const r = matchRejectionToJob(
    mail({
      from: "Nimbus Careers <no-reply@nimbus.com>",
      subject: "Your application to Nimbus",
      summary: "We were looking for a different shape, not a square fit. Thank you for applying for the Software Engineer role at Nimbus."
    }),
    jobs
  );
  assert.equal(r.status, "no_match");
});

test("the mail names a different role at the same company: no match", () => {
  const jobs = [job("Qualtrics", "Technical Program Manager - Public Sector")];
  const r = matchRejectionToJob(
    mail({
      from: "Qualtrics <no-reply@qualtrics.com>",
      subject: "Regarding Your Application with Qualtrics",
      summary: "Thank you for your interest in Qualtrics and the Technical Customer Manager - Public Sector position."
    }),
    jobs
  );
  assert.equal(r.status, "no_match");
  assert.match(r.reason, /role/);
});

test("seniority clash: 'Senior X' mail does not reject plain 'X'", () => {
  const jobs = [job("H2O.ai", "AI Engineer")];
  const r = matchRejectionToJob(
    mail({ from: "H2O.ai <x@h2o.ai>", subject: "H2O.ai application update", summary: "Thank you for your interest in H2O.ai and our Senior AI Engineer." }),
    jobs
  );
  assert.equal(r.status, "no_match");
});

test("only applied or interview cards are candidates", () => {
  for (const status of ["saved by Rajdeep", "offer by Ops", "interview - offer pending", "removed by AI", "deleted by user", "rejected by Rajdeep", "rejected by Mail"]) {
    const r = matchRejectionToJob(
      mail({ from: "Acme <x@acme.com>", subject: "Your application to Acme", summary: "Thank you for applying for the Data Analyst role at Acme." }),
      [job("Acme", "Data Analyst", status)]
    );
    assert.notEqual(r.status, "matched", status);
  }
});

test("a card applied after the mail arrived is not a candidate", () => {
  const late = job("Acme", "Data Analyst", "applied by Ops", { _id: oid("2026-11-15T00:00:00.000Z"), appliedDate: "15/11/2026, 10:00:00 am" });
  const r = matchRejectionToJob(
    mail({ from: "Acme <x@acme.com>", subject: "Your application to Acme", summary: "Thank you for applying for the Data Analyst role at Acme." }),
    [late]
  );
  assert.equal(r.status, "no_match");
});

test("a second mail from the same employer does not fall through to the client's other job", () => {
  const first = job("Acme", "Data Analyst", "rejected by Mail", { updatedAt: "9/11/2026, 10:00:00 am" });
  const other = job("Acme", "Product Manager");
  const r = matchRejectionToJob(mail({ from: "Acme <x@acme.com>", subject: "Update on your application to Acme" }), [first, other]);
  assert.equal(r.status, "ambiguous");
  assert.match(r.reason, /rejected within 7 days/);
});

test("sender domain alone is not enough when the verifier named another company", () => {
  const jobs = [job("Abcam", "Product Manager")];
  const r = matchRejectionToJob(
    mail({ from: "Careers <no-reply@abcam.com>", subject: "Update", company: "Danaher", jobTitle: "Product Manager" }),
    jobs
  );
  assert.equal(r.status, "no_match");
});

test("ATS domains are never company evidence", () => {
  const jobs = [job("Greenhouse", "Engineer"), job("Lever", "Engineer")];
  const r = matchRejectionToJob(mail({ from: "x@us.greenhouse-mail.io", subject: "Update on your application" }), jobs);
  assert.equal(r.status, "no_match");
});

test("empty inputs are safe", () => {
  assert.equal(matchRejectionToJob(mail({}), []).status, "no_match");
  assert.equal(matchRejectionToJob(undefined, undefined).status, "no_match");
  assert.equal(matchRejectionToJob(mail({ subject: "x" }), [job("Acme", "Engineer")]).status, "no_match");
});
