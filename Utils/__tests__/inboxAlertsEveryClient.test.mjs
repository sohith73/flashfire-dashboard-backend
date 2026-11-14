// Inbox milestone alerts go to EVERY client's payment email.
//
// They used to reach one allowlisted client. Two gates stood in the way and
// both had to move: the staged-rollout allowlist, and a per-client opt-in that
// defaulted OFF, so a client only got them if an operator had gone and ticked
// a box. Neither is how the product works now.
//
// The migration hazard this pins down: `inboxAlertsEnabled: false` is stored on
// nearly every config row that exists, and it means "nobody opted this client
// in" - NOT "this client asked us to stop". Reading it as an opt-out would keep
// the silent majority silent. Only the dedicated inboxAlertsOptOut field, which
// is written exclusively when somebody really opts out, decides delivery.
//
// Offline: the Mongo model is stubbed, nothing is sent.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

mongoose.set("bufferCommands", false);

const { ClientReminderConfig } = await import("../../Schema_Models/ClientReminderConfig.js");
const { readInboxAlertConfig, rolloutAllows } = await import("../../src/services/clientMailNotifier.js");

let row = null;
let throwOnRead = false;
const orig = {};

function thenable(resolve) {
  const p = {
    select: () => p,
    lean: () => p,
    then: (ok, err) => Promise.resolve().then(resolve).then(ok, err),
    catch: (err) => Promise.resolve().then(resolve).catch(err)
  };
  return p;
}

before(() => {
  orig.findOne = ClientReminderConfig.findOne;
  ClientReminderConfig.findOne = () =>
    thenable(() => {
      if (throwOnRead) throw new Error("mongo is down");
      return row;
    });
});
after(() => {
  ClientReminderConfig.findOne = orig.findOne;
});

const enabledFor = async (doc) => {
  row = doc;
  throwOnRead = false;
  return (await readInboxAlertConfig("client@example.com")).enabled;
};

test("a client with no config row at all receives the alerts", async () => {
  // The common case, and the reason the old opt-in kept almost everyone quiet:
  // ops only created a row for clients they were configuring a webhook for.
  assert.equal(await enabledFor(null), true);
});

test("the legacy opt-in flag stored false does not silence anyone", async () => {
  assert.equal(await enabledFor({ inboxAlertsEnabled: false }), true);
});

test("an explicit opt-out is respected", async () => {
  assert.equal(await enabledFor({ inboxAlertsOptOut: true }), false);
  // Even when the legacy flag disagrees, the opt-out wins.
  assert.equal(await enabledFor({ inboxAlertsOptOut: true, inboxAlertsEnabled: true }), false);
});

test("only a real boolean true counts as an opt-out", async () => {
  for (const bad of ["true", "yes", 1, {}, [], null, undefined]) {
    assert.equal(await enabledFor({ inboxAlertsOptOut: bad }), true, JSON.stringify(bad) || String(bad));
  }
});

test("a Mongo failure fails closed rather than mailing a possible opt-out", async () => {
  row = null;
  throwOnRead = true;
  assert.equal((await readInboxAlertConfig("client@example.com")).enabled, false);
  throwOnRead = false;
});

test("an empty address is never treated as a client", async () => {
  assert.equal((await readInboxAlertConfig("")).enabled, false);
});

test("the decision is the only thing that comes back", async () => {
  row = { inboxAlertsOptOut: false };
  assert.deepEqual(await readInboxAlertConfig("client@example.com"), { enabled: true });
});

test("no client is excluded by the rollout allowlist any more", () => {
  assert.equal(rolloutAllows({ clientEmail: "anyone@anywhere.com" }), true);
  assert.equal(rolloutAllows({}), true);
});
