// Gmail app password support: encryption, IMAP reading, SMTP sending.
// Offline: IMAP is a fake Gmail (helpers/fakeGmailImap.mjs), SMTP is
// nodemailer's stream transport, so nothing leaves the machine.

import { test } from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";

process.env.CRYPTO_AES_SECRET_SECRET_KEY = "11".repeat(32);

const { sealSecret, openSecret, __resetSecretBoxKeys } = await import("../secretBox.js");
const imap = await import("../../src/services/mailbox/gmailImap.js");
const smtp = await import("../../src/services/mailbox/gmailSmtp.js");
const { normalizeAppPassword } = await import("../../src/services/mailbox/mailboxRegistry.js");
const { isGmailAuthError } = await import("../discordMailNotify.js");
const { createFakeGmail, buildSource } = await import("./helpers/fakeGmailImap.mjs");

const P = { purpose: "mail-app-password", context: "client@x.com" };

// ─── secretBox ──────────────────────────────────────────────────────

test("secretBox: round trip, and the ciphertext never contains the password", () => {
  __resetSecretBoxKeys();
  const sealed = sealSecret("abcdefghijklmnop", P);
  assert.match(sealed, /^v1:[\w-]+:[\w-]+:[\w-]+$/);
  assert.ok(!sealed.includes("abcdefghijklmnop"));
  assert.equal(openSecret(sealed, P), "abcdefghijklmnop");
  assert.notEqual(sealSecret("abcdefghijklmnop", P), sealed, "fresh IV every time");
});

test("secretBox: bound to the client, tamper-evident, key-specific", () => {
  __resetSecretBoxKeys();
  const sealed = sealSecret("abcdefghijklmnop", P);
  assert.throws(() => openSecret(sealed, { ...P, context: "other@x.com" }), { code: "SECRET_UNREADABLE" });
  const [v, iv, tag, ct] = sealed.split(":");
  const flipped = Buffer.from(ct, "base64url");
  flipped[0] ^= 1;
  assert.throws(() => openSecret([v, iv, tag, flipped.toString("base64url")].join(":"), P), { code: "SECRET_UNREADABLE" });
  assert.throws(() => openSecret("not-a-secret", P), { code: "SECRET_UNREADABLE" });

  process.env.CRYPTO_AES_SECRET_SECRET_KEY = "22".repeat(32);
  __resetSecretBoxKeys();
  try {
    assert.throws(() => openSecret(sealed, P), { code: "SECRET_UNREADABLE" });
  } finally {
    process.env.CRYPTO_AES_SECRET_SECRET_KEY = "11".repeat(32);
    __resetSecretBoxKeys();
  }
});

test("app password input: Google's spaced format is accepted, anything else refused", () => {
  assert.equal(normalizeAppPassword("abcd efgh ijkl mnop"), "abcdefghijklmnop");
  assert.equal(normalizeAppPassword(" ABCD EFGH IJKL MNOP "), "abcdefghijklmnop");
  assert.equal(normalizeAppPassword("my-real-password1"), null);
  assert.equal(normalizeAppPassword("abcd efgh ijkl"), null);
  assert.equal(normalizeAppPassword(""), null);
});

// ─── ids, labels, errors ────────────────────────────────────────────

test("Gmail ids: IMAP decimal ids become the same hex ids the REST API uses", () => {
  // 1795836540148297473 is X-GM-MSGID; the REST API calls it 18ec17d18a34af01.
  assert.equal(imap.gmIdToHex("1795836540148297473"), "18ec17d18a34af01");
  assert.equal(imap.hexToGmId("18ec17d18a34af01"), "1795836540148297473");
  assert.throws(() => imap.hexToGmId("../etc"), { message: "invalid_gmail_id" });
  assert.throws(() => imap.hexToGmId(""), { message: "invalid_gmail_id" });
});

test("labels map to the REST ids the Mails tab filters on", () => {
  const ids = imap.toLabelIds({ labels: new Set(["\\Inbox", "\\Important", "Recruiters"]), flags: new Set(["\\Flagged"]) });
  assert.deepEqual(ids.sort(), ["IMPORTANT", "INBOX", "Recruiters", "STARRED", "UNREAD"].sort());
  assert.ok(!imap.toLabelIds({ labels: new Set(["\\Inbox"]), flags: new Set(["\\Seen"]) }).includes("UNREAD"));
  assert.ok(imap.toLabelIds({ labels: new Set(), flags: new Set(["\\Seen"]), folderLabel: "TRASH" }).includes("TRASH"));
});

test("a rejected password is an auth error everywhere it is classified", () => {
  const e = imap.normalizeImapError(Object.assign(new Error("Authentication failed"), { authenticationFailed: true, responseText: "Invalid credentials (Failure)" }));
  assert.equal(e.isMailboxAuthError, true);
  assert.ok(isGmailAuthError(e.message));
  const s = smtp.normalizeSmtpError(Object.assign(new Error("Invalid login: 535-5.7.8 Username and Password not accepted"), { code: "EAUTH", responseCode: 535 }));
  assert.equal(s.isMailboxAuthError, true);
  assert.ok(isGmailAuthError(s.message));
  const net = imap.normalizeImapError(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }));
  assert.ok(!net.isMailboxAuthError);
  assert.ok(!isGmailAuthError(net.message), "a network blip is not a dead password");
  const disabled = imap.normalizeImapError(new Error("[ALERT] Your account is not enabled for IMAP use."));
  assert.match(disabled.message, /IMAP is disabled/);
});

// ─── IMAP session against a fake Gmail ──────────────────────────────

const HOUR = 3600 * 1000;

async function fakeMailbox() {
  const now = Date.now();
  const interview = await buildSource({
    from: "Jane Recruiter <jane@acme.com>",
    to: "client@gmail.com",
    subject: "Interview invitation - Acme",
    text: "We would like to schedule an interview with you.",
    attachments: [{ filename: "details.txt", content: "Round 1 on Monday" }, { filename: "jd.pdf", content: Buffer.from("%PDF-1.4") }]
  });
  const old = await buildSource({ from: "a@b.com", to: "client@gmail.com", subject: "Old newsletter", text: "old" });
  const reply = await buildSource({ from: "client@gmail.com", to: "jane@acme.com", subject: "Re: Interview invitation - Acme", text: "Thanks!" });
  const spam = await buildSource({ from: "x@spam.com", to: "client@gmail.com", subject: "You won", text: "no" });
  return createFakeGmail({
    messages: [
      { emailId: "1000000000000000001", threadId: "2000000000000000001", labels: ["\\Inbox"], internalDate: now - 5 * HOUR, source: old, subject: "Old newsletter", flags: ["\\Seen"],
        envelope: { subject: "Old newsletter", from: [{ address: "a@b.com" }] }, bodyStructure: { type: "text/plain", part: "1" } },
      { emailId: "1795836540148297473", threadId: "2000000000000000002", labels: ["\\Inbox", "\\Important"], internalDate: now - 30 * 60 * 1000, source: interview, subject: "Interview invitation - Acme",
        envelope: { subject: "Interview invitation - Acme", from: [{ name: "Jane Recruiter", address: "jane@acme.com" }], to: [{ address: "client@gmail.com" }] },
        bodyStructure: { type: "multipart/mixed", childNodes: [{ part: "1", type: "text/plain", encoding: "7bit" }, { part: "2", type: "application/pdf", disposition: "attachment" }] } },
      { emailId: "1000000000000000003", threadId: "2000000000000000002", labels: ["\\Sent"], flags: ["\\Seen"], internalDate: now - 10 * 60 * 1000, source: reply, subject: "Re: Interview invitation - Acme",
        envelope: { subject: "Re: Interview invitation - Acme", from: [{ address: "client@gmail.com" }], to: [{ name: "Jane Recruiter", address: "jane@acme.com" }] },
        bodyStructure: { type: "text/plain", part: "1", encoding: "7bit" } },
      { emailId: "1000000000000000004", threadId: "2000000000000000004", folder: "spam", internalDate: now - 20 * 60 * 1000, source: spam, subject: "You won",
        envelope: { subject: "You won", from: [{ address: "x@spam.com" }] }, bodyStructure: { type: "text/plain", part: "1" } }
    ]
  });
}

test("IMAP login: right password connects to imap.gmail.com:993 over TLS, wrong one is an auth error", async () => {
  const fake = await fakeMailbox();
  imap.__setImapClientFactory(fake.factory);
  try {
    await imap.verifyImapLogin({ gmailEmail: "client@gmail.com", password: "abcdabcdabcdabcd" });
    assert.deepEqual(fake.state.lastAuth, { user: "client@gmail.com", host: "imap.gmail.com", port: 993, secure: true });
    assert.equal(fake.state.openSessions, 0, "session closed");
    await assert.rejects(imap.verifyImapLogin({ gmailEmail: "client@gmail.com", password: "wrongwrongwrongw" }), (e) => e.isMailboxAuthError === true);
  } finally {
    imap.__setImapClientFactory(null);
  }
});

test("hourly scan: new INBOX mail after the cursor, oldest first, in the REST message shape", async () => {
  const fake = await fakeMailbox();
  imap.__setImapClientFactory(fake.factory);
  const s = await imap.GmailImapSession.open({ gmailEmail: "client@gmail.com", password: "abcdabcdabcdabcd" });
  try {
    const afterSec = Math.floor((Date.now() - HOUR) / 1000);
    const ids = await s.listNewInboxIds(afterSec, 200);
    assert.deepEqual(ids, ["18ec17d18a34af01"], "only the interview: the newsletter is older, the reply is not in INBOX, spam is not in INBOX");

    const msg = await s.fetchMessageForScan(ids[0]);
    assert.match(msg.meta.from, /jane@acme\.com/);
    assert.equal(msg.meta.subject, "Interview invitation - Acme");
    assert.deepEqual(msg.meta.to, ["client@gmail.com"]);
    assert.ok(msg.meta.labels.includes("INBOX") && msg.meta.labels.includes("UNREAD"));
    assert.equal(msg.threadId, imap.gmIdToHex("2000000000000000002"));
    assert.match(msg.bodyText, /schedule an interview/);
    assert.ok(msg.internalDate > 0);
    assert.deepEqual(msg.allAttachments.map((a) => a.filename), ["details.txt", "jd.pdf"]);
    assert.deepEqual(msg.textAttachments.map((a) => a.text), ["Round 1 on Monday"], "only text-like attachments are read");
    assert.ok(msg.snippet.length > 0);
  } finally {
    await s.close();
    imap.__setImapClientFactory(null);
  }
});

test("Mails tab: threads grouped across Inbox and Sent, stats from the whole thread, spam separate", async () => {
  const fake = await fakeMailbox();
  imap.__setImapClientFactory(fake.factory);
  const s = await imap.GmailImapSession.open({ gmailEmail: "client@gmail.com", password: "abcdabcdabcdabcd" });
  try {
    const inbox = await s.listThreads({ labelId: "INBOX", maxResults: 25 });
    assert.equal(inbox.threads.length, 2);
    const t = inbox.threads[0];
    assert.equal(t.threadId, imap.gmIdToHex("2000000000000000002"), "newest thread first");
    assert.equal(t.messageCount, 2, "the Sent reply is part of the thread");
    assert.equal(t.unreadCount, 1);
    assert.equal(t.hasAttachments, true);
    assert.ok(t.labels.includes("INBOX") && t.labels.includes("SENT"));
    assert.equal(t.subject, "Re: Interview invitation - Acme", "subject of the latest message, like the REST path");

    const spam = await s.listThreads({ labelId: "SPAM" });
    assert.deepEqual(spam.threads.map((x) => x.subject), ["You won"]);
    assert.ok(spam.threads[0].labels.includes("SPAM"));

    const search = await s.listThreads({ labelId: "INBOX", q: "newsletter" });
    assert.deepEqual(search.threads.map((x) => x.subject), ["Old newsletter"]);

    const ids = await s.threadMessageIds(t.threadId);
    assert.equal(ids.length, 2);
    const full = await s.fetchMessageForInbox(ids[0]);
    assert.match(full.text, /schedule an interview/);
    assert.equal(full.attachments[1].attachmentId, "imap-1");
    const att = await s.attachmentContent(ids[0], "imap-1");
    assert.equal(att.filename, "jd.pdf");
    assert.equal(att.content.toString(), "%PDF-1.4");
  } finally {
    await s.close();
    imap.__setImapClientFactory(null);
  }
});

test("Mails tab: paging never repeats a thread and stops at the end", async () => {
  const fake = createFakeGmail();
  const now = Date.now();
  for (let i = 0; i < 7; i++) {
    const thread = String(3000 + (i % 5)); // threads 3000..3004, two of them have 2 messages
    fake.addMessage({
      emailId: String(5000 + i),
      threadId: thread,
      labels: ["\\Inbox"],
      internalDate: now - (7 - i) * 60_000,
      source: await buildSource({ from: "a@b.com", to: "c@d.com", subject: `m${i}`, text: "x" }),
      subject: `m${i}`,
      envelope: { subject: `m${i}`, from: [{ address: "a@b.com" }] },
      bodyStructure: { type: "text/plain", part: "1" }
    });
  }
  imap.__setImapClientFactory(fake.factory);
  const s = await imap.GmailImapSession.open({ gmailEmail: "c@d.com", password: "abcdabcdabcdabcd" });
  try {
    const seen = [];
    let token = null;
    for (let guard = 0; guard < 10; guard++) {
      const page = await s.listThreads({ labelId: "INBOX", pageToken: token, maxResults: 2 });
      seen.push(...page.threads.map((x) => x.threadId));
      token = page.nextPageToken;
      if (!token) break;
    }
    assert.equal(seen.length, 5, "five threads in total");
    assert.equal(new Set(seen).size, 5, "no thread shown twice");
    assert.equal(imap.decodePageToken("garbage"), null);
  } finally {
    await s.close();
    imap.__setImapClientFactory(null);
  }
});

test("snippet preview decodes quoted-printable and base64 parts", () => {
  assert.equal(imap.decodePartPreview(Buffer.from("caf=C3=A9 =\r\nau lait"), { encoding: "quoted-printable", charset: "utf-8" }), "café au lait");
  const b64 = Buffer.from("héllo world").toString("base64");
  assert.equal(imap.decodePartPreview(Buffer.from(b64.slice(0, b64.length - 1)), { encoding: "base64" }).startsWith("héllo wo"), true);
});

// ─── SMTP ───────────────────────────────────────────────────────────

// A minimal plaintext SMTP sink, so the REAL nodemailer SMTP transport is
// what gets exercised (Bcc stripping is the SMTP transport's job; the stream
// transport deliberately keeps Bcc headers).
async function smtpSink() {
  const net = await import("node:net");
  const received = [];
  const server = net.createServer((sock) => {
    let buf = "";
    let inData = false;
    let cur = { from: "", to: [], data: "" };
    sock.write("220 sink ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            received.push(cur);
            cur = { from: "", to: [], data: "" };
            sock.write("250 2.0.0 queued\r\n");
          } else cur.data += (line.startsWith("..") ? line.slice(1) : line) + "\r\n";
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO")) sock.write("250-sink\r\n250 8BITMIME\r\n");
        else if (cmd.startsWith("MAIL FROM")) { cur.from = line.match(/<(.*)>/)?.[1] || ""; sock.write("250 ok\r\n"); }
        else if (cmd.startsWith("RCPT TO")) { cur.to.push(line.match(/<(.*)>/)?.[1] || ""); sock.write("250 ok\r\n"); }
        else if (cmd === "DATA") { inData = true; sock.write("354 go\r\n"); }
        else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("250 ok\r\n");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { received, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

function captureTransport(port) {
  const opts = [];
  smtp.__setSmtpTransportFactory((o) => {
    opts.push(o);
    // Same transport type as production, pointed at the local sink.
    return nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true });
  });
  return { opts };
}

test("SMTP: sends as the client via smtp.gmail.com:465, Bcc only in the envelope, long lines safe", async () => {
  const sink = await smtpSink();
  const { opts } = captureTransport(sink.port);
  try {
    const longParagraph = "I am excited to apply. ".repeat(80); // ~1800 chars, one line
    const res = await smtp.sendViaGmailSmtp({
      gmailEmail: "client@gmail.com",
      password: "abcdabcdabcdabcd",
      mail: {
        to: "jane@acme.com",
        cc: "hr@acme.com",
        bcc: "secret@flashfire.com",
        subject: "Application — Data Analyst",
        text: longParagraph,
        attachments: [{ filename: "resume.pdf", content: Buffer.from("%PDF"), contentType: "application/pdf" }]
      }
    });
    assert.deepEqual(opts[0], {
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: "client@gmail.com", pass: "abcdabcdabcdabcd" },
      connectionTimeout: 20000,
      greetingTimeout: 15000,
      socketTimeout: 60000
    });
    assert.equal(sink.received.length, 1);
    const got = sink.received[0];
    assert.equal(got.from, "client@gmail.com");
    assert.deepEqual(got.to.sort(), ["hr@acme.com", "jane@acme.com", "secret@flashfire.com"]);
    assert.ok(!/^bcc:/im.test(got.data), "no Bcc header reaches recipients");
    assert.ok(!got.data.includes("secret@flashfire.com"), "the Bcc address is nowhere in the message");
    assert.match(got.data, /^From: client@gmail\.com\r$/m);
    assert.match(got.data, /^Message-ID: </m);
    assert.match(got.data, /^Date: /m);
    assert.match(got.data, /resume\.pdf/);
    assert.ok(res.messageId.startsWith("<"));
    for (const line of got.data.split("\r\n")) assert.ok(line.length <= 998, "no SMTP line over 998 chars");
  } finally {
    smtp.__setSmtpTransportFactory(null);
    await sink.close();
  }
});

test("SMTP: a refused password surfaces as MailboxAuthError", async () => {
  smtp.__setSmtpTransportFactory(() => ({
    sendMail: async () => {
      throw Object.assign(new Error("Invalid login: 535-5.7.8 Username and Password not accepted."), { code: "EAUTH", responseCode: 535 });
    },
    verify: async () => {
      throw Object.assign(new Error("Invalid login"), { code: "EAUTH" });
    },
    close() {}
  }));
  try {
    await assert.rejects(
      smtp.sendViaGmailSmtp({ gmailEmail: "c@gmail.com", password: "x", mail: { to: "a@b.com", subject: "s", text: "t" } }),
      (e) => e.isMailboxAuthError === true && !e.message.includes("abcd")
    );
    await assert.rejects(smtp.verifySmtpLogin({ gmailEmail: "c@gmail.com", password: "x" }), (e) => e.isMailboxAuthError === true);
  } finally {
    smtp.__setSmtpTransportFactory(null);
  }
});
