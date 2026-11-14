// Covers Utils/auVisaSponsor.js and Utils/auNoSponsorshipText.js -
// "Australia visa sponsors only" for Australian clients.
//
// What matters:
//   • Home Affairs spellings ("THE TRUSTEE FOR X TRUST", "X PTY. LTD.",
//     "X ATF Y") reduce to the brand a job board uses
//   • job-board names find the sponsor ("Commonwealth Bank" -> "...of Australia")
//   • OCR names with their spaces lost still match ("JudoBankPtyLtd")
//   • look-alikes stay out ("Apple" is not "Apple Tree Childcare")
//   • the posting check catches "full working rights" but not "preferred"
//   • the gate only applies to Australian clients with the switch on, and
//     fails closed when the data is not loaded

import test from "node:test";
import assert from "node:assert/strict";
import {
  auNameKey,
  auNameKeys,
  buildAuSponsorIndex,
  setAuSponsorIndex,
  lookupAuSponsor,
  auSponsorGate,
  auSponsorPushBlock,
} from "../auVisaSponsor.js";
import { detectAuNoSponsorship } from "../auNoSponsorshipText.js";

test("auNameKey strips legal forms and the trust wrapper", () => {
  assert.equal(auNameKey("ATLASSIAN PTY LTD"), "atlassian");
  assert.equal(auNameKey("ZYDEX PTY. LTD."), "zydex");
  assert.equal(auNameKey("Mace Australia Proprietary Limited"), "mace australia");
  assert.equal(auNameKey("THE TRUSTEE FOR THE EAGLE BAY BREWING TRUST"), "eagle bay brewing trust");
  assert.equal(auNameKey("Crawford & Company (AUSTRALIA) Pty Ltd"), "crawford and australia");
  assert.equal(auNameKey("The Group Ltd"), "group");
  assert.equal(auNameKey(""), "");
  assert.equal(auNameKey(null), "");
});

test("auNameKeys splits ATF and T/A names and drops a parenthetical", () => {
  const keys = auNameKeys("ALLEN & OVERY (AUSTRALIA) PTY LIMITED ATF ALLEN & OVERY (AUSTRALIA) DISCRETIONARY TRUST");
  assert.ok(keys.includes("allen and overy"), keys.join(" | "));
  assert.ok(auNameKeys("Smith Holdings Pty Ltd T/A Bondi Coffee").includes("bondi coffee"));
  assert.ok(auNameKeys("Tyreda (Australia) Pty Ltd").includes("tyreda"));
});

const FIXTURE = {
  meta: {
    builtAt: "2026-11-14T00:00:00+00:00",
    sources: {
      LA: { label: "Current labour agreement", asOf: "2026-09-30", sponsors: 1 },
      A25: { label: "Accredited sponsor", asOf: "2025-01-15", sponsors: 3 },
      A24: { label: "Accredited sponsor", asOf: "2024-01-11", sponsors: 1 },
      S23: { label: "Active sponsor", asOf: "2023-09-30", sponsors: 6 },
    },
  },
  rows: [
    ["ATLASSIAN PTY LTD", ["A25", "S23"], []],
    ["COMMONWEALTH BANK OF AUSTRALIA", ["A24", "S23"], []],
    ["JudoBankPtyLtd", ["A25"], []],
    ["MINTERELLISON", ["S23"], []],
    ["APPLE TREE CHILDCARE PTY LTD", ["S23"], []],
    ["NATIONAL AUSTRALIA BANK LIMITED", ["A25", "S23"], []],
    ["Lee Fishing Company Pty Ltd", ["LA"], ["Industry - Fishing"]],
    ["CANVA PTY LTD", ["S23"], []],
    ["AWS SERVICES VIC PTY LTD", ["S23"], []],
    ["AMAZON WEB SERVICES AUSTRALIA PTY LTD", ["A24", "S23"], []],
    ["ASIA PACIFIC GROUP PTY LTD", ["S23"], []],
    ["DEPARTMENT OF EDUCATION", ["A24", "S23"], []],
    ["AIRTRUNK OPERATING PTY LTD", ["A24"], []],
    ["WESTPAC BANKING CORPORATION", ["A24", "S23"], []],
  ],
};

test("lookup: exact, brand + generic words, spaces ignored, alias", () => {
  setAuSponsorIndex(buildAuSponsorIndex(FIXTURE));

  const atl = lookupAuSponsor("Atlassian");
  assert.equal(atl.sponsor, true);
  assert.equal(atl.match, "exact");
  assert.deepEqual(atl.sources, ["A25", "S23"]);
  assert.equal(atl.newestAsOf, "2025-01-15");

  const cba = lookupAuSponsor("Commonwealth Bank");
  assert.equal(cba.sponsor, true);
  assert.equal(cba.match, "prefix");
  assert.equal(cba.name, "COMMONWEALTH BANK OF AUSTRALIA");

  // The job's own generic tail is trimmed too.
  assert.equal(lookupAuSponsor("Canva Australia").sponsor, true);

  const judo = lookupAuSponsor("Judo Bank");
  assert.equal(judo.sponsor, true);
  assert.equal(judo.match, "compact");
  assert.equal(lookupAuSponsor("Minter Ellison").match, "compact");

  const nab = lookupAuSponsor("NAB");
  assert.equal(nab.sponsor, true);
  assert.equal(nab.match, "alias");

  const la = lookupAuSponsor("Lee Fishing Company");
  assert.deepEqual(la.laTypes, ["Industry - Fishing"]);
  assert.equal(la.newestAsOf, "2026-09-30");
});

test("lookup: names job boards use on staging", () => {
  setAuSponsorIndex(buildAuSponsorIndex(FIXTURE));
  // A leading state names the same department.
  assert.equal(lookupAuSponsor("NSW Department of Education").name, "DEPARTMENT OF EDUCATION");
  assert.equal(lookupAuSponsor("AirTrunk").name, "AIRTRUNK OPERATING PTY LTD");
  // The job's own tail is generic too: "Institutional and Business".
  assert.equal(lookupAuSponsor("Westpac Institutional and Business").name, "WESTPAC BANKING CORPORATION");
});

test("lookup: an alias beats a look-alike brand prefix", () => {
  setAuSponsorIndex(buildAuSponsorIndex(FIXTURE));
  const aws = lookupAuSponsor("AWS");
  assert.equal(aws.match, "alias");
  assert.equal(aws.name, "AMAZON WEB SERVICES AUSTRALIA PTY LTD");
});

test("lookup: look-alikes and unknowns stay out", () => {
  setAuSponsorIndex(buildAuSponsorIndex(FIXTURE));
  // "tree childcare" is not generic, so Apple is not Apple Tree Childcare.
  assert.equal(lookupAuSponsor("Apple").sponsor, false);
  assert.equal(lookupAuSponsor("Apple").reason, "NOT_AN_AU_SPONSOR");
  assert.equal(lookupAuSponsor("Canvas Studio").sponsor, false);
  // A name made only of generic words names no brand.
  assert.equal(lookupAuSponsor("Asia Pacific Holdings").sponsor, false);
  assert.equal(lookupAuSponsor("").reason, "NO_COMPANY_NAME");
});

test("posting check: full working rights, citizens only, clearance", () => {
  const rights = detectAuNoSponsorship("<p>About you</p><ul><li>You must have full Australian working rights to apply.</li></ul>");
  assert.equal(rights.refuses, true);
  assert.equal(rights.kind, "WORK_RIGHTS");
  assert.match(rights.quote, /full Australian working rights/);

  assert.equal(detectAuNoSponsorship("This role is open to Australian citizens or permanent residents only.").kind, "CITIZENS_ONLY");
  assert.equal(detectAuNoSponsorship("Applicants must be an Australian citizen.").kind, "CITIZENS_ONLY");
  assert.equal(detectAuNoSponsorship("You must hold a current NV1 clearance.").kind, "CLEARANCE");
  assert.equal(detectAuNoSponsorship("Baseline security clearance is required for this role.").kind, "CLEARANCE");
  assert.equal(detectAuNoSponsorship("Unfortunately we are unable to offer visa sponsorship.").kind, "NO_SPONSORSHIP");
});

test("posting check: soft wording and unrelated words are not refusals", () => {
  for (const jd of [
    "Full working rights preferred but not essential.",
    "Please tell us about your working rights in your application.",
    "Establish a performance baseline for the platform. Strong SQL is required.",
    "We sponsor visas for the right candidate.",
    "",
  ]) {
    assert.equal(detectAuNoSponsorship(jd).refuses, false, jd);
  }
});

const trackingOf = (doc) => ({ findOne: async () => doc });

test("gate: only Australian clients with the switch on", async () => {
  setAuSponsorIndex(buildAuSponsorIndex(FIXTURE));
  const email = "client@example.com";
  const au = trackingOf({ clientCountry: "Australia" });
  assert.equal(await auSponsorGate({ email, profile: { auSponsorOnly: false } }, { collection: au }), null);
  assert.equal(await auSponsorGate({ email, profile: { auSponsorOnly: true } }, { collection: trackingOf({ clientCountry: "USA" }) }), null);
  // AUD payment with no country set counts as Australia.
  assert.ok(await auSponsorGate({ email, profile: { auSponsorOnly: true } }, { collection: trackingOf({ amountPaid: "AUD 1200" }) }));

  const on = { auSponsorOnly: true };
  assert.equal(await auSponsorPushBlock({ email, companyName: "Atlassian", profile: on }, { collection: au }), null);
  const blocked = await auSponsorPushBlock({ email, companyName: "Some Startup", profile: on }, { collection: au });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.error, "NOT_AU_VISA_SPONSOR");
  assert.match(blocked.message, /Some Startup is not on any Home Affairs list/);

  const posting = await auSponsorPushBlock(
    { email, companyName: "Atlassian", jobDescription: "Must have full working rights in Australia.", profile: on },
    { collection: au },
  );
  assert.equal(posting.error, "NOT_AU_VISA_SPONSOR");
  assert.equal(posting.sponsor.reason, "POSTING_WORK_RIGHTS");
  assert.match(posting.message, /approved sponsor, but this posting needs full Australian working rights/);
});
