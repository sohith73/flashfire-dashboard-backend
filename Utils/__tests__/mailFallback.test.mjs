// When Gmail refuses the app password, client mail goes out through SendGrid
// instead of failing (19 Nov 2026: every client email failed with 535).
import test from "node:test";
import assert from "node:assert/strict";

process.env.SMTP_USER = "support@example.com";
process.env.SMTP_PASS = "app-password";
process.env.SMTP_FROM_EMAIL = "support@example.com";
process.env.SENDGRID_API_KEY = "SG.test";
delete process.env.MAIL_FALLBACK;

const { sendViaSendgridFallback, isSmtpAuthError, isMailFallbackEnabled } = await import("../mailFallback.js");
const smtp = await import("../smtpSender.js");

const GMAIL_535 = "Invalid login: 535-5.7.8 Username and Password not accepted. https://support.google.com/mail/?p=BadCredentials - gsmtp";

function fakeFetch(status = 202) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { status, ok: status < 300, headers: { get: () => "abc123" }, text: async () => "bad" };
  };
  return { calls, impl };
}

test("recognises Gmail's refused-login error", () => {
  assert.equal(isSmtpAuthError(GMAIL_535), true);
  assert.equal(isSmtpAuthError("connect ETIMEDOUT"), false);
});

test("fallback is off without a key or with MAIL_FALLBACK=off", () => {
  assert.equal(isMailFallbackEnabled({}), false);
  assert.equal(isMailFallbackEnabled({ SENDGRID_API_KEY_1: "k" }), true);
  assert.equal(isMailFallbackEnabled({ SENDGRID_API_KEY: "k", MAIL_FALLBACK: "off" }), false);
});

test("SendGrid body: verified sender, reply-to the Gmail address, both bodies, headers, attachment", async () => {
  const f = fakeFetch();
  const out = await sendViaSendgridFallback(
    {
      to: "client@example.com",
      subject: "Hi",
      html: "<p>x</p>",
      text: "x",
      headers: { "List-Unsubscribe": "<https://u>" },
      attachment: { filename: "a.txt", mimetype: "text/plain", content: Buffer.from("hey") }
    },
    { env: { SENDGRID_API_KEY: "k", SMTP_FROM_EMAIL: "support@example.com" }, fetchImpl: f.impl }
  );
  assert.deepEqual(out, { ok: true, messageId: "sendgrid:abc123", from: "noreply@flashfirehq.com" });
  const b = f.calls[0].body;
  assert.equal(b.personalizations[0].to[0].email, "client@example.com");
  assert.equal(b.reply_to.email, "support@example.com");
  assert.deepEqual(b.content.map((c) => c.type), ["text/plain", "text/html"]);
  assert.equal(b.headers["List-Unsubscribe"], "<https://u>");
  assert.equal(Buffer.from(b.attachments[0].content, "base64").toString(), "hey");
  assert.equal(f.calls[0].init.headers.Authorization, "Bearer k");
});

test("a SendGrid refusal is a failure with the status, never a throw", async () => {
  const f = fakeFetch(401);
  const out = await sendViaSendgridFallback({ to: "a@b.co", subject: "s", text: "t" }, { env: { SENDGRID_API_KEY: "k" }, fetchImpl: f.impl });
  assert.equal(out.ok, false);
  assert.match(out.error, /^sendgrid_401/);
});

test("sendViaSmtp: Gmail 535 falls back to SendGrid, then skips Gmail while the login is known bad", async () => {
  smtp.__resetSmtpAuthState();
  let smtpCalls = 0;
  smtp.__setTransporter({ sendMail: async () => { smtpCalls++; throw new Error(GMAIL_535); } });
  const f = fakeFetch();
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.impl;
  try {
    const first = await smtp.sendViaSmtp({ to: "client@example.com", subject: "Daily summary", html: "<p>x</p>" });
    assert.equal(first.ok, true);
    assert.equal(first.channel, "sendgrid");
    assert.match(first.smtpError, /535/);
    const second = await smtp.sendViaSmtp({ to: "client@example.com", subject: "Another", text: "y" });
    assert.equal(second.channel, "sendgrid");
    assert.equal(smtpCalls, 1, "Gmail is not retried during the cooldown");
    assert.equal(f.calls.length, 2);
  } finally {
    globalThis.fetch = realFetch;
    smtp.__resetSmtpAuthState();
  }
});

test("sendViaSmtp: a working Gmail login never touches SendGrid", async () => {
  smtp.__setTransporter({ sendMail: async () => ({ messageId: "<m@gmail>" }) });
  const f = fakeFetch();
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.impl;
  try {
    const out = await smtp.sendViaSmtp({ to: "c@example.com", subject: "s", text: "t" });
    assert.deepEqual(out.channel, "smtp");
    assert.equal(f.calls.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("sendViaSmtp: both roads failing reports both errors", async () => {
  smtp.__resetSmtpAuthState();
  smtp.__setTransporter({ sendMail: async () => { throw new Error("connect ETIMEDOUT"); } });
  const f = fakeFetch(500);
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.impl;
  try {
    const out = await smtp.sendViaSmtp({ to: "c@example.com", subject: "s", text: "t" });
    assert.equal(out.ok, false);
    assert.match(out.error, /^smtp: connect ETIMEDOUT \| sendgrid_500/);
  } finally {
    globalThis.fetch = realFetch;
    smtp.__resetSmtpAuthState();
  }
});

