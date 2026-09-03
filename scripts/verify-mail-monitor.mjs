// Verification for the client-connection nudges + daily-summary Discord messages.
//
//   npm run verify:mail-monitor
//
// Points the (hard-coded) mail webhook at a local stub via the override env, so
// NOTHING reaches the real Discord channel. Asserts each message's shape.

import http from "node:http";

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? ` — ${x}` : ""}`); } };

const hits = [];
const srv = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  hits.push(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
  res.writeHead(204); res.end();
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));

// Override the hard-coded webhook BEFORE importing the module.
process.env.ONE_MAIN_DISCORD_FOR_MAIL_NOTIFICATIONS = `http://127.0.0.1:${srv.address().port}/hook`;
const d = await import("../Utils/discordMailNotify.js");

const lastEmbed = () => hits[hits.length - 1]?.embeds?.[0] || {};
const flat = () => JSON.stringify(lastEmbed());

console.log("\n[1] webhook override points at the stub (no real channel)");
ok("mailNotifyWebhook is the stub", d.mailNotifyWebhook().includes("127.0.0.1"), d.mailNotifyWebhook());

console.log("\n[2] 'please connect' nudge");
{
  const r = await d.notifyClientNotConnected({ client: { name: "Priya Sharma", email: "priya@c.com" }, kind: "not_connected" });
  ok("posted ok", r.ok === true, r.error);
  ok("title says connect", /connect/i.test(lastEmbed().title || ""));
  ok("names the client", flat().includes("Priya Sharma"));
  ok("has Inbox deep link", flat().includes("portal.flashfirejobs.com/inbox"));
  ok("no @mentions", hits[hits.length - 1].allowed_mentions?.parse?.length === 0);
}

console.log("\n[3] 'reconnect / token dead' nudge");
{
  await d.notifyClientNotConnected({ client: { name: "Alex", email: "a@c.com" }, kind: "token_dead" });
  ok("title says reconnect", /reconnect/i.test(lastEmbed().title || ""), lastEmbed().title);
  ok("mentions token no longer valid", /token/i.test(flat()));
}

console.log("\n[4] daily summary header");
{
  const r = await d.notifyDailySummaryHeader({
    scannedClients: 21, connectedMailboxes: 2, notConnected: 19,
    totalMails: 57, usefulMails: 3, windowHours: 24, dateLabel: "9/7/2026"
  });
  ok("posted ok", r.ok === true, r.error);
  ok("title is Daily Mail Summary", (lastEmbed().title || "").includes("Daily Mail Summary"));
  ok("shows scanned clients", flat().includes("21"));
  ok("shows useful count", flat().includes("3"));
  ok("green when useful>0", lastEmbed().color === 0x22c55e);

  await d.notifyDailySummaryHeader({ scannedClients: 21, connectedMailboxes: 2, notConnected: 19, totalMails: 40, usefulMails: 0 });
  ok("blue when no useful", lastEmbed().color === 0x3b82f6);
  ok("says no useful mails", /no useful/i.test(flat()));
}

console.log("\n[5] per-useful-mail line");
{
  const r = await d.notifyUsefulMailLine({
    clientName: "Priya Sharma", clientEmail: "priya@c.com",
    category: "interview", subject: "Interview invitation — Backend Engineer",
    from: "Acme <talent@acme.com>", receivedAt: new Date("2026-07-09T10:00:00Z")
  });
  ok("posted ok", r.ok === true, r.error);
  ok("names the client", flat().includes("Priya Sharma"));
  ok("shows the subject", flat().includes("Interview invitation"));
  ok("interview label + emoji", (lastEmbed().title || "").includes("Interview") && (lastEmbed().title || "").includes("🎉"));
  ok("has a Received timestamp", /Received/.test(flat()) && flat().includes("<t:"));

  await d.notifyUsefulMailLine({ clientName: "Bo", category: "offer", subject: "Your offer", receivedAt: new Date() });
  ok("offer label", (lastEmbed().title || "").includes("Offer") && (lastEmbed().title || "").includes("🏆"));
  await d.notifyUsefulMailLine({ clientName: "Ci", category: "assessment", subject: "Take-home", receivedAt: new Date() });
  ok("assessment shows as Assignment", (lastEmbed().title || "").includes("Assignment"));
}

srv.close();
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
