// The 5 AM catch-up may only post VERIFIED milestones.
//
// On 2026-09-10 the sweep queried on the rules category alone and posted every
// candidate the AI verifier had rejected that day (a Reddit jobs digest as
// "Offer", a Bloomberg "thank you for applying" as "Interview"). This pins the
// query to the same eligibility flag the hourly poll uses.
//
// Offline: the Discord webhook is pointed at a local stub before the module is
// imported, and every Mongo model call is stubbed.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";

mongoose.set("bufferCommands", false);

const hits = [];
const srv = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  hits.push(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
  res.writeHead(204);
  res.end();
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
process.env.ONE_MAIN_DISCORD_FOR_MAIL_NOTIFICATIONS = `http://127.0.0.1:${srv.address().port}/hook`;

const { MailDigest } = await import("../../Schema_Models/MailDigest.js");
const { GmailUser } = await import("../../Schema_Models/GmailUser.js");
const { MailAppPassword } = await import("../../Schema_Models/MailAppPassword.js");
const { GmailPollState } = await import("../../Schema_Models/GmailPollState.js");
const { ClientPaymentLookup } = await import("../../Schema_Models/ClientPaymentLookup.js");
const { sendDailySummary } = await import("../../src/services/mailClientMonitor.js");

function thenable(resolve) {
  const p = {
    select: () => p,
    sort: () => p,
    lean: () => p,
    then: (ok, err) => Promise.resolve().then(resolve).then(ok, err),
    catch: (err) => Promise.resolve().then(resolve).catch(err)
  };
  return p;
}

// What the digests collection holds for the day: one verified interview the
// poll failed to deliver, and two rejected candidates whose rules category
// still says offer / interview.
const DIGESTS = [
  { _id: "verified", gmailEmail: "a@c.com", subject: "Interview invitation - Acme", from: "jane@acme.com", date: new Date(), category: "interview", clientNotifyCategory: "interview", opsNotifyEligible: true, clientNotifyEligible: true, discordPostedAt: null, messageId: "m1" },
  { _id: "reddit", gmailEmail: "a@c.com", subject: "13 High-Paying Remote Jobs", from: "noreply@redditmail.com", date: new Date(), category: "offer", clientNotifyCategory: "", opsNotifyEligible: false, clientNotifyEligible: false, verifyRan: true, verifyGenuine: false, discordPostedAt: null, messageId: "m2" },
  { _id: "bloomberg", gmailEmail: "a@c.com", subject: "Thank you for your Application", from: "blprecruiting@recruiting.bloomberg.com", date: new Date(), category: "interview", clientNotifyCategory: "", opsNotifyEligible: false, clientNotifyEligible: false, verifyRan: true, verifyGenuine: false, discordPostedAt: null, messageId: "m3" }
];

// A faithful-enough in-memory filter for the query shapes the sweep uses.
function matches(doc, q) {
  if (q.date?.$gte && !(doc.date >= q.date.$gte)) return false;
  if ("discordPostedAt" in q && doc.discordPostedAt !== q.discordPostedAt) return false;
  if (q.category?.$in && !q.category.$in.includes(doc.category)) return false;
  if (q.$or) {
    return q.$or.some((alt) =>
      Object.entries(alt).every(([k, v]) =>
        v && typeof v === "object" && "$exists" in v ? (k in doc) === v.$exists : doc[k] === v
      )
    );
  }
  return true;
}

const captured = { find: [], count: [], updates: [] };
const orig = {};
before(() => {
  orig.find = MailDigest.find;
  orig.count = MailDigest.countDocuments;
  orig.update = MailDigest.updateOne;
  orig.gmail = GmailUser.find;
  orig.appPw = MailAppPassword.find;
  orig.state = GmailPollState.find;
  orig.clients = ClientPaymentLookup.find;
  MailDigest.find = (q) => { captured.find.push(q); return thenable(() => DIGESTS.filter((d) => matches(d, q))); };
  MailDigest.countDocuments = (q) => { captured.count.push(q); return thenable(() => DIGESTS.filter((d) => matches(d, q)).length); };
  MailDigest.updateOne = (f, u) => { captured.updates.push({ f, u }); return thenable(() => ({ modifiedCount: 1 })); };
  GmailUser.find = () => thenable(() => [{ email: "a@c.com", ownerEmail: "a@c.com" }]);
  MailAppPassword.find = () => thenable(() => []);
  GmailPollState.find = () => thenable(() => []);
  ClientPaymentLookup.find = () => thenable(() => [{ email: "a@c.com", name: "Asha", paymentEmail: "pay@c.com", gmailCredentials: { email: "a@c.com" } }]);
});
after(() => {
  MailDigest.find = orig.find;
  MailDigest.countDocuments = orig.count;
  MailDigest.updateOne = orig.update;
  GmailUser.find = orig.gmail;
  MailAppPassword.find = orig.appPw;
  GmailPollState.find = orig.state;
  ClientPaymentLookup.find = orig.clients;
  srv.close();
});

test("5 AM catch-up posts only the verified milestone and counts only verified ones", async () => {
  const out = await sendDailySummary();

  // One header + exactly one catch-up line.
  assert.equal(hits.length, 2, JSON.stringify(hits.map((h) => h.embeds?.[0]?.title)));
  const line = hits[1].embeds[0];
  assert.match(line.title, /Interview/);
  assert.match(line.description, /Interview invitation - Acme/);
  assert.equal(JSON.stringify(hits).includes("Reddit"), false);
  assert.equal(JSON.stringify(hits).includes("Bloomberg"), false);

  // The headline "useful" count is the verified count, not the rules count.
  assert.equal(out.useful, 1);
  assert.equal(out.posted, 1);

  // The catch-up query itself carries the eligibility flag.
  const catchUp = captured.find.find((q) => "discordPostedAt" in q);
  assert.ok(catchUp?.$or?.some((alt) => alt.opsNotifyEligible === true), JSON.stringify(catchUp));
  assert.equal("category" in catchUp, false, "rules category must not be the gate");

  // Only the delivered one gets stamped.
  assert.equal(captured.updates.length, 1);
  assert.equal(captured.updates[0].f._id, "verified");
});
