// "Europe visa sponsors only" must fail closed when the data file is missing.
// Its own file because EU_SPONSOR_FILE is read at import.
import test from "node:test";
import assert from "node:assert/strict";

process.env.EU_SPONSOR_FILE = "/nonexistent/eu-visa-sponsors.json.gz";
const { euSponsorGate } = await import("../euVisaSponsor.js");

test("gate throws EU_SPONSOR_DATA_NOT_LOADED when the file is missing", async () => {
  const collection = { findOne: async () => ({ clientCountry: "Europe" }) };
  await assert.rejects(
    euSponsorGate({ email: "c@example.com", profile: { euSponsorOnly: true } }, { collection }),
    (e) => e.code === "EU_SPONSOR_DATA_NOT_LOADED",
  );
  assert.equal(await euSponsorGate({ email: "c@example.com", profile: { euSponsorOnly: false } }, { collection }), null);
});
