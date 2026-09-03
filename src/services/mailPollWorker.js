// mailPollWorker — hourly Gmail → gpt-4o-mini → Discord pipeline.
//
// OFF BY DEFAULT. We no longer want client mail captured, summarized, or posted
// to Discord, so this whole pipeline is inert unless MAIL_POLL_ENABLED=1 is set
// explicitly. The switch is enforced in BOTH entry points — startMailPollWorker()
// (cron + boot tick) and pollOnce() itself, which the POST /gmail/poll-now route
// calls directly and which would otherwise sail straight past the flag.
// Reading a mailbox from the dashboard's Mails tab is unaffected; those routes
// fetch on demand and never post to Discord.
//
// When enabled, every hour, for each connected Gmail mailbox (GmailUser):
//   1. ask Gmail for INBOX messages newer than the stored cursor
//   2. fetch each new message, flatten its body, decode its .txt attachments
//   3. summarize it with gpt-4o-mini (fail-open — no summary still ships)
//   4. claim it in Mongo (unique index = at-most-once), then post a rich
//      Discord embed with the client's info, the summary, the extracted links,
//      and the .txt uploaded as a real Discord file
//
// If Gmail rejects the refresh token (invalid_grant / revoked), the mailbox is
// skipped and a red "please reconnect the mail" alert goes to Discord, throttled
// per-mailbox via GmailPollState.lastAuthAlertAt so a dead token pings once every
// few hours rather than every tick.
//
// Delivery guarantees:
//   • At most once — MailDigest has a unique (gmailEmail, messageId) index, and
//     we only post when *our* upsert created the doc.
//   • At least once (eventually) — a digest whose Discord post failed keeps
//     discordPostedAt === null and is retried at the top of the next tick.
//
// Nothing here throws out of pollOnce(). One broken mailbox must not stop the rest.

import cron from "node-cron";
import { GmailUser } from "../../Schema_Models/GmailUser.js";
import { GmailPollState } from "../../Schema_Models/GmailPollState.js";
import { MailDigest } from "../../Schema_Models/MailDigest.js";
import { UserModel } from "../../Schema_Models/UserModel.js";
import { ProfileModel } from "../../Schema_Models/ProfileModel.js";
import { resolvePaymentEmail, getActiveUnpausedClients } from "../../Schema_Models/ClientPaymentLookup.js";
import { checkConnectionsAndAlert } from "./mailClientMonitor.js";
import {
  gmailClientForUser,
  decodeBase64Url,
  extractBodies,
  normalizeMessageMeta,
  htmlToText,
  parseFromHeader,
  isTextLike
} from "../../Utils/gmailMessage.js";
import { summarizeMail } from "./mailAiSummarizer.js";
import { classifyMailByRules } from "../../Utils/mailRulesClassifier.js";
import { verifyMilestoneMail, milestoneGate } from "./mailMilestoneVerifier.js";
import { shouldSuppressSender, recordVerdict } from "./mailVerifierLearning.js";
import { applyLearnedExclusions, proposeAndStoreExclusion } from "./mailRegexLearner.js";
import { notifyUsefulMailLine, notifyGmailAuthError, isGmailAuthError, errorText } from "../../Utils/discordMailNotify.js";
import {
  deriveEligibility,
  notifyClientForDigestAllChannels,
  retryPendingClientNotifications
} from "./clientMailNotifier.js";

// ─── Fixed tuning (hard-coded on purpose; no env knobs) ──────────────
const CLASSIFIER_MODE = "rules"; // zero-cost regex classifier, no OpenAI calls
const CRON_EXPR = "0 * * * *"; // hourly, on the hour
const CONCURRENCY = 2; // mailboxes polled in parallel
const SCAN_ACTIVE_ONLY = true; // only active + unpaused clients' mailboxes
const MAX_PER_TICK = 25; // mails processed per mailbox per tick (overflow resumes next tick)
const MAX_COLLECT = 200; // upper bound on message ids pulled per tick
const BOOTSTRAP_HOURS = 1; // first poll of a new mailbox looks back this far
const CURSOR_OVERLAP_SEC = 120; // re-ask this far before the cursor; dedupe makes it free
const AUTH_ALERT_THROTTLE_MS = 6 * 3600 * 1000; // dead-token alert at most once per 6h
const MAX_ATTACHMENT_BYTES = 7_500_000; // larger attachments are never downloaded
const PENDING_RETRY_HOURS = 24; // retry window for undelivered Discord digests
const MAX_DELIVERY_ATTEMPTS = 5; // give up on a digest Discord keeps rejecting

// Enable logic — the ONLY runtime input the pipeline needs is SMTP_USER/SMTP_PASS.
//   • MAIL_POLL_ENABLED=1  → force ON  (anywhere; for testing)
//   • MAIL_POLL_ENABLED=0  → force OFF (kill switch)
//   • unset                → auto-ON on the real Render deploy only.
// Keys on process.env.RENDER (present only on the Render host), NOT on NODE_ENV —
// this repo's local .env carries NODE_ENV=production and points at the PROD DB, so
// a NODE_ENV default would make a laptop poll real client inboxes. RENDER is absent
// locally, so local runs stay off unless MAIL_POLL_ENABLED=1 is set explicitly.
const _rawEnabled = process.env.MAIL_POLL_ENABLED;
const _onRender = Boolean(process.env.RENDER);
const ENABLED = _rawEnabled === "1" ? true : _rawEnabled === "0" ? false : _onRender;
const ENABLED_REASON =
  _rawEnabled === "1"
    ? "forced on (MAIL_POLL_ENABLED=1)"
    : _rawEnabled === "0"
      ? "forced off (MAIL_POLL_ENABLED=0)"
      : _onRender
        ? "auto-on (Render deploy)"
        : "off (not on Render; set MAIL_POLL_ENABLED=1 to force)";

/** Whether the Gmail → classify → alert/Discord pipeline may run at all. */
export function isMailPollEnabled() {
  return ENABLED;
}

let running = false; // overlap guard
let task = null;

// ─── Tiny worker pool ───────────────────────────────────────────────
async function runWithConcurrency(items, limit, worker) {
  const queue = items.slice();
  const inFlight = [];
  const results = [];
  while (queue.length || inFlight.length) {
    while (queue.length && inFlight.length < limit) {
      const item = queue.shift();
      const p = worker(item)
        .then((r) => results.push({ ok: true, item, r }))
        .catch((e) => results.push({ ok: false, item, error: e?.message || String(e) }))
        .finally(() => {
          const i = inFlight.indexOf(p);
          if (i !== -1) inFlight.splice(i, 1);
        });
      inFlight.push(p);
    }
    if (inFlight.length) await Promise.race(inFlight);
  }
  return results;
}

// ─── Client identity ────────────────────────────────────────────────

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// findUserByEmail: UserModel.email has no lowercase transform, so a client
// stored as "Priya@Gmail.com" would never match our lowercased mailbox key.
// Try the indexed exact match first, then fall back to an anchored
// case-insensitive match (rare, and the client collection is small).
async function findUserByEmail(email) {
  const exact = await UserModel.findOne({ email })
    .select("name email planType dashboardManager")
    .lean()
    .catch(() => null);
  if (exact) return exact;

  return UserModel.findOne({ email: new RegExp(`^${escapeRegex(email)}$`, "i") })
    .select("name email planType dashboardManager")
    .lean()
    .catch(() => null);
}

// resolveClient: map a connected mailbox back to the FlashFire client it
// belongs to, so the Discord embed can say who this mail is about.
// Tries the dashboard account first, then the profile's contact email.
async function resolveClient(gmailEmail, ownerEmail, cache) {
  const key = gmailEmail.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  let client = await findUserByEmail(key);

  if (!client) {
    const profile = await ProfileModel.findOne({
      $or: [
        { email: key },
        { contactEmail: key },
        { email: new RegExp(`^${escapeRegex(key)}$`, "i") },
        { contactEmail: new RegExp(`^${escapeRegex(key)}$`, "i") }
      ]
    })
      .select("email firstName lastName")
      .lean()
      .catch(() => null);

    if (profile?.email) {
      client =
        (await findUserByEmail(profile.email.toLowerCase())) || {
          name: [profile.firstName, profile.lastName].filter(Boolean).join(" "),
          email: profile.email
        };
    }
  }

  // Unmatched mailbox — still notify Discord with what we know.
  if (!client) client = { name: "", email: gmailEmail, planType: "", dashboardManager: ownerEmail };

  // Attach the client's stored payment email (from dashboardtrackings, shared DB).
  // This is the ONLY address client milestone alerts are sent to. Match on the
  // client's dashboard email and the connected mailbox; empty when none on file.
  const pay = await resolvePaymentEmail(client.email, key).catch(() => ({ paymentEmail: "" }));
  client = { ...client, paymentEmail: pay.paymentEmail || "" };

  cache.set(key, client);
  return client;
}

// ─── Gmail fetch ────────────────────────────────────────────────────

// listNewMessageIds: paginate INBOX for everything after the cursor, oldest-first.
// Gmail returns newest-first, so we reverse. Bounded by MAX_COLLECT.
async function listNewMessageIds(gmail, afterSec) {
  const ids = [];
  let pageToken;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      labelIds: ["INBOX"],
      q: `after:${afterSec}`,
      maxResults: 100,
      pageToken
    });
    for (const m of res.data.messages || []) ids.push(m.id);
    pageToken = res.data.nextPageToken;
  } while (pageToken && ids.length < MAX_COLLECT);

  return ids.slice(0, MAX_COLLECT).reverse(); // oldest first
}

// downloadTextAttachments: pull the bytes for text-like attachments only.
// Binary files (PDFs, images) are recorded in the digest but never fetched —
// they are not useful to the summarizer and would blow the upload budget.
async function downloadTextAttachments(gmail, messageId, attachments) {
  const out = [];
  for (const att of attachments) {
    if (!isTextLike(att)) continue;
    if (att.size > MAX_ATTACHMENT_BYTES) {
      console.warn(`[mail-poll] skip oversized attachment ${att.filename} (${att.size} bytes)`);
      continue;
    }
    try {
      const r = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: att.attachmentId
      });
      const buffer = decodeBase64Url(r.data.data || "");
      out.push({ ...att, buffer, text: buffer.toString("utf8") });
    } catch (e) {
      console.warn(`[mail-poll] attachment fetch failed ${att.filename}: ${e.message}`);
    }
  }
  return out;
}

// fetchMessage: full message → { meta, bodyText, textAttachments, allAttachments }
async function fetchMessage(gmail, messageId) {
  const detail = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const meta = normalizeMessageMeta(detail.data);
  const bodies = extractBodies(detail.data.payload);

  // Gmail parks body parts over ~2 MB as anonymous attachments with no inline data.
  for (const part of bodies.inlineBodyParts) {
    try {
      const r = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: part.attachmentId
      });
      const decoded = decodeBase64Url(r.data.data || "").toString("utf8");
      if (part.mimeType === "text/html") bodies.html += decoded;
      else if (part.mimeType === "text/plain") bodies.text += decoded;
    } catch (e) {
      console.warn(`[mail-poll] inline body part fetch failed: ${e.message}`);
    }
  }

  const bodyText = bodies.text?.trim() || htmlToText(bodies.html);
  const textAttachments = await downloadTextAttachments(gmail, messageId, bodies.attachments);

  return {
    meta,
    snippet: detail.data.snippet || "",
    threadId: detail.data.threadId || "",
    internalDate: Number(detail.data.internalDate || 0),
    bodyText,
    textAttachments,
    allAttachments: bodies.attachments
  };
}

// ─── Discord delivery ───────────────────────────────────────────────

// deliver: post one digest and record the outcome. Never throws.
//
// The two writes below are deliberately separate. Stamping discordPostedAt is
// what stops the retry pass from posting this mail a second time, so it must
// not be coupled to the cosmetic per-attachment flag: an arrayFilters failure
// would otherwise leave discordPostedAt null and duplicate the Discord message.
// deliver: post ONE short Discord update for a milestone mail (interview /
// assignment / offer). No heavy embed, no attachments, no per-mail spam for
// promos or job alerts — only the digests marked clientNotifyEligible ever get
// here. discordPostedAt is the at-most-once guard; a failed post is retried.
async function deliver({ digestDoc, client, mailbox }) {
  const result = await notifyUsefulMailLine({
    clientName: client?.name || client?.email || mailbox,
    clientEmail: mailbox,
    // An ops-eligible digest without a client category is one the AI verifier
    // could not check (outage) — tell ops it needs a human eye.
    category:
      digestDoc.clientNotifyCategory ||
      (digestDoc.verifyError ? `${digestDoc.category} (unverified — check manually)` : digestDoc.category),
    subject: digestDoc.subject,
    from: digestDoc.from,
    receivedAt: digestDoc.date
  });

  if (!result.ok) {
    await MailDigest.updateOne(
      { _id: digestDoc._id },
      { $set: { discordError: String(result.error || "unknown").slice(0, 300) }, $inc: { discordAttempts: 1 } }
    ).catch(() => {});
    console.warn(`[mail-poll] discord update failed for ${digestDoc.messageId}: ${result.error}`);
    return false;
  }

  // Mark delivered. If this throws we surface it loudly, because the update WILL
  // be re-posted on the next tick.
  try {
    await MailDigest.updateOne(
      { _id: digestDoc._id },
      { $set: { discordPostedAt: new Date(), discordError: "" }, $inc: { discordAttempts: 1 } }
    );
  } catch (e) {
    console.error(
      `[mail-poll] CRITICAL: posted ${digestDoc.messageId} to Discord but failed to mark it delivered — it may be re-posted: ${e.message}`
    );
    return true; // it did reach Discord; do not count it as a failure
  }
  return true;
}

// retryPendingDigests: milestone updates claimed but never delivered (worker
// crashed, or Discord was down). Only clientNotifyEligible digests are ever
// posted, so only those are retried. No attachments — the update is one line.
async function retryPendingDigests({ user, client, state }) {
  const cutoff = new Date(Date.now() - PENDING_RETRY_HOURS * 3600 * 1000);
  const pending = await MailDigest.find({
    gmailEmail: user.email,
    // opsNotifyEligible gates Discord since the verifier landed; the $or keeps
    // retrying pre-upgrade docs that only carry clientNotifyEligible.
    $or: [{ opsNotifyEligible: true }, { opsNotifyEligible: { $exists: false }, clientNotifyEligible: true }],
    discordPostedAt: null,
    createdAt: { $gte: cutoff },
    discordAttempts: { $lt: MAX_DELIVERY_ATTEMPTS }
  })
    .sort({ internalDate: 1 })
    .limit(MAX_PER_TICK);

  let recovered = 0;
  for (const doc of pending) {
    const ok = await deliver({ digestDoc: doc, client, mailbox: user.email });
    if (ok) recovered++;
  }

  if (recovered) {
    await GmailPollState.updateOne({ _id: state._id }, { $inc: { totalNotified: recovered } }).catch(() => {});
    state.totalNotified += recovered;
    console.log(`[mail-poll] ${user.email}: recovered ${recovered} undelivered update(s)`);
  }
  return recovered;
}

// ─── Per-mailbox poll ───────────────────────────────────────────────

async function pollMailbox(user, clientCache) {
  const mailbox = user.email;
  const ownerEmail = (user.ownerEmail || "").toLowerCase();

  let state = await GmailPollState.findOne({ gmailEmail: mailbox });
  if (!state) {
    try {
      state = await GmailPollState.create({ ownerEmail, gmailEmail: mailbox });
    } catch (e) {
      // Lost a create race against a concurrent worker — re-read the winner.
      if (e?.code !== 11000) throw e;
      state = await GmailPollState.findOne({ gmailEmail: mailbox });
    }
  }

  if (!state) throw new Error(`could not load or create poll state for ${mailbox}`);

  const client = await resolveClient(mailbox, ownerEmail, clientCache);
  const gmail = gmailClientForUser(user);

  // Deliver anything stranded from a previous tick before pulling new mail.
  await retryPendingDigests({ user, client, state }).catch((e) =>
    console.warn(`[mail-poll] ${mailbox}: pending retry failed: ${errorText(e)}`)
  );

  // Retry client milestone alerts whose SendGrid send previously failed.
  await retryPendingClientNotifications({ gmailEmail: mailbox, client, limit: MAX_PER_TICK }).catch((e) =>
    console.warn(`[mail-poll] ${mailbox}: client-notify retry failed: ${e.message}`)
  );

  const afterSec = state.lastInternalDate
    ? Math.max(0, Math.floor(state.lastInternalDate / 1000) - CURSOR_OVERLAP_SEC)
    : Math.floor((Date.now() - BOOTSTRAP_HOURS * 3600 * 1000) / 1000);

  let ids;
  try {
    ids = await listNewMessageIds(gmail, afterSec);
  } catch (err) {
    return handleMailboxError({ err, state, client, mailbox });
  }

  if (!ids.length) {
    await GmailPollState.updateOne(
      { _id: state._id },
      {
        $set: {
          lastPolledAt: new Date(),
          lastSuccessAt: new Date(),
          consecutiveFailures: 0,
          lastErrorMessage: "",
          authErrorAt: null,
          authErrorMessage: ""
        }
      }
    );
    return { mailbox, checked: 0, posted: 0 };
  }

  // Drop ids we've already digested before spending a Gmail get + an OpenAI call.
  const known = await MailDigest.find({ gmailEmail: mailbox, messageId: { $in: ids } })
    .select("messageId")
    .lean();
  const knownSet = new Set(known.map((d) => d.messageId));
  const fresh = ids.filter((id) => !knownSet.has(id)).slice(0, MAX_PER_TICK);

  if (ids.length > MAX_PER_TICK) {
    console.log(
      `[mail-poll] ${mailbox}: ${ids.length} candidates, processing oldest ${Math.min(fresh.length, MAX_PER_TICK)} this tick; remainder resumes next tick`
    );
  }

  let posted = 0;
  let maxInternalDate = state.lastInternalDate || 0;

  for (const messageId of fresh) {
    try {
      const msg = await fetchMessage(gmail, messageId);

      // Classify: rules (zero-cost, default) or AI (gpt-4o-mini) per config.
      const rawAi =
        CLASSIFIER_MODE === "ai"
          ? await summarizeMail({
              from: msg.meta.from,
              subject: msg.meta.subject,
              date: msg.meta.date,
              bodyText: msg.bodyText,
              attachments: msg.textAttachments.map((a) => ({ filename: a.filename, text: a.text }))
            })
          : classifyMailByRules({
              from: msg.meta.from,
              subject: msg.meta.subject,
              bodyText: msg.bodyText,
              snippet: msg.snippet
            });

      // Learned exclusions: AI-written, DB-stored patterns from past verified
      // false positives. A hit downgrades the category to "learned-excluded"
      // before any eligibility or AI-verification cost.
      const ai = await applyLearnedExclusions(rawAi, {
        from: msg.meta.from,
        subject: msg.meta.subject,
        bodyText: msg.bodyText
      });

      // Second-stage AI verification, ONLY for rules-flagged milestones.
      // deriveEligibility() is the cheap first gate; the verifier's job is to
      // reject the promos, auto-acks and job-board blasts whose wording slips
      // past the regexes (the 2026-08-12 Amazon auto-ack incident). Fail modes:
      //   • verifier confirms  → client email + Discord line
      //   • verifier rejects   → nothing sent, verdict stored on the digest
      //   • verifier can't run → Discord line only (ops still see it); the
      //     client is never emailed off an unverified classification.
      const provisional = deriveEligibility({
        ...ai,
        confident: ai.aiSucceeded === true || ai.matched === true
      });
      let verifyFields = {};
      let eligibility = { clientNotifyEligible: false, clientNotifyCategory: "", opsNotifyEligible: false };
      const senderEmail = parseFromHeader(msg.meta.from).email;
      // Learned suppression: a sender domain the AI has already rejected
      // repeatedly (and never once confirmed) skips the AI entirely — the
      // verdict is known, the check is free, and the alert stays silent.
      const suppression = provisional.clientNotifyEligible
        ? await shouldSuppressSender(senderEmail)
        : { suppress: false };
      if (provisional.clientNotifyEligible && suppression.suppress) {
        eligibility = {
          clientNotifyEligible: false,
          clientNotifyCategory: "",
          opsNotifyEligible: false,
          clientNotifySkippedReason: `learned_suppression:${suppression.domain}(${suppression.rejectCount} rejections)`
        };
        console.log(
          `[mail-learn] ${mailbox}: suppressed ${ai.category} candidate from ${suppression.domain} (${suppression.rejectCount} prior AI rejections) (${messageId})`
        );
      } else if (provisional.clientNotifyEligible) {
        const verdict = await verifyMilestoneMail({
          from: msg.meta.from,
          subject: msg.meta.subject,
          bodyText: msg.bodyText,
          snippet: msg.snippet,
          rulesCategory: ai.category
        });
        // Feed the loop: every real AI verdict updates the per-domain counters
        // and evidence list that drive suppression + future regex tightening.
        await recordVerdict({ fromEmail: senderEmail, rulesCategory: ai.category, subject: msg.meta.subject, verdict });
        // Verified false positive → have the AI write a DB-stored exclusion
        // pattern so this kind of mail dies at the regex stage next time.
        // Validation + genuine-mail regression checks happen inside; a
        // rejected proposal just means the other layers keep covering it.
        if (verdict.ok && !verdict.genuine) {
          const learned = await proposeAndStoreExclusion({
            mail: { from: msg.meta.from, subject: msg.meta.subject, bodyText: msg.bodyText },
            rulesCategory: ai.category,
            verdict
          });
          if (learned.stored) {
            console.log(`[mail-regex] ${mailbox}: new exclusion /${learned.pattern}/i from ${messageId}`);
          }
        }
        const gate = milestoneGate(verdict);
        verifyFields = {
          verifyRan: true,
          verifyGenuine: verdict.genuine,
          verifyCategory: verdict.category,
          verifyConfidence: verdict.confidence,
          verifyReason: verdict.reason,
          verifyModel: verdict.model,
          verifyError: verdict.error
        };
        eligibility = gate.eligible
          ? { clientNotifyEligible: true, clientNotifyCategory: gate.category, opsNotifyEligible: true }
          : {
              clientNotifyEligible: false,
              clientNotifyCategory: "",
              // Unverifiable (AI down) still reaches Discord; a verified
              // rejection reaches nobody.
              opsNotifyEligible: !verdict.ok,
              clientNotifySkippedReason: gate.reason
            };
        if (!gate.eligible) {
          console.log(
            `[mail-verify] ${mailbox}: ${verdict.ok ? "rejected" : "unverifiable"} ${ai.category} candidate (${messageId}): ${gate.reason}`
          );
        }
      }

      const uploadedNames = new Set(msg.textAttachments.map((a) => a.filename));
      const doc = {
        ownerEmail,
        gmailEmail: mailbox,
        threadId: msg.threadId,
        messageId,
        from: msg.meta.from,
        fromEmail: parseFromHeader(msg.meta.from).email,
        subject: msg.meta.subject,
        snippet: msg.snippet,
        date: msg.meta.date,
        internalDate: msg.internalDate,
        summary: ai.summary,
        keyPoints: ai.keyPoints,
        category: ai.category,
        priority: ai.priority,
        actionRequired: ai.actionRequired,
        urls: ai.urls,
        aiModel: ai.aiModel,
        aiSucceeded: ai.aiSucceeded,
        aiError: ai.aiError,
        attachments: msg.allAttachments.map((a) => ({
          attachmentId: a.attachmentId,
          filename: a.filename,
          mimetype: a.mimetype,
          size: a.size,
          uploadable: uploadedNames.has(a.filename),
          uploadedToDiscord: false // flipped below once Discord accepts the post
        })),
        discordPostedAt: null,
        // Eligibility decided once (rules gate + AI verification above) and
        // stored so the retry sweeps and any future UI read it without
        // re-classifying or re-verifying.
        ...verifyFields,
        ...eligibility
      };

      // Claim the message by inserting it. The unique (gmailEmail, messageId)
      // index makes this the atomic gate: exactly one worker's insert wins, so
      // exactly one Discord post happens — even if the cursor replays a second
      // or a second instance polls the same mailbox. A duplicate-key error means
      // someone else owns this mail; skip it.
      let digestDoc;
      try {
        digestDoc = await MailDigest.create(doc);
      } catch (e) {
        if (e?.code === 11000) {
          maxInternalDate = Math.max(maxInternalDate, msg.internalDate);
          continue;
        }
        throw e;
      }

      // Discord update ONLY for verified milestones (or unverifiable ones the
      // ops team should eyeball). Promos, job alerts, newsletters, rejections,
      // recruiter outreach and VERIFIED false positives are stored and counted
      // in the 5 AM summary, but never posted per-mail.
      if (digestDoc.opsNotifyEligible) {
        const ok = await deliver({ digestDoc, client, mailbox });
        if (ok) posted++;
      }

      // Client milestone alert (interview / assignment / offer) over the payment
      // email AND the client's Mattermost channel, both gated on the per-client
      // opt-in in the Client Reminders tab. Independent of Discord and
      // fail-soft: a send failure is recorded on the digest and retried on a
      // later tick, never blocking the poll. Each channel is at-most-once on
      // its own stamp, so a retry cannot double-deliver either half.
      try {
        const outcome = await notifyClientForDigestAllChannels({ digestDoc, client, mailbox });
        if (outcome.email === "sent" || outcome.mattermost === "sent") {
          console.log(
            `[client-notify] ${mailbox}: alerted client — ${digestDoc.clientNotifyCategory} (${messageId}) ` +
              `email=${outcome.email} mattermost=${outcome.mattermost}`
          );
        }
      } catch (e) {
        console.warn(`[client-notify] ${mailbox}: unexpected error for ${messageId}: ${e.message}`);
      }

      maxInternalDate = Math.max(maxInternalDate, msg.internalDate);
    } catch (err) {
      // An auth failure mid-loop means every remaining message will fail too —
      // bail out of the mailbox rather than burning 24 more Gmail calls.
      if (isGmailAuthError(errorText(err))) {
        return handleMailboxError({ err, state, client, mailbox, partialPosted: posted, maxInternalDate });
      }
      console.warn(`[mail-poll] ${mailbox}: message ${messageId} failed: ${errorText(err)}`);
    }
  }

  await GmailPollState.updateOne(
    { _id: state._id },
    {
      $set: {
        lastInternalDate: maxInternalDate,
        lastPolledAt: new Date(),
        lastSuccessAt: new Date(),
        consecutiveFailures: 0,
        lastErrorMessage: "",
        authErrorAt: null,
        authErrorMessage: ""
      },
      $inc: { totalNotified: posted }
    }
  );

  console.log(`[mail-poll] ${mailbox}: checked=${fresh.length} posted=${posted}`);
  return { mailbox, checked: fresh.length, posted };
}

// handleMailboxError: classify, persist, and (for auth failures) alert Discord
// under a DB-backed throttle so restarts don't re-spam the channel.
async function handleMailboxError({ err, state, client, mailbox, partialPosted = 0, maxInternalDate }) {
  const message = (errorText(err) || String(err)).slice(0, 400);

  if (!isGmailAuthError(message)) {
    await GmailPollState.updateOne(
      { _id: state._id },
      {
        $set: { lastPolledAt: new Date(), lastErrorMessage: message },
        $inc: { consecutiveFailures: 1, ...(partialPosted ? { totalNotified: partialPosted } : {}) },
        ...(maxInternalDate ? { $max: { lastInternalDate: maxInternalDate } } : {})
      }
    ).catch(() => {});
    console.error(`[mail-poll] ${mailbox}: transient failure: ${message}`);
    return { mailbox, checked: 0, posted: partialPosted, error: message };
  }

  const now = Date.now();
  const lastAlert = state.lastAuthAlertAt ? new Date(state.lastAuthAlertAt).getTime() : 0;
  const shouldAlert = now - lastAlert >= AUTH_ALERT_THROTTLE_MS;

  const update = {
    $set: {
      lastPolledAt: new Date(),
      authErrorMessage: message,
      lastErrorMessage: message,
      ...(state.authErrorAt ? {} : { authErrorAt: new Date() })
    },
    $inc: { consecutiveFailures: 1, ...(partialPosted ? { totalNotified: partialPosted } : {}) },
    ...(maxInternalDate ? { $max: { lastInternalDate: maxInternalDate } } : {})
  };
  if (shouldAlert) update.$set.lastAuthAlertAt = new Date();

  await GmailPollState.updateOne({ _id: state._id }, update).catch(() => {});

  if (shouldAlert) {
    console.error(`[mail-poll] ${mailbox}: AUTH ERROR — alerting Discord: ${message}`);
    await notifyGmailAuthError({
      client,
      mailbox,
      error: message,
      since: state.authErrorAt || new Date()
    }).catch((e) => console.error(`[mail-poll] auth alert post failed: ${e.message}`));
  } else {
    console.error(`[mail-poll] ${mailbox}: AUTH ERROR (alert throttled): ${message}`);
  }

  return { mailbox, checked: 0, posted: partialPosted, authError: message };
}

// ─── Tick ───────────────────────────────────────────────────────────

export async function pollOnce({ trigger = "cron" } = {}) {
  // Checked here, not only in startMailPollWorker(): POST /gmail/poll-now calls
  // pollOnce() directly. Without this, the route would still read every mailbox
  // and post to Discord while the worker reported itself disabled.
  if (!ENABLED) {
    console.log(`[mail-poll] disabled (${ENABLED_REASON}) — ignoring ${trigger} trigger`);
    return { disabled: true };
  }
  if (running) {
    console.log("[mail-poll] previous tick still running — skip");
    return { skipped: true };
  }
  running = true;
  const startedAt = Date.now();

  try {
    // The at-most-once guarantee rests on these unique indexes existing. Model.init()
    // resolves once they are built (and is memoized, so this is free after the first tick).
    await Promise.all([MailDigest.init(), GmailPollState.init()]);

    const allMailboxes = await GmailUser.find({ refreshToken: { $exists: true, $ne: "" } }).lean();

    // Scope to active + unpaused clients: don't read the inbox of a paused or
    // inactive client. A mailbox belongs to an active client when its email OR
    // ownerEmail matches an active client's email (or their gmailCredentials).
    // MAIL_SCAN_ACTIVE_ONLY=0 disables the scoping (scan every connected mailbox).
    let mailboxes = allMailboxes;
    let skippedInactive = 0;
    if (SCAN_ACTIVE_ONLY && allMailboxes.length) {
      const activeClients = await getActiveUnpausedClients().catch(() => []);
      const activeAddrs = new Set();
      for (const c of activeClients) {
        if (c.email) activeAddrs.add(c.email);
        if (c.gmailEmail) activeAddrs.add(c.gmailEmail);
      }
      mailboxes = allMailboxes.filter((m) => {
        const belongs = activeAddrs.has((m.email || "").toLowerCase()) || activeAddrs.has((m.ownerEmail || "").toLowerCase());
        return belongs;
      });
      skippedInactive = allMailboxes.length - mailboxes.length;
      if (skippedInactive) {
        console.log(`[mail-poll] scoped to active clients — scanning ${mailboxes.length}, skipped ${skippedInactive} (paused/inactive/unlinked)`);
      }
    }

    // The hourly connection check runs regardless of how many mailboxes there are
    // (its job is to nudge the active clients who have NO mailbox). Fire-and-record.
    const connectionCheck = await checkConnectionsAndAlert().catch((e) => {
      console.warn(`[mail-poll] connection check failed: ${e.message}`);
      return null;
    });

    if (!mailboxes.length) {
      console.log("[mail-poll] no active-client mailboxes to scan");
      return { mailboxes: 0, posted: 0, skippedInactive, connectionCheck, tookMs: Date.now() - startedAt };
    }

    const clientCache = new Map();
    const results = await runWithConcurrency(mailboxes, CONCURRENCY, (u) => pollMailbox(u, clientCache));

    const posted = results.reduce((n, r) => n + (r.r?.posted || 0), 0);
    const checked = results.reduce((n, r) => n + (r.r?.checked || 0), 0);
    const authErrors = results.filter((r) => r.r?.authError).length;
    const crashed = results.filter((r) => !r.ok);

    for (const c of crashed) {
      console.error(`[mail-poll] mailbox ${c.item?.email} crashed: ${c.error}`);
    }

    console.log(
      `[mail-poll] tick done (${trigger}) — mailboxes=${mailboxes.length} skippedInactive=${skippedInactive} checked=${checked} posted=${posted} authErrors=${authErrors} crashed=${crashed.length} tookMs=${Date.now() - startedAt}`
    );

    return {
      mailboxes: mailboxes.length,
      skippedInactive,
      connectionCheck,
      checked,
      posted,
      authErrors,
      crashed: crashed.length,
      tookMs: Date.now() - startedAt
    };
  } catch (err) {
    console.error("[mail-poll] tick crashed:", err);
    return { error: err.message, tookMs: Date.now() - startedAt };
  } finally {
    running = false;
  }
}

export function startMailPollWorker() {
  if (!ENABLED) {
    console.log(`[mail-poll] disabled (${ENABLED_REASON}) — no mail is read, classified, alerted, or posted`);
    return null;
  }
  console.log(`[mail-poll] enabled (${ENABLED_REASON})`);
  if (task) {
    console.log("[mail-poll] already running — skip duplicate start");
    return task;
  }

  task = cron.schedule(CRON_EXPR, () => pollOnce({ trigger: "cron" }), { timezone: "Asia/Kolkata" });
  console.log(`[mail-poll] worker registered (cron='${CRON_EXPR}', classifier=${CLASSIFIER_MODE}, concurrency=${CONCURRENCY}, maxPerTick=${MAX_PER_TICK})`);
  return task;
}
