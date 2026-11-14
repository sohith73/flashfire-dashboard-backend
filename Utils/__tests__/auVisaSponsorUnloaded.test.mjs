// "Australia visa sponsors only" must fail closed: with no sponsor file on the
// server, an opted-in client's push is refused (503 upstream), never let
// through unchecked. Its own file because AU_SPONSOR_FILE is read at import.

import test from "node:test";
import assert from "node:assert/strict";

process.env.AU_SPONSOR_FILE = "/nonexistent/au-visa-sponsors.json.gz";
const { auSponsorGate, auSponsorStatus } = await import("../auVisaSponsor.js");

test("gate throws AU_SPONSOR_DATA_NOT_LOADED when the file is missing", async () => {
  const collection = { findOne: async () => ({ clientCountry: "Australia" }) };
  await assert.rejects(
    auSponsorGate({ email: "c@example.com", profile: { auSponsorOnly: true } }, { collection }),
    (e) => e.code === "AU_SPONSOR_DATA_NOT_LOADED",
  );
  assert.equal(auSponsorStatus().loaded, false);
});

test("a client without the switch is never blocked by missing data", async () => {
  const collection = { findOne: async () => ({ clientCountry: "Australia" }) };
  assert.equal(await auSponsorGate({ email: "c@example.com", profile: { auSponsorOnly: false } }, { collection }), null);
});
