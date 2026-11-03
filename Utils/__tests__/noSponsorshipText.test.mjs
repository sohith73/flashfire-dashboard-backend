// Covers Utils/noSponsorshipText.js - reading "we cannot sponsor" out of a
// job description, for the "US H-1B sponsors only" gate.
//
// Every sentence here is from a real posting on staging (2026-11-03): the
// refusals from jobs clients removed for "no visa sponsorship", the
// non-refusals from postings that do sponsor. A false hit throws a good job
// away unseen, so the "must not flag" list matters as much as the first.

import test from "node:test";
import assert from "node:assert/strict";
import { detectNoSponsorship } from "../noSponsorshipText.js";

const REFUSALS = [
  ["This role does not offer visa sponsorship.", "NO_SPONSORSHIP"],
  ["Unfortunately, we are unable to sponsor or assume sponsorship of employment visas at this time.", "NO_SPONSORSHIP"],
  ["We will not consider any applicants that require sponsorship for employment visa status either now or in the future.", "NO_SPONSORSHIP"],
  ["Must be legally authorized to work in the United States without the need for employer sponsorship", "NO_SPONSORSHIP"],
  ["Individual(s) must be legally authorized to work in the United States without the need for immigration support or sponsorship from Milliman now or in the future", "NO_SPONSORSHIP"],
  ["Please note: This role is not eligible for visa sponsorship", "NO_SPONSORSHIP"],
  ["Visa sponsorship is not available for this position", "NO_SPONSORSHIP"],
  ["Eligible for sponsorship: No The salary range for this role is $90,000-$105,000 USD annually.", "NO_SPONSORSHIP"],
  ["Visa Sponsorship Available: No", "NO_SPONSORSHIP"],
  ["At this time, Capital One will not sponsor a new applicant for employment authorization for this position.", "NO_SPONSORSHIP"],
  ["Applicants must be authorized to work for any employer in the U.S", "NO_SPONSORSHIP"],
  ["Must be legally authorized to work in the US on a permanent basis without company sponsorship", "NO_SPONSORSHIP"],
  ["applications from candidates who require current or future sponsorship to work in the US cannot be considered", "NO_SPONSORSHIP"],
  ["Qualified applicants must not require employer sponsored work authorization now or in the future", "NO_SPONSORSHIP"],
  ["• Must be a U.S. Citizen and pass the DHS background check", "CITIZENS_ONLY"],
  ["• US Citizenship Required", "CITIZENS_ONLY"],
  ["• US Citizen or Green Card • Ability to obtain a Public Trust clearance", "CITIZENS_ONLY"],
  ["candidate must be a U.S. Person, which is defined as a U.S. citizen, a U.S. permanent resident", "CITIZENS_ONLY"],
  ["• Active Secret security clearance is required", "CLEARANCE"],
  ["• Must have current active U.S Government security clearance at the Secret level", "CLEARANCE"],
];

const NOT_REFUSALS = [
  "H1B sponsorship is available for this position.",
  "While Etsy supports visa sponsorship, sponsorship opportunities may be limited to certain roles and skills.",
  "We are open to sponsoring visas for exceptional candidates who are currently based in the U.S.",
  "Visa: Available (Tutor Intelligence will sponsor visas.)",
  "Will you now or in the future require sponsorship for employment visa status (e.g., H-1B)?",
  "Will you now, or in the future, require sponsorship to work in the United States?",
  "A company-sponsored pension plan and 401(k) with matching employer contribution",
  "Federal Home Loan Bank of Chicago is a government-sponsored bank.",
  "Department of Defense Secret security clearance is preferred at time of hire",
  "Ability to obtain and maintain a Public Trust clearance.",
  "We consider all applicants without regard to race, religion, citizenship or national origin.",
  "",
];

test("refusals are found, with the right kind", () => {
  for (const [text, kind] of REFUSALS) {
    const r = detectNoSponsorship(text);
    assert.equal(r.refuses, true, text);
    assert.equal(r.kind, kind, text);
    assert.ok(r.quote && r.quote.length <= 240, text);
  }
});

test("postings that sponsor, ask, or just mention sponsors are not refusals", () => {
  for (const text of NOT_REFUSALS) assert.equal(detectNoSponsorship(text).refuses, false, text);
  assert.equal(detectNoSponsorship(null).refuses, false);
  assert.equal(detectNoSponsorship(undefined).refuses, false);
});

test("HTML, escaped HTML and bullets do not hide a refusal", () => {
  const html = "<ul><li>Strong SQL</li><li>We are <b>unable to sponsor</b> visas</li></ul>";
  assert.equal(detectNoSponsorship(html).kind, "NO_SPONSORSHIP");
  const escaped = "&lt;span&gt;Authorized to work in the US, with no need for visa sponsorship&lt;/span&gt;";
  assert.equal(detectNoSponsorship(escaped).kind, "NO_SPONSORSHIP");
});

test("the quote is the sentence that refused, not the bullet before it", () => {
  const jd = "• Comfortable multitasking without diminished quality of work • Applicants must be authorized to work in the U.S. without the need for employer sponsorship • Nice to have: Python";
  const r = detectNoSponsorship(jd);
  assert.equal(r.quote, "Applicants must be authorized to work in the U.S. without the need for employer sponsorship");
});
