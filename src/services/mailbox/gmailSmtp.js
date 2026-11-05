// Send as the client through Gmail SMTP with their app password.
//
// The REST API path hands Gmail a hand-built raw MIME message. Over SMTP we
// let nodemailer compose instead, from the same fields, because SMTP is
// stricter than the REST API: lines must end in CRLF and stay under 998
// characters (nodemailer picks quoted-printable when a template paragraph is
// longer), and Bcc must travel only in the envelope (nodemailer never writes
// a Bcc header). Gmail files SMTP-sent mail in the client's Sent folder and
// threads replies by In-Reply-To / References.

import nodemailer from "nodemailer";
import { MailboxAuthError } from "./gmailImap.js";

export const SMTP_HOST = "smtp.gmail.com";
export const SMTP_PORT = 465;

let transportFactory = (opts) => nodemailer.createTransport(opts);

/** Tests point this at a local SMTP server. Pass null to restore. */
export function __setSmtpTransportFactory(fn) {
  transportFactory = fn || ((opts) => nodemailer.createTransport(opts));
}

function transportFor({ gmailEmail, password }) {
  return transportFactory({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: { user: gmailEmail, pass: password },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000
  });
}

const SMTP_AUTH_RE = /EAUTH|535[- ]5\.7\.8|username and password not accepted|application-specific password required|534[- ]5\.7\.9|invalid login/i;

export function normalizeSmtpError(err) {
  const text = [err?.code, err?.responseCode, err?.response, err?.message].filter(Boolean).join(" ");
  if (err?.code === "EAUTH" || SMTP_AUTH_RE.test(text)) {
    return new MailboxAuthError(`Gmail rejected the app password over SMTP: AUTHENTICATIONFAILED (${String(err?.response || err?.message || "").slice(0, 160)})`);
  }
  const out = new Error(`SMTP error: ${text}`.slice(0, 400));
  out.code = err?.code;
  return out;
}

/**
 * Send one message from the client's Gmail.
 * `mail`: { to, cc?, bcc?, subject, text?, html?, attachments?: [{filename, content, contentType}],
 *           inReplyTo?, references? }
 * Throws MailboxAuthError when Google refuses the password; other errors as Error.
 * @returns {Promise<{messageId: string, accepted: string[], rejected: string[]}>}
 */
export async function sendViaGmailSmtp({ gmailEmail, password, mail }) {
  if (!mail?.to || !mail?.subject) throw new Error("SMTP: to and subject are required");
  const transport = transportFor({ gmailEmail, password });
  try {
    const info = await transport.sendMail({
      from: gmailEmail,
      to: mail.to,
      ...(mail.cc ? { cc: mail.cc } : {}),
      ...(mail.bcc ? { bcc: mail.bcc } : {}),
      subject: mail.subject,
      ...(mail.text ? { text: mail.text } : {}),
      ...(mail.html ? { html: mail.html } : {}),
      ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
      ...(mail.references ? { references: mail.references } : {}),
      ...(Array.isArray(mail.attachments) && mail.attachments.length
        ? {
            attachments: mail.attachments.map((a) => ({
              filename: a.filename,
              content: a.content,
              contentType: a.contentType || a.mimetype || "application/octet-stream"
            }))
          }
        : {})
    });
    if (info?.rejected?.length && !info?.accepted?.length) {
      throw new Error(`SMTP: every recipient was rejected (${info.rejected.join(", ")})`);
    }
    return { messageId: info?.messageId || "", accepted: info?.accepted || [], rejected: info?.rejected || [] };
  } catch (err) {
    if (err?.isMailboxAuthError || /^SMTP: /.test(err?.message || "")) throw err;
    throw normalizeSmtpError(err);
  } finally {
    transport.close?.();
  }
}

/** Authenticate once without sending. Throws MailboxAuthError on bad credentials. */
export async function verifySmtpLogin({ gmailEmail, password }) {
  const transport = transportFor({ gmailEmail, password });
  try {
    await transport.verify();
    return true;
  } catch (err) {
    throw normalizeSmtpError(err);
  } finally {
    transport.close?.();
  }
}
