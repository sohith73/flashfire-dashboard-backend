// Verification for the SMTP proof-of-send delivery + payment-email addressing.
//
//   npm run verify:client-smtp
//
// Exercises the REAL sendViaSmtp + notifyClientForDigest decision tree against
// an injected fake SMTP transporter. No real SMTP, no network. Mongo buffering
// is disabled so the digest's fail-soft DB writes reject instantly (and are
// swallowed) instead of hanging — the send + routing logic is what we test here.

import mongoose from "mongoose";
mongoose.set("bufferCommands", false); // DB writes fail fast; notifier swallows them

// SMTP must look configured before the notifier module captures the channel.
process.env.CLIENT_MAIL_CHANNEL = "smtp";
process.env.SMTP_USER = "support@flashfirejobs.com";
process.env.SMTP_PASS = "app-password-1234";
process.env.SMTP_FROM_NAME = "FlashFire Team";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const smtp = await import("../Utils/smtpSender.js");
const { notifyClientForDigest, deriveEligibility } = await import("../src/services/clientMailNotifier.js");

// Fake transporter capturing every sendMail call.
const sentMail = [];
let smtpMode = "ok";
smtp.__setTransporter({
  async sendMail(mail) {
    sentMail.push(mail);
    if (smtpMode === "throw") throw new Error("SMTP 535 auth failed");
    return { messageId: `<test-${sentMail.length}@flashfirejobs.com>` };
  }
});

// ─────────────────────────────────────────────────────────────
console.log("\n[1] sendViaSmtp — proof-bearing send path");
{
  ok("isSmtpConfigured true with user+pass", smtp.isSmtpConfigured() === true);
  ok("smtpFromEmail resolves", smtp.smtpFromEmail() === "support@flashfirejobs.com");

  const r = await smtp.sendViaSmtp({ to: "client@pay.com", subject: "Hi", html: "<p>hi</p>", text: "hi" });
  ok("send ok", r.ok === true, r.error);
  ok("returns messageId (Sent-folder receipt)", /@flashfirejobs\.com>$/.test(r.messageId), r.messageId);
  const m = sentMail[sentMail.length - 1];
  ok("recipient passed through", m.to === "client@pay.com");
  ok("From carries display name + account", m.from === '"FlashFire Team" <support@flashfirejobs.com>', m.from);
  ok("html + text both set", m.html === "<p>hi</p>" && m.text === "hi");

  ok("missing fields → not ok, no throw", (await smtp.sendViaSmtp({ to: "x@y.com" })).ok === false);

  smtpMode = "throw";
  const rf = await smtp.sendViaSmtp({ to: "a@b.com", subject: "s", html: "<p>h</p>" });
  ok("SMTP auth failure → fail-soft", rf.ok === false && /535/.test(rf.error), rf.error);
  smtpMode = "ok";
}

// ─────────────────────────────────────────────────────────────
console.log("\n[2] notifyClientForDigest — payment email is the ONLY recipient");
{
  const eligibleDigest = (over = {}) => ({
    _id: "deadbeef",
    messageId: "m1",
    clientNotifyEligible: true,
    clientNotifiedAt: null,
    clientNotifyAttempts: 0,
    clientNotifyCategory: "interview",
    category: "interview",
    subject: "Interview invitation — Backend Engineer",
    from: "Acme <talent@acme.com>",
    summary: "They want to schedule an interview.",
    keyPoints: [],
    urls: [],
    ...over
  });

  sentMail.length = 0;
  const withPay = await notifyClientForDigest({
    digestDoc: eligibleDigest(),
    client: { name: "Priya", email: "priya@dash.com", paymentEmail: "priya.pay@gmail.com" },
    mailbox: "priya.inbox@gmail.com"
  });
  ok("eligible + payment email → sent", withPay === "sent", withPay);
  ok("sent TO the payment email (not dashboard/mailbox)", sentMail[0]?.to === "priya.pay@gmail.com", sentMail[0]?.to);
  ok("subject reflects milestone", /interview/i.test(sentMail[0]?.subject || ""));

  sentMail.length = 0;
  const noPay = await notifyClientForDigest({
    digestDoc: eligibleDigest({ messageId: "m2" }),
    client: { name: "NoPay", email: "nopay@dash.com", paymentEmail: "" },
    mailbox: "nopay.inbox@gmail.com"
  });
  ok("eligible but NO payment email → skipped", noPay === "skipped", noPay);
  ok("nothing sent when no payment email", sentMail.length === 0);

  sentMail.length = 0;
  const badPay = await notifyClientForDigest({
    digestDoc: eligibleDigest({ messageId: "m3" }),
    client: { name: "Bad", email: "b@d.com", paymentEmail: "not-an-email" },
    mailbox: "b.inbox@gmail.com"
  });
  ok("malformed payment email → skipped, not sent", badPay === "skipped" && sentMail.length === 0);

  sentMail.length = 0;
  const notEligible = await notifyClientForDigest({
    digestDoc: eligibleDigest({ messageId: "m4", clientNotifyEligible: false }),
    client: { paymentEmail: "x@pay.com" },
    mailbox: "x@gmail.com"
  });
  ok("not eligible → skipped, not sent", notEligible === "skipped" && sentMail.length === 0);

  sentMail.length = 0;
  const already = await notifyClientForDigest({
    digestDoc: eligibleDigest({ messageId: "m5", clientNotifiedAt: new Date() }),
    client: { paymentEmail: "x@pay.com" },
    mailbox: "x@gmail.com"
  });
  ok("already notified → 'already', not re-sent", already === "already" && sentMail.length === 0);
}

// ─────────────────────────────────────────────────────────────
console.log("\n[3] SMTP unconfigured → skipped, never sent to a guessed address");
{
  const prevUser = process.env.SMTP_USER, prevPass = process.env.SMTP_PASS;
  delete process.env.SMTP_USER; delete process.env.SMTP_PASS;
  sentMail.length = 0;
  const r = await notifyClientForDigest({
    digestDoc: { _id: "x", messageId: "m6", clientNotifyEligible: true, clientNotifiedAt: null, clientNotifyAttempts: 0, category: "offer", clientNotifyCategory: "offer", subject: "Offer", summary: "", keyPoints: [], urls: [] },
    client: { paymentEmail: "real@pay.com" },
    mailbox: "x@gmail.com"
  });
  ok("SMTP off → skipped (not sent)", r === "skipped" && sentMail.length === 0, r);
  process.env.SMTP_USER = prevUser; process.env.SMTP_PASS = prevPass;
}

// ─────────────────────────────────────────────────────────────
console.log("\n[4] resolvePaymentEmail — offline guard paths");
{
  const { resolvePaymentEmail } = await import("../Schema_Models/ClientPaymentLookup.js");
  const none = await resolvePaymentEmail();
  ok("no candidates → not matched, empty", none.matched === false && none.paymentEmail === "");
  const blanks = await resolvePaymentEmail("", "  ", null);
  ok("blank candidates → not matched", blanks.matched === false);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
