// mailClientMonitor — the client-facing half of the mail pipeline's Discord ops.
//
// Two jobs, both posting to the single ONE_MAIN_DISCORD_FOR_MAIL_NOTIFICATIONS
// channel:
//
//   1. checkConnectionsAndAlert()  — runs each hour alongside the poll. For every
//      ACTIVE + UNPAUSED client, decides whether their mail is connected and the
//      token healthy. Fires a "please connect" / "please reconnect" nudge,
//      throttled to once per client per MAIL_CONNECT_ALERT_THROTTLE_HOURS (24h).
//
//   2. sendDailySummary()  — the 5 AM IST job. Posts one header message with the
//      last-24h totals, then ONE separate message per useful mail
//      (interview / assignment / offer): "Client (Name) got: <subject> — received <time>".
//
// A client is linked to a connected mailbox when a GmailUser's ownerEmail OR
// email matches the client's email (or their stored gmailCredentials.email).
// Token health comes from GmailPollState.authErrorAt for that mailbox.
//
// Nothing here throws to its caller; a Discord/DB hiccup must not break the poll.

import { GmailUser } from "../../Schema_Models/GmailUser.js";
import { GmailPollState } from "../../Schema_Models/GmailPollState.js";
import { MailDigest } from "../../Schema_Models/MailDigest.js";
import { MailClientAlertState } from "../../Schema_Models/MailClientAlertState.js";
import { getActiveUnpausedClients } from "../../Schema_Models/ClientPaymentLookup.js";
import {
  mailNotifyWebhook,
  notifyClientNotConnected,
  notifyDailySummaryHeader,
  notifyUsefulMailLine
} from "../../Utils/discordMailNotify.js";

// ─── Fixed tuning (hard-coded; no env knobs) ─────────────────────────
const THROTTLE_MS = 24 * 3600 * 1000; // "connect / reconnect" nudge at most once per client per day
const SUMMARY_WINDOW_HOURS = 24; // daily summary looks back this far
// Gentle spacing between Discord posts so a burst (e.g. 19 nudges) doesn't slam
// the webhook rate limit. postToWebhook also retries on 429 as a backstop.
const SEND_GAP_MS = 400;
const USEFUL = new Set(["interview", "assessment", "offer"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (s) => String(s || "").toLowerCase().trim();

// ─── Shared: link mailboxes to clients ──────────────────────────────

// buildMailboxIndex: maps every address we might know a client by (their
// mailbox email + ownerEmail) → the healthiest mailbox state for that address.
// healthy = has a refresh token AND no recorded auth error.
async function buildMailboxIndex() {
  const [mailboxes, states] = await Promise.all([
    GmailUser.find({ refreshToken: { $exists: true, $ne: "" } }).select("email ownerEmail").lean(),
    GmailPollState.find({}).select("gmailEmail authErrorAt").lean()
  ]);
  const authErrorByMailbox = new Map(states.map((s) => [lc(s.gmailEmail), !!s.authErrorAt]));

  // address → { connected: true, dead: bool, mailbox }
  const index = new Map();
  for (const m of mailboxes) {
    const mailbox = lc(m.email);
    const dead = authErrorByMailbox.get(mailbox) === true;
    const entry = { connected: true, dead, mailbox };
    for (const addr of [mailbox, lc(m.ownerEmail)].filter(Boolean)) {
      const prev = index.get(addr);
      // Prefer a healthy mailbox over a dead one when an address maps to several.
      if (!prev || (prev.dead && !dead)) index.set(addr, entry);
    }
  }
  return index;
}

// clientConnection: given a client and the mailbox index, classify their state.
function clientConnection(client, index) {
  for (const addr of [client.email, client.gmailEmail].filter(Boolean)) {
    const hit = index.get(addr);
    if (hit) return hit.dead ? "token_dead" : "connected";
  }
  return "not_connected";
}

// ─── 1. Hourly connection check ─────────────────────────────────────

export async function checkConnectionsAndAlert() {
  if (!mailNotifyWebhook()) {
    return { skipped: "no_webhook" };
  }

  const [clients, index] = await Promise.all([getActiveUnpausedClients(), buildMailboxIndex()]);
  if (!clients.length) return { clients: 0 };

  let connected = 0;
  let alertedNotConnected = 0;
  let alertedTokenDead = 0;
  let throttled = 0;
  const now = Date.now();

  for (const client of clients) {
    const state = clientConnection(client, index);
    if (state === "connected") {
      connected++;
      continue;
    }

    const kind = state === "token_dead" ? "token_dead" : "not_connected";
    const field = kind === "token_dead" ? "lastTokenDeadAlertAt" : "lastNotConnectedAlertAt";

    // Throttle atomically: only send when the last alert of this kind is older
    // than the window. findOneAndUpdate with the time guard is the gate, so two
    // overlapping runs can't double-send.
    const cutoff = new Date(now - THROTTLE_MS);
    const doc = await MailClientAlertState.findOneAndUpdate(
      {
        clientEmail: client.email,
        $or: [{ [field]: { $lt: cutoff } }, { [field]: null }, { [field]: { $exists: false } }]
      },
      { $set: { [field]: new Date() }, $setOnInsert: { clientEmail: client.email } },
      { new: true, upsert: false }
    ).catch(() => null);

    let mayAlert = !!doc;
    if (!doc) {
      // No throttle doc yet → create one and alert. If a concurrent run already
      // created it, the duplicate-key error means someone else owns this send.
      try {
        await MailClientAlertState.create({ clientEmail: client.email, [field]: new Date() });
        mayAlert = true;
      } catch (e) {
        mayAlert = false; // 11000 = already created+alerted this window
      }
    }

    if (!mayAlert) {
      throttled++;
      continue;
    }

    const res = await notifyClientNotConnected({
      client: { name: client.name, email: client.email },
      kind
    });
    if (res.ok) {
      if (kind === "token_dead") alertedTokenDead++;
      else alertedNotConnected++;
    }
    if (SEND_GAP_MS) await sleep(SEND_GAP_MS);
  }

  const summary = {
    clients: clients.length,
    connected,
    alertedNotConnected,
    alertedTokenDead,
    throttled
  };
  console.log(
    `[mail-monitor] connection check — active=${summary.clients} connected=${connected} ` +
      `nudged(not-connected)=${alertedNotConnected} nudged(token-dead)=${alertedTokenDead} throttled=${throttled}`
  );
  return summary;
}

// ─── 2. Daily 5 AM summary ──────────────────────────────────────────

export async function sendDailySummary() {
  if (!mailNotifyWebhook()) {
    console.log("[mail-monitor] daily summary skipped — no ONE_MAIN_DISCORD_FOR_MAIL_NOTIFICATIONS webhook");
    return { skipped: "no_webhook" };
  }

  const since = new Date(Date.now() - SUMMARY_WINDOW_HOURS * 3600 * 1000);
  const [clients, index] = await Promise.all([getActiveUnpausedClients(), buildMailboxIndex()]);

  let connectedCount = 0;
  for (const c of clients) if (clientConnection(c, index) !== "not_connected") connectedCount++;
  const notConnected = clients.length - connectedCount;

  const [totalMails, usefulInWindow, usefulDocs] = await Promise.all([
    MailDigest.countDocuments({ date: { $gte: since } }).catch(() => 0),
    // Headline count = every milestone in the window, posted or not. usefulDocs
    // below is only the unposted remainder, so the two must not be conflated.
    MailDigest.countDocuments({ date: { $gte: since }, category: { $in: [...USEFUL] } }).catch(() => 0),
    // discordPostedAt: null is THE fix for double-posting. mailPollWorker
    // already posts one Discord line per milestone the moment it detects it,
    // and stamps discordPostedAt. This query used to ignore that stamp, so at
    // 5 AM every milestone from the previous 24h was posted a SECOND time -
    // the same offer mail appearing twice in the channel, hours apart, with no
    // indication which was the real event.
    //
    // Filtering on it turns this from a re-post into what it should always
    // have been: a catch-up for the handful the hourly poll genuinely failed
    // to deliver (webhook 5xx, a crash between post and stamp).
    MailDigest.find({ date: { $gte: since }, category: { $in: [...USEFUL] }, discordPostedAt: null })
      .select("gmailEmail ownerEmail subject from date category clientNotifyCategory messageId")
      .sort({ date: 1 })
      .lean()
      .catch(() => [])
  ]);

  // Map a mailbox/owner address → client name, so each useful line names the client.
  const nameByAddr = new Map();
  for (const c of clients) {
    if (c.email) nameByAddr.set(c.email, c.name || c.email);
    if (c.gmailEmail) nameByAddr.set(c.gmailEmail, c.name || c.email);
  }
  const clientNameFor = (d) =>
    nameByAddr.get(lc(d.gmailEmail)) || nameByAddr.get(lc(d.ownerEmail)) || lc(d.gmailEmail) || "A client";

  // Header first.
  await notifyDailySummaryHeader({
    scannedClients: clients.length,
    connectedMailboxes: connectedCount,
    notConnected,
    totalMails,
    usefulMails: usefulInWindow,
    windowHours: SUMMARY_WINDOW_HOURS,
    dateLabel: new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })
  });

  // Then one message per useful mail.
  let posted = 0;
  for (const d of usefulDocs) {
    if (SEND_GAP_MS) await sleep(SEND_GAP_MS);
    const res = await notifyUsefulMailLine({
      clientName: clientNameFor(d),
      clientEmail: lc(d.gmailEmail),
      category: d.category,
      subject: d.subject,
      from: d.from,
      receivedAt: d.date
    });
    if (res.ok) {
      posted++;
      // STAMP IT. Without this the catch-up is not a catch-up: a digest the
      // poll never managed to post would be re-posted by this summary every
      // single morning, forever. The stamp is what makes "at most once" true
      // across both delivery paths rather than just within the poll.
      await MailDigest.updateOne(
        { _id: d._id, discordPostedAt: null },
        { $set: { discordPostedAt: new Date(), discordError: "" }, $inc: { discordAttempts: 1 } }
      ).catch((e) => {
        console.error(
          `[mail-monitor] posted ${d.messageId || d._id} but could not stamp it - it may repeat: ${e.message}`
        );
      });
    }
  }

  console.log(
    `[mail-monitor] daily summary — clients=${clients.length} connected=${connectedCount} ` +
      `notConnected=${notConnected} mails=${totalMails} useful=${usefulInWindow} catchUpPosted=${posted}`
  );
  return { clients: clients.length, connectedCount, notConnected, totalMails, useful: usefulInWindow, posted };
}
