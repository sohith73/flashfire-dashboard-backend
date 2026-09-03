// GET/POST /unsubscribe - the landing point for the footer link and for the
// one-click button Gmail and Yahoo render from the List-Unsubscribe header.
//
// BOTH VERBS, on purpose:
//   GET  - a human clicked the footer link; answer with a page they can read.
//   POST - the mail provider is acting on the user's behalf (RFC 8058). The
//          user never sees a browser, so the body is irrelevant; what matters
//          is a fast 200 and that the opt-out actually took effect.
//
// NO AUTHENTICATION, by design: this has to work from an email client with no
// session. The HMAC in the link is the authorisation - see Utils/unsubscribe.js
// for why that is safe and why the token does not expire.
//
// Never throws, and answers 200 even for a token we cannot verify. A stack
// trace or a 500 on an unsubscribe link is the worst possible response: the
// client concludes we are ignoring them and reports the mail as spam instead.

import { ClientReminderConfig } from "../Schema_Models/ClientReminderConfig.js";
import { UNSUB_STREAMS, isUnsubStream, verifyUnsubscribeToken } from "../Utils/unsubscribe.js";

const LOG = "[unsubscribe]";

const PAGE_CSS = `
  body{margin:0;padding:48px 20px;background:#f3f4f6;color:#111827;
       font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}
  .card{max-width:460px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;
        box-shadow:0 1px 3px rgba(0,0,0,.08);}
  .bar{background:#1f2937;padding:18px 28px;}
  .bar span{color:#fff;font-size:15px;font-weight:800;letter-spacing:.16em;}
  .rule{height:3px;background:#f97316;}
  .body{padding:28px;}
  h1{margin:0 0 10px;font-size:19px;line-height:1.35;}
  p{margin:0 0 12px;color:#374151;font-size:14px;line-height:1.6;}
  .muted{color:#6b7280;font-size:13px;}
  a{color:#ea580c;font-weight:600;}
`;

function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style></head>
<body><div class="card">
  <div class="bar"><span>FLASHFIRE</span></div><div class="rule"></div>
  <div class="body">${bodyHtml}</div>
</div></body></html>`;
}

/**
 * Turn the requested stream off for this client.
 *
 * Upserts, because a client can receive the inbox alerts through a config row
 * that was created by an operator and then never saved again - and "no row"
 * must not mean "cannot opt out".
 *
 * @returns {Promise<boolean>} whether the write succeeded
 */
async function applyOptOut(clientEmail, stream) {
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const silenceReports = stream === UNSUB_STREAMS.ALL || stream === UNSUB_STREAMS.REMINDERS;
  const silenceInbox = stream === UNSUB_STREAMS.ALL || stream === UNSUB_STREAMS.INBOX_ALERTS;

  try {
    // TWO STEPS, and the order matters.
    //
    // `items.$[].enabled` is an array update, and Mongo refuses it when the
    // path does not exist yet - "The path 'items' must exist in the document in
    // order to apply array updates" - which is exactly the case on an upsert
    // for a client who has no config row. So the row is created (or found)
    // first, WITHOUT touching the array, and only then are the items switched
    // off. A client who never had a config row must still be able to opt out.
    const set = { updatedAt: now, updatedBy: "unsubscribe-link" };
    if (silenceInbox) set.inboxAlertsEnabled = false;

    await ClientReminderConfig.updateOne(
      { clientEmail },
      { $set: set, $setOnInsert: { clientEmail, createdAt: now, history: [], items: [] } },
      { upsert: true }
    );

    // Items are switched off individually rather than behind a master flag, so
    // an operator turning one report back on later does not silently resurrect
    // every other one the client opted out of.
    if (silenceReports) {
      await ClientReminderConfig.updateOne(
        { clientEmail, "items.0": { $exists: true } },
        { $set: { "items.$[].enabled": false } }
      );
    }

    console.log(`${LOG} ${clientEmail} opted out of '${stream}'`);
    return true;
  } catch (err) {
    console.error(`${LOG} failed to record opt-out for ${clientEmail}:`, err?.message || err);
    return false;
  }
}

export default async function Unsubscribe(req, res) {
  const email = String(req.query?.e || req.body?.e || "").trim().toLowerCase();
  const rawStream = String(req.query?.s || req.body?.s || UNSUB_STREAMS.ALL).trim();
  const token = String(req.query?.t || req.body?.t || "").trim();
  const stream = isUnsubStream(rawStream) ? rawStream : UNSUB_STREAMS.ALL;

  // One-click from a provider: no page is rendered, so answer plainly and fast.
  const isOneClick = req.method === "POST";

  if (!email || !verifyUnsubscribeToken(email, stream, token)) {
    // Deliberately vague and still 200. Saying "bad signature" would tell
    // someone probing the endpoint whether an address is one of ours.
    console.warn(`${LOG} rejected link for '${email || "(none)"}' stream '${stream}'`);
    if (isOneClick) return res.status(200).type("text/plain").send("ok");
    return res.status(200).send(
      page(
        "Unsubscribe link not valid",
        `<h1>This link is not valid</h1>
         <p>It may have been altered in transit, or copied incompletely from the email.</p>
         <p class="muted">Reply to any message from us and we will take you off the list by hand.</p>`
      )
    );
  }

  const ok = await applyOptOut(email, stream);

  if (isOneClick) {
    // RFC 8058 wants a 2xx. A failed write still returns 200 so the provider
    // does not retry in a loop; the error is logged for us to chase.
    return res.status(200).type("text/plain").send("ok");
  }

  if (!ok) {
    return res.status(200).send(
      page(
        "We could not save that",
        `<h1>Something went wrong</h1>
         <p>We could not record your preference just now. Reply to any message from us and we will
            take <strong>${escapeHtml(email)}</strong> off the list by hand.</p>`
      )
    );
  }

  const what =
    stream === UNSUB_STREAMS.INBOX_ALERTS
      ? "inbox alerts about interviews, assignments and offers"
      : stream === UNSUB_STREAMS.REMINDERS
        ? "activity summary emails"
        : "automated emails";

  return res.status(200).send(
    page(
      "You have been unsubscribed",
      `<h1>You are unsubscribed</h1>
       <p>We have stopped sending ${escapeHtml(what)} to <strong>${escapeHtml(email)}</strong>.</p>
       <p>Your account and your job search are unaffected. Everything is still on your
          <a href="https://portal.flashfirejobs.com">dashboard</a>.</p>
       <p class="muted">Changed your mind? Reply to any earlier message and we will switch it back on.</p>`
    )
  );
}
