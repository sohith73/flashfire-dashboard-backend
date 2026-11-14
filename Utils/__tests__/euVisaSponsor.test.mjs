// Covers Utils/euVisaSponsor.js and Utils/euNoSponsorshipText.js -
// "Europe visa sponsors only" for Europe clients.
//
// What matters:
//   • the job's location picks the list: NL -> IND register, IE -> permit holders
//   • a job elsewhere in Europe (no list) is not refused on the employer
//   • Dutch and Irish legal forms reduce to the brand ("Koninklijke Philips N.V.")
//   • the posting check catches "right to work in the EU" and "Stamp 4"
//   • the gate only applies to Europe clients with the switch on

import test from "node:test";
import assert from "node:assert/strict";
import {
  euNameKeys,
  buildEuSponsorIndex,
  setEuSponsorIndex,
  lookupEuSponsor,
  euSponsorPushBlock,
  listCountriesOf,
} from "../euVisaSponsor.js";
import { detectEuNoSponsorship } from "../euNoSponsorshipText.js";

const FIXTURE = {
  meta: { builtAt: "2026-11-14T00:00:00+00:00", countries: { NL: { asOf: "2026-11-03" }, IE: { asOf: "2026-10" } } },
  rows: [
    ["Booking.com B.V.", "NL", "31047344", {}],
    ["Koninklijke Philips N.V.", "NL", "17001910", {}],
    ["Google Netherlands B.V.", "NL", "34198589", {}],
    ["Google Ireland Limited", "IE", null, { 2025: 368, 2026: 270 }],
    ["Google Cloud EMEA Limited", "IE", null, { 2025: 17, 2026: 22 }],
    ["Stripe Technology Company Limited", "IE", null, { 2025: 34, 2026: 63 }],
    ["Meta Platforms Ireland Limited", "IE", null, { 2025: 83, 2026: 44 }],
  ],
};

test("keys drop Dutch and Irish legal forms", () => {
  assert.ok(euNameKeys("Koninklijke Philips N.V.").includes("philips"));
  assert.ok(euNameKeys("Booking.com B.V.").includes("bookingcom"));
  assert.ok(euNameKeys("Stripe Technology Company Limited").includes("stripe technology"));
});

test("the job's location picks the country", () => {
  assert.deepEqual(listCountriesOf("Amsterdam, Netherlands").listed, ["NL"]);
  assert.deepEqual(listCountriesOf("Dublin").listed, ["IE"]);
  assert.deepEqual(listCountriesOf("Munich, Germany").listed, []);
  assert.deepEqual(listCountriesOf("Belfast, Northern Ireland").listed, [], "Northern Ireland is the UK");
  // Towns the shared parser does not know still count for NL and IE.
  assert.deepEqual(listCountriesOf("Delft").listed, ["NL"]);
  assert.deepEqual(listCountriesOf("Galway or Limerick").listed, ["IE"]);
  assert.deepEqual(listCountriesOf("Munich or Cologne").listed, []);
});

test("NL jobs need the IND register, IE jobs need permits", () => {
  setEuSponsorIndex(buildEuSponsorIndex(FIXTURE));
  const booking = lookupEuSponsor("Booking.com", "Amsterdam, Netherlands");
  assert.equal(booking.sponsor, true);
  assert.equal(booking.basis, "LISTED");
  assert.equal(booking.country, "NL");
  assert.equal(lookupEuSponsor("Philips", "Eindhoven").name, "Koninklijke Philips N.V.");

  const google = lookupEuSponsor("Google", "Dublin, Ireland");
  assert.equal(google.name, "Google Ireland Limited", "the employer with the most permits wins");
  assert.equal(lookupEuSponsor("Meta", "Dublin").match, "alias");

  const nl = lookupEuSponsor("Tiny Startup", "Amsterdam");
  assert.equal(nl.sponsor, false);
  assert.equal(nl.reason, "NOT_IND_RECOGNISED_SPONSOR");
  // Stripe sponsors in Ireland, not in the Netherlands.
  assert.equal(lookupEuSponsor("Stripe", "Amsterdam").sponsor, false);
  assert.equal(lookupEuSponsor("Tiny Startup", "Cork, Ireland").reason, "NO_IRISH_PERMITS");

  // A job in both places passes if either does.
  assert.equal(lookupEuSponsor("Stripe", "Amsterdam or Dublin").sponsor, true);
});

test("a job where no list exists is not refused on the employer", () => {
  setEuSponsorIndex(buildEuSponsorIndex(FIXTURE));
  const de = lookupEuSponsor("Siemens", "Munich, Germany");
  assert.equal(de.sponsor, true);
  assert.equal(de.basis, "NO_LIST");
  assert.equal(lookupEuSponsor("Siemens", "").basis, "NO_LIST");
  assert.equal(lookupEuSponsor("", "Amsterdam").reason, "NO_COMPANY_NAME");
});

test("posting check: EU right to work, Stamp 4, citizens only", () => {
  assert.equal(detectEuNoSponsorship("Requirements: You must have the right to work in the EU.").kind, "WORK_RIGHTS");
  assert.equal(detectEuNoSponsorship("Candidates must already have the right to work in the Netherlands.").kind, "WORK_RIGHTS");
  assert.equal(detectEuNoSponsorship("A valid EU work permit is required.").kind, "WORK_RIGHTS");
  assert.equal(detectEuNoSponsorship("Applicants must hold Stamp 4 or be an EU national.").refuses, true);
  assert.equal(detectEuNoSponsorship("This role is open to EU citizens only.").kind, "CITIZENS_ONLY");
  assert.equal(detectEuNoSponsorship("Unfortunately we cannot offer visa sponsorship.").kind, "NO_SPONSORSHIP");
});

test("posting check: soft or welcoming wording is not a refusal", () => {
  for (const jd of [
    "Right to work in the EU is preferred but we can help.",
    "Please confirm your right to work in Ireland when you apply.",
    "We welcome EU and non-EU nationals and sponsor work permits.",
    "Our customers include EU citizens across 20 countries.",
    "",
  ]) {
    assert.equal(detectEuNoSponsorship(jd).refuses, false, jd);
  }
});

const trackingOf = (doc) => ({ findOne: async () => doc });

test("gate: Europe clients with the switch on, checked by the job's location", async () => {
  setEuSponsorIndex(buildEuSponsorIndex(FIXTURE));
  const email = "client@example.com";
  const eu = trackingOf({ clientCountry: "Europe" });
  const on = { euSponsorOnly: true };
  assert.equal(await euSponsorPushBlock({ email, companyName: "Tiny", jobLocation: "Amsterdam", profile: { euSponsorOnly: false } }, { collection: eu }), null);
  assert.equal(await euSponsorPushBlock({ email, companyName: "Tiny", jobLocation: "Amsterdam", profile: on }, { collection: trackingOf({ clientCountry: "UK" }) }), null);
  // "€" payment with no country set counts as Europe.
  const euro = trackingOf({ amountPaid: "€1500" });
  const blocked = await euSponsorPushBlock({ email, companyName: "Tiny", jobLocation: "Amsterdam", profile: on }, { collection: euro });
  assert.equal(blocked.error, "NOT_EU_VISA_SPONSOR");
  assert.match(blocked.message, /not an IND recognised sponsor/);

  assert.equal(await euSponsorPushBlock({ email, companyName: "Booking.com", jobLocation: "Amsterdam", profile: on }, { collection: eu }), null);
  assert.equal(await euSponsorPushBlock({ email, companyName: "Siemens", jobLocation: "Berlin, Germany", profile: on }, { collection: eu }), null);
  const posting = await euSponsorPushBlock(
    { email, companyName: "Siemens", jobLocation: "Berlin, Germany", jobDescription: "You must have the right to work in the EU.", profile: on },
    { collection: eu },
  );
  assert.equal(posting.sponsor.reason, "POSTING_WORK_RIGHTS");
});
