// mailClientMonitor — the client-facing half of the mail pipeline's Discord ops.
//
// One job, posting to the single ONE_MAIN_DISCORD_FOR_MAIL_NOTIFICATIONS
// channel:
//
//   sendDailySummary()  — the 5 AM IST job. Posts one header message with the
//   last-24h totals, then ONE separate message per useful mail
//   (interview / assignment / offer): "Client (Name) got: <subject> — received <time>".
//
// The hourly "please connect / please reconnect" nudges that used to live here
// were removed in Sept 2026: ops wants that channel to carry nothing but real
// interview / assignment / offer mail. Connection state is still computed
// below so the daily header can report how many mailboxes are connected.
//
// A client is linked to a connected mailbox when a GmailUser's ownerEmail OR
// email matches the client's email (or their stored gmailCredentials.email).
// Token health comes from GmailPollState.authErrorAt for that mailbox.
//
// Nothing here throws to its caller; a Discord/DB hiccup must not break the poll.

import { listConnectedMailboxSummaries } from "./mailbox/mailboxRegistry.js";
import { GmailPollState } from "../../Schema_Models/GmailPollState.js";
import { MailDigest } from "../../Schema_Models/MailDigest.js";
import { getActiveUnpausedClients } from "../../Schema_Models/ClientPaymentLookup.js";
import {
  mailNotifyWebhook,
  notifyDailySummaryHeader,
  notifyUsefulMailLine
} from "../../Utils/discordMailNotify.js";

// ─── Fixed tuning (hard-coded; no env knobs) ─────────────────────────
const SUMMARY_WINDOW_HOURS = 24; // daily summary looks back this far
// Gentle spacing between Discord posts so a burst of catch-up lines doesn't
// slam the webhook rate limit. postToWebhook also retries on 429 as a backstop.
const SEND_GAP_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (s) => String(s || "").toLowerCase().trim();

// ─── Shared: link mailboxes to clients ──────────────────────────────

// buildMailboxIndex: maps every address we might know a client by (their
// mailbox email + ownerEmail) → the healthiest mailbox state for that address.
// healthy = has a refresh token AND no recorded auth error.
async function buildMailboxIndex() {
  // App-password mailboxes count too (and win over OAuth on the same address).
  const [mailboxes, states] = await Promise.all([
    listConnectedMailboxSummaries(),
    GmailPollState.find({}).select("gmailEmail authErrorAt").lean()
  ]);
  const authErrorByMailbox = new Map(states.map((s) => [lc(s.gmailEmail), !!s.authErrorAt]));

  // address → { connected: true, dead: bool, mailbox }
  const index = new Map();
  for (const m of mailboxes) {
    const mailbox = lc(m.email);
    const dead = m.authFailed === true || authErrorByMailbox.get(mailbox) === true;
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

// ─── Daily 5 AM summary ──────────────────────────────────────────

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

  // The SAME eligibility the poll uses for its per-mail line. This is what
  // decides whether a mail is a real milestone: the rules flagged it AND the
  // AI verifier confirmed it (or could not run). The rules category on its own
  // is only a candidate - the verifier rejects most of them.
  //
  // Sept 2026 incident: this query filtered on the rules `category` alone, so
  // every candidate the verifier had REJECTED that day (a Reddit jobs digest,
  // a Workday account reminder, a Bloomberg "thank you for applying") sat
  // with discordPostedAt null and was posted here at 5 AM as "Offer" or
  // "Interview". The verifier was doing its job; this sweep bypassed it.
  const verifiedMilestone = {
    date: { $gte: since },
    $or: [{ opsNotifyEligible: true }, { opsNotifyEligible: { $exists: false }, clientNotifyEligible: true }]
  };

  const [totalMails, usefulInWindow, usefulDocs] = await Promise.all([
    MailDigest.countDocuments({ date: { $gte: since } }).catch(() => 0),
    // Headline count = every verified milestone in the window, posted or not.
    // usefulDocs below is only the unposted remainder; do not conflate them.
    MailDigest.countDocuments(verifiedMilestone).catch(() => 0),
    // discordPostedAt: null keeps this a catch-up, not a re-post: the poll
    // stamps every line it delivers, so only the handful it failed to deliver
    // (webhook 5xx, a crash between post and stamp) are left for 5 AM.
    MailDigest.find({ ...verifiedMilestone, discordPostedAt: null })
      .select("gmailEmail ownerEmail subject from date category clientNotifyCategory verifyError messageId")
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
      // Verified category first; an unverifiable one is labelled so, exactly
      // as the poll's own line does it.
      category:
        d.clientNotifyCategory || (d.verifyError ? `${d.category} (unverified — check manually)` : d.category),
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
