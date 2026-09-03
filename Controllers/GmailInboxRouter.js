import express from "express";
import mongoose from "mongoose";
import multer from "multer";
import { GmailUser } from "../Schema_Models/GmailUser.js";
import { InboxThread } from "../Schema_Models/InboxThread.js";
import { InboxMessage } from "../Schema_Models/InboxMessage.js";
import { MailDigest } from "../Schema_Models/MailDigest.js";
import { GmailPollState } from "../Schema_Models/GmailPollState.js";
import { uploadFile } from "../Utils/storageService.js";
import { getPresignedUrl } from "../Utils/r2Storage.js";
import { pollOnce } from "../src/services/mailPollWorker.js";
import { sendEmail, isSendgridConfigured } from "../Utils/sendgridClient.js";
import { sendViaSmtp, isSmtpConfigured, verifySmtp } from "../Utils/smtpSender.js";
import { renderClientMilestoneEmail, NOTIFIABLE_CATEGORIES } from "../Utils/clientMailTemplates.js";
import { checkConnectionsAndAlert, sendDailySummary } from "../src/services/mailClientMonitor.js";
import { mailNotifyWebhook, verifyWebhook, isGmailAuthError, errorText } from "../Utils/discordMailNotify.js";
import { isMailPollEnabled } from "../src/services/mailPollWorker.js";
import { getActiveUnpausedClients } from "../Schema_Models/ClientPaymentLookup.js";
import { MailVerifierFeedback } from "../Schema_Models/MailVerifierFeedback.js";
import { decideSuppression } from "../src/services/mailVerifierLearning.js";
import { MailClassifierRule } from "../Schema_Models/MailClassifierRule.js";
import { invalidateRuleCache } from "../src/services/mailRegexLearner.js";
// This router talks to Gmail over native fetch + getAccessToken() below, not
// through googleapis — its bundled node-fetch throws ERR_STREAM_PREMATURE_CLOSE
// on Render. gmailClientForUser() is deliberately NOT imported here; only the
// pure parsing helpers are. (mailPollWorker.js still uses the googleapis client.)
import {
  decodeBase64Url,
  pickHeader,
  splitAddresses,
  extractBodies,
  normalizeMessageMeta
} from "../Utils/gmailMessage.js";

const router = express.Router();

const composeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 }
});

function encodeRfc2047(value) {
  if (typeof value !== "string" || /^[\x00-\x7F]*$/.test(value)) return value;
  const utf8 = Buffer.from(value, "utf8");
  const out = [];
  for (let i = 0; i < utf8.length; i += 57) {
    out.push(`=?UTF-8?B?${utf8.subarray(i, i + 57).toString("base64")}?=`);
  }
  return out.join("\r\n ");
}

function encodeFilename(filename) {
  if (/[^\x00-\x7F]/.test(filename)) {
    return `=?UTF-8?B?${Buffer.from(filename).toString("base64")}?=`;
  }
  if (/[()<>@,;:\\"\/\[\]?=]/.test(filename)) {
    return `"${filename.replace(/"/g, '\\"')}"`;
  }
  return filename;
}

function buildComposeMime({ from, to, cc, bcc, subject, html, text, attachments, inReplyTo, references }) {
  const mixedBoundary = `=_FFmix_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const altBoundary = `=_FFalt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeRfc2047(subject)}`,
    "MIME-Version: 1.0"
  ];
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  const altPart = (() => {
    const p = [];
    p.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    p.push("");
    if (text) {
      p.push(`--${altBoundary}`);
      p.push("Content-Type: text/plain; charset=UTF-8");
      p.push("Content-Transfer-Encoding: 7bit");
      p.push("");
      p.push(text);
      p.push("");
    }
    if (html) {
      p.push(`--${altBoundary}`);
      p.push("Content-Type: text/html; charset=UTF-8");
      p.push("Content-Transfer-Encoding: 7bit");
      p.push("");
      p.push(html);
      p.push("");
    }
    p.push(`--${altBoundary}--`);
    return p.join("\r\n");
  })();

  if (attachments && attachments.length) {
    headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
    const lines = [headers.join("\r\n"), "", `--${mixedBoundary}`, altPart];
    for (const att of attachments) {
      const fname = encodeFilename(att.filename || "attachment");
      lines.push(`--${mixedBoundary}`);
      lines.push(`Content-Type: ${att.mimetype || "application/octet-stream"}; name=${fname}`);
      lines.push(`Content-Disposition: attachment; filename=${fname}`);
      lines.push("Content-Transfer-Encoding: base64");
      lines.push("");
      const b64 = att.content.toString("base64");
      for (let i = 0; i < b64.length; i += 76) lines.push(b64.substr(i, 76));
      lines.push("");
    }
    lines.push(`--${mixedBoundary}--`);
    return lines.join("\r\n");
  }

  return headers.join("\r\n") + "\r\n" + altPart;
}

// =========================
// Auth helpers
// =========================

// In-memory cache: refreshToken -> { accessToken, expiresAt }
const _tokenCache = new Map();

// Use native fetch to refresh the access token, bypassing googleapis'
// bundled node-fetch which causes ERR_STREAM_PREMATURE_CLOSE on Render.
async function getAccessToken(refreshToken) {
  const cached = _tokenCache.get(refreshToken);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }).toString()
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  _tokenCache.set(refreshToken, {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000
  });
  return data.access_token;
}

async function resolveGmailUser(ownerEmail, gmailEmail) {
  const owner = (ownerEmail || "").toLowerCase().trim();
  if (!owner) return null;
  if (gmailEmail) {
    return GmailUser.findOne({
      ownerEmail: owner,
      email: gmailEmail.toLowerCase().trim()
    });
  }
  return GmailUser.findOne({ ownerEmail: owner }).sort({ createdAt: -1 });
}

// =========================
// R2 helpers (tagged folder per user/gmail)
// =========================
async function uploadInboxBody({ ownerEmail, gmailEmail, messageId, kind, content }) {
  if (!content) return null;
  const buffer = Buffer.from(content, "utf8");
  const folder = `inbox/${ownerEmail.replace(/[^a-z0-9._-]/gi, "_")}/${gmailEmail.replace(/[^a-z0-9._-]/gi, "_")}/bodies`;
  const filename = `${messageId}.${kind === "html" ? "html" : "txt"}`;
  const result = await uploadFile(buffer, {
    folder,
    filename,
    contentType: kind === "html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
    fileType: "inbox-body"
  });
  return result?.key || null;
}

async function uploadInboxAttachment({ ownerEmail, gmailEmail, messageId, attachment, content }) {
  const folder = `inbox/${ownerEmail.replace(/[^a-z0-9._-]/gi, "_")}/${gmailEmail.replace(/[^a-z0-9._-]/gi, "_")}/attachments/${messageId}`;
  const result = await uploadFile(content, {
    folder,
    filename: attachment.filename || attachment.attachmentId,
    contentType: attachment.mimetype || "application/octet-stream",
    fileType: "inbox-attachment"
  });
  return result?.key || null;
}

async function fetchR2BodyText(key) {
  if (!key) return "";
  try {
    const url = await getPresignedUrl(key, 60);
    const res = await fetch(url);
    if (!res.ok) return "";
    return await res.text();
  } catch (_) {
    return "";
  }
}

// =========================
// Sync / fetch logic
// =========================
async function gmailGet(accessToken, path, params = {}) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`Gmail API ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function gmailPost(accessToken, path, body = {}) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Gmail API POST ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function listAndCacheThreads({ user, ownerEmail, q, labelIds, pageToken, maxResults = 25 }) {
  const accessToken = await getAccessToken(user.refreshToken);
  const listParams = { maxResults };
  if (q) listParams.q = q;
  if (pageToken) listParams.pageToken = pageToken;
  if (labelIds && labelIds.length) listParams.labelIds = labelIds.join(",");
  const listData = await gmailGet(accessToken, "threads", listParams);

  const threads = listData.threads || [];
  const out = [];

  for (const t of threads) {
    const metaParams = new URLSearchParams({
      format: "metadata",
      "metadataHeaders": ["From", "To", "Cc", "Subject", "Date"].join("&metadataHeaders=")
    });
    const tDetailUrl = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`;
    const tDetailRes = await fetch(tDetailUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!tDetailRes.ok) continue;
    const tDetail = await tDetailRes.json();

    const msgs = tDetail.messages || [];
    if (!msgs.length) continue;

    const last = msgs[msgs.length - 1];
    const lastHeaders = last.payload?.headers || [];
    const subject = pickHeader(lastHeaders, "Subject");
    const fromLatest = pickHeader(lastHeaders, "From");

    const allLabels = new Set();
    let unread = 0;
    let hasAttach = false;
    const participants = new Set();

    for (const m of msgs) {
      (m.labelIds || []).forEach((l) => allLabels.add(l));
      if ((m.labelIds || []).includes("UNREAD")) unread++;
      const hs = m.payload?.headers || [];
      participants.add(pickHeader(hs, "From"));
      splitAddresses(pickHeader(hs, "To")).forEach((a) => participants.add(a));
      if ((m.payload?.parts || []).some((p) => p.filename)) hasAttach = true;
    }

    const lastDate = last.internalDate ? new Date(Number(last.internalDate)) : null;

    const upserted = await InboxThread.findOneAndUpdate(
      { ownerEmail, gmailEmail: user.email, threadId: t.id },
      {
        ownerEmail,
        gmailEmail: user.email,
        threadId: t.id,
        historyId: tDetail.historyId || null,
        subject,
        snippet: t.snippet || tDetail.snippet || "",
        participants: Array.from(participants).filter(Boolean),
        fromLatest,
        lastMessageAt: lastDate,
        messageCount: msgs.length,
        unreadCount: unread,
        labels: Array.from(allLabels),
        hasAttachments: hasAttach,
        lastSyncedAt: new Date()
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    out.push(upserted);
  }

  return {
    threads: out,
    nextPageToken: listData.nextPageToken || null,
    resultSizeEstimate: listData.resultSizeEstimate || 0
  };
}

async function getCachedOrFetchMessage({ user, ownerEmail, messageId }) {
  const existing = await InboxMessage.findOne({
    ownerEmail,
    gmailEmail: user.email,
    messageId
  });
  if (existing && (existing.bodyHtmlR2Key || existing.bodyTextR2Key || existing.bodyTextInline)) {
    return existing;
  }

  const accessToken = await getAccessToken(user.refreshToken);
  const detailData = await gmailGet(accessToken, `messages/${messageId}`, { format: "full" });
  const meta = normalizeMessageMeta(detailData);
  const bodies = extractBodies(detailData.payload);

  // Fetch large inline body parts that Gmail stored as anonymous attachments.
  for (const part of bodies.inlineBodyParts) {
    try {
      const attData = await gmailGet(accessToken, `messages/${messageId}/attachments/${part.attachmentId}`);
      const decoded = decodeBase64Url(attData.data || "").toString("utf8");
      if (part.mimeType === "text/html") bodies.html += decoded;
      else if (part.mimeType === "text/plain") bodies.text += decoded;
    } catch (e) {
      console.warn(`[Inbox] inline body part fetch failed ${part.attachmentId}: ${e.message}`);
    }
  }

  const htmlKey = bodies.html
    ? await uploadInboxBody({
        ownerEmail,
        gmailEmail: user.email,
        messageId,
        kind: "html",
        content: bodies.html
      })
    : null;
  const textKey = bodies.text
    ? await uploadInboxBody({
        ownerEmail,
        gmailEmail: user.email,
        messageId,
        kind: "text",
        content: bodies.text
      })
    : null;

  const doc = await InboxMessage.findOneAndUpdate(
    { ownerEmail, gmailEmail: user.email, messageId },
    {
      ownerEmail,
      gmailEmail: user.email,
      threadId: detailData.threadId,
      messageId,
      ...meta,
      snippet: detailData.snippet || "",
      bodyHtmlR2Key: htmlKey,
      bodyTextR2Key: textKey,
      bodyTextInline: !htmlKey && !textKey ? bodies.text || "" : "",
      attachments: bodies.attachments
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return doc;
}

// =========================
// Routes
// =========================

router.post("/labels", async (req, res) => {
  try {
    const { ownerEmail, gmailEmail } = req.body || {};
    const user = await resolveGmailUser(ownerEmail, gmailEmail);
    if (!user) return res.status(404).json({ error: "no_connected_gmail" });
    const accessToken = await getAccessToken(user.refreshToken);
    const r = await gmailGet(accessToken, "labels");
    const labels = (r.labels || []).map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type,
      messagesUnread: l.messagesUnread || 0,
      messagesTotal: l.messagesTotal || 0
    }));
    res.json({ labels, gmailEmail: user.email });
  } catch (err) {
    console.error("[Inbox] labels error:", err?.response?.data || err.message);
    res.status(500).json({ error: err?.message || "labels_failed" });
  }
});

router.post("/threads", async (req, res) => {
  try {
    const { ownerEmail, gmailEmail, q, labelIds, pageToken, maxResults } = req.body || {};
    const user = await resolveGmailUser(ownerEmail, gmailEmail);
    if (!user) return res.status(404).json({ error: "no_connected_gmail" });

    const result = await listAndCacheThreads({
      user,
      ownerEmail: user.ownerEmail,
      q,
      labelIds,
      pageToken,
      maxResults: Math.min(50, Number(maxResults) || 25)
    });

    res.json({
      gmailEmail: user.email,
      nextPageToken: result.nextPageToken,
      resultSizeEstimate: result.resultSizeEstimate,
      threads: result.threads.map((t) => ({
        threadId: t.threadId,
        subject: t.subject,
        snippet: t.snippet,
        fromLatest: t.fromLatest,
        participants: t.participants,
        lastMessageAt: t.lastMessageAt,
        messageCount: t.messageCount,
        unreadCount: t.unreadCount,
        labels: t.labels,
        hasAttachments: t.hasAttachments
      }))
    });
  } catch (err) {
    console.error("[Inbox] threads error:", err?.response?.data || err.message);
    res.status(500).json({ error: err?.message || "threads_failed" });
  }
});

router.post("/thread/:threadId", async (req, res) => {
  try {
    const { ownerEmail, gmailEmail } = req.body || {};
    const { threadId } = req.params;
    const user = await resolveGmailUser(ownerEmail, gmailEmail);
    if (!user) return res.status(404).json({ error: "no_connected_gmail" });

    const accessToken = await getAccessToken(user.refreshToken);
    const tDetail = await gmailGet(accessToken, `threads/${threadId}`, { format: "minimal" });
    const msgIds = (tDetail.messages || []).map((m) => m.id);

    const messages = [];
    for (const id of msgIds) {
      const doc = await getCachedOrFetchMessage({
        user,
        ownerEmail: user.ownerEmail,
        messageId: id
      });
      const html = doc.bodyHtmlR2Key ? await fetchR2BodyText(doc.bodyHtmlR2Key) : "";
      const text = doc.bodyTextR2Key ? await fetchR2BodyText(doc.bodyTextR2Key) : doc.bodyTextInline || "";
      messages.push({
        messageId: doc.messageId,
        threadId: doc.threadId,
        from: doc.from,
        to: doc.to,
        cc: doc.cc,
        bcc: doc.bcc,
        replyTo: doc.replyTo,
        subject: doc.subject,
        date: doc.date,
        snippet: doc.snippet,
        labels: doc.labels,
        isUnread: doc.isUnread,
        rfcMessageId: doc.rfcMessageId,
        bodyHtml: html,
        bodyText: text,
        attachments: (doc.attachments || []).map((a) => ({
          attachmentId: a.attachmentId,
          filename: a.filename,
          mimetype: a.mimetype,
          size: a.size,
          cached: !!a.r2Key
        }))
      });
    }

    res.json({ threadId, messages });
  } catch (err) {
    console.error("[Inbox] thread error:", err?.response?.data || err.message);
    res.status(500).json({ error: err?.message || "thread_failed" });
  }
});

router.post("/message/:messageId/attachment/:attachmentId", async (req, res) => {
  try {
    const { ownerEmail, gmailEmail } = req.body || {};
    const { messageId, attachmentId } = req.params;
    const user = await resolveGmailUser(ownerEmail, gmailEmail);
    if (!user) return res.status(404).json({ error: "no_connected_gmail" });

    const msg = await InboxMessage.findOne({
      ownerEmail: user.ownerEmail,
      gmailEmail: user.email,
      messageId
    });
    if (!msg) return res.status(404).json({ error: "message_not_cached" });

    const att = (msg.attachments || []).find((a) => a.attachmentId === attachmentId);
    if (!att) return res.status(404).json({ error: "attachment_not_found" });

    if (!att.r2Key) {
      const accessToken = await getAccessToken(user.refreshToken);
      const r = await gmailGet(accessToken, `messages/${messageId}/attachments/${attachmentId}`);
      const buf = decodeBase64Url(r.data);
      const key = await uploadInboxAttachment({
        ownerEmail: user.ownerEmail,
        gmailEmail: user.email,
        messageId,
        attachment: att,
        content: buf
      });
      await InboxMessage.updateOne(
        { ownerEmail: user.ownerEmail, gmailEmail: user.email, messageId, "attachments.attachmentId": attachmentId },
        { $set: { "attachments.$.r2Key": key } }
      );
      att.r2Key = key;
    }

    const url = await getPresignedUrl(att.r2Key, 600);
    res.json({
      filename: att.filename,
      mimetype: att.mimetype,
      size: att.size,
      url
    });
  } catch (err) {
    console.error("[Inbox] attachment error:", err?.response?.data || err.message);
    res.status(500).json({ error: err?.message || "attachment_failed" });
  }
});

router.post("/modify", async (req, res) => {
  try {
    const { ownerEmail, gmailEmail, messageIds, threadIds, addLabelIds, removeLabelIds, action } =
      req.body || {};
    const user = await resolveGmailUser(ownerEmail, gmailEmail);
    if (!user) return res.status(404).json({ error: "no_connected_gmail" });
    const accessToken = await getAccessToken(user.refreshToken);

    let add = Array.isArray(addLabelIds) ? [...addLabelIds] : [];
    let remove = Array.isArray(removeLabelIds) ? [...removeLabelIds] : [];

    if (action === "markRead") remove.push("UNREAD");
    else if (action === "markUnread") add.push("UNREAD");
    else if (action === "archive") remove.push("INBOX");
    else if (action === "trash") {
      // Trash requires special endpoint
      const ids = messageIds || threadIds || [];
      for (const id of ids) {
        if (messageIds) await gmailPost(accessToken, `messages/${id}/trash`);
        else await gmailPost(accessToken, `threads/${id}/trash`);
      }
      // Update local cache
      if (messageIds?.length) {
        await InboxMessage.updateMany(
          { ownerEmail: user.ownerEmail, gmailEmail: user.email, messageId: { $in: messageIds } },
          { $addToSet: { labels: "TRASH" } }
        );
      }
      return res.json({ ok: true, trashed: ids.length });
    }

    add = Array.from(new Set(add));
    remove = Array.from(new Set(remove));

    if (Array.isArray(messageIds) && messageIds.length) {
      for (const id of messageIds) {
        await gmailPost(accessToken, `messages/${id}/modify`, { addLabelIds: add, removeLabelIds: remove });
      }
      // Update local cache
      const setOps = {};
      if (remove.includes("UNREAD")) setOps.isUnread = false;
      if (add.includes("UNREAD")) setOps.isUnread = true;
      await InboxMessage.updateMany(
        { ownerEmail: user.ownerEmail, gmailEmail: user.email, messageId: { $in: messageIds } },
        {
          ...(Object.keys(setOps).length ? { $set: setOps } : {}),
          ...(add.length ? { $addToSet: { labels: { $each: add } } } : {}),
          ...(remove.length ? { $pull: { labels: { $in: remove } } } : {})
        }
      );
    }

    if (Array.isArray(threadIds) && threadIds.length) {
      for (const id of threadIds) {
        await gmailPost(accessToken, `threads/${id}/modify`, { addLabelIds: add, removeLabelIds: remove });
      }
      // Update local thread cache
      const incUnread = remove.includes("UNREAD") ? { unreadCount: 0 } : null;
      await InboxThread.updateMany(
        { ownerEmail: user.ownerEmail, gmailEmail: user.email, threadId: { $in: threadIds } },
        {
          ...(incUnread ? { $set: incUnread } : {}),
          ...(add.length ? { $addToSet: { labels: { $each: add } } } : {}),
          ...(remove.length ? { $pull: { labels: { $in: remove } } } : {})
        }
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[Inbox] modify error:", err?.response?.data || err.message);
    res.status(500).json({ error: err?.message || "modify_failed" });
  }
});

// Send a reply (uses threadId + In-Reply-To/References for proper threading).
router.post("/reply", async (req, res) => {
  try {
    const { ownerEmail, gmailEmail, threadId, inReplyTo, references, to, cc, subject, html, text } =
      req.body || {};
    const user = await resolveGmailUser(ownerEmail, gmailEmail);
    if (!user) return res.status(404).json({ error: "no_connected_gmail" });
    if (!to || !subject) return res.status(400).json({ error: "to_and_subject_required" });

    const accessToken = await getAccessToken(user.refreshToken);
    const boundary = `----=_FF_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const headers = [
      `To: ${Array.isArray(to) ? to.join(", ") : to}`,
      `From: ${user.email}`,
      `Subject: ${subject.startsWith("Re:") ? subject : `Re: ${subject}`}`,
      "MIME-Version: 1.0"
    ];
    if (cc) headers.push(`Cc: ${Array.isArray(cc) ? cc.join(", ") : cc}`);
    if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
    if (references) headers.push(`References: ${references}`);
    let body;
    if (html) {
      headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
      body =
        "\r\n" +
        `--${boundary}\r\n` +
        "Content-Type: text/plain; charset=UTF-8\r\n\r\n" +
        (text || "") +
        "\r\n" +
        `--${boundary}\r\n` +
        "Content-Type: text/html; charset=UTF-8\r\n\r\n" +
        html +
        "\r\n" +
        `--${boundary}--`;
    } else {
      headers.push("Content-Type: text/plain; charset=UTF-8");
      body = "\r\n" + (text || "");
    }
    const mime = headers.join("\r\n") + body;
    const raw = Buffer.from(mime).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const r = await gmailPost(accessToken, "messages/send", { raw, threadId: threadId || undefined });
    res.json({ ok: true, messageId: r.id, threadId: r.threadId });
  } catch (err) {
    console.error("[Inbox] reply error:", err?.response?.data || err.message);
    res.status(500).json({ error: err?.message || "reply_failed" });
  }
});

// Compose / forward / reply with attachments + CC + BCC.
// multipart/form-data — fields: ownerEmail, gmailEmail, to, cc?, bcc?, subject, html?, text?, threadId?, inReplyTo?, references?
router.post("/compose", composeUpload.array("attachments", 10), async (req, res) => {
  try {
    const {
      ownerEmail,
      gmailEmail,
      to,
      cc,
      bcc,
      subject,
      html,
      text,
      threadId,
      inReplyTo,
      references
    } = req.body || {};
    if (!to || !subject) return res.status(400).json({ error: "to_and_subject_required" });

    const user = await resolveGmailUser(ownerEmail, gmailEmail);
    if (!user) return res.status(404).json({ error: "no_connected_gmail" });

    const attachments = (req.files || []).map((f) => ({
      filename: f.originalname,
      mimetype: f.mimetype,
      content: f.buffer
    }));

    const mime = buildComposeMime({
      from: user.email,
      to,
      cc,
      bcc,
      subject,
      html: html || undefined,
      text: text || undefined,
      attachments,
      inReplyTo: inReplyTo || undefined,
      references: references || undefined
    });
    const raw = Buffer.from(mime).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const accessToken = await getAccessToken(user.refreshToken);
    const r = await gmailPost(accessToken, "messages/send", { raw, threadId: threadId || undefined });
    res.json({ ok: true, messageId: r.id, threadId: r.threadId });
  } catch (err) {
    console.error("[Inbox] compose error:", err?.response?.data || err.message);
    res.status(500).json({ error: err?.message || "compose_failed" });
  }
});

// Lightweight unread count for badge.
router.post("/unread-count", async (req, res) => {
  try {
    const { ownerEmail, gmailEmail } = req.body || {};
    const user = await resolveGmailUser(ownerEmail, gmailEmail);
    if (!user) return res.status(404).json({ error: "no_connected_gmail" });
    const accessToken = await getAccessToken(user.refreshToken);
    const r = await gmailGet(accessToken, "labels/INBOX");
    const inboxUnread = r.messagesUnread || 0;
    res.json({ unread: inboxUnread, gmailEmail: user.email });
  } catch (err) {
    res.status(500).json({ error: err?.message || "unread_failed" });
  }
});

// Star / unstar (helper wrapper around modify).
router.post("/star", async (req, res) => {
  try {
    const { ownerEmail, gmailEmail, threadIds, messageIds, star } = req.body || {};
    const user = await resolveGmailUser(ownerEmail, gmailEmail);
    if (!user) return res.status(404).json({ error: "no_connected_gmail" });
    const accessToken = await getAccessToken(user.refreshToken);
    const ids = threadIds || messageIds || [];
    for (const id of ids) {
      const body = star ? { addLabelIds: ["STARRED"] } : { removeLabelIds: ["STARRED"] };
      if (threadIds) await gmailPost(accessToken, `threads/${id}/modify`, body);
      else await gmailPost(accessToken, `messages/${id}/modify`, body);
    }
    if (threadIds?.length) {
      await InboxThread.updateMany(
        { ownerEmail: user.ownerEmail, gmailEmail: user.email, threadId: { $in: threadIds } },
        star ? { $addToSet: { labels: "STARRED" } } : { $pull: { labels: "STARRED" } }
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || "star_failed" });
  }
});

// =========================
// Mail → AI → Discord pipeline
// =========================

// Verifier feedback report: which sender domains the AI keeps rejecting, with
// example subjects + reasons. This is the evidence an engineer reads to
// tighten Utils/mailRulesClassifier.js deliberately (the classifier never
// rewrites itself). Sorted worst-offender first.
//   GET /gmail/mail-verify/feedback?limit=50
router.get("/mail-verify/feedback", async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const rows = await MailVerifierFeedback.find({})
      .sort({ rejectCount: -1, lastSeenAt: -1 })
      .limit(limit)
      .lean();
    res.json({
      ok: true,
      count: rows.length,
      domains: rows.map((r) => ({
        domain: r.domain,
        rejectCount: r.rejectCount,
        genuineCount: r.genuineCount,
        suppressed: decideSuppression({ domain: r.domain, rejectCount: r.rejectCount, genuineCount: r.genuineCount }),
        lastSeenAt: r.lastSeenAt,
        examples: (r.examples || []).slice(0, 5)
      }))
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || "feedback_failed" });
  }
});

// AI-learned exclusion rules: list them (with provenance + hit counts) and
// disable a bad one. Rules are written by the regex learner off verified
// false positives; see src/services/mailRegexLearner.js.
//   GET  /gmail/mail-verify/rules?status=active|disabled|all
//   POST /gmail/mail-verify/rules/:id/disable
//   POST /gmail/mail-verify/rules/:id/enable
router.get("/mail-verify/rules", async (req, res) => {
  try {
    const status = String(req.query.status || "active");
    const q = status === "all" ? {} : { status };
    const rules = await MailClassifierRule.find(q).sort({ createdAt: -1 }).limit(500).lean();
    res.json({ ok: true, count: rules.length, rules });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || "rules_failed" });
  }
});

router.post("/mail-verify/rules/:id/disable", async (req, res) => {
  try {
    const r = await MailClassifierRule.findByIdAndUpdate(req.params.id, { $set: { status: "disabled" } }, { new: true });
    if (!r) return res.status(404).json({ ok: false, error: "rule_not_found" });
    invalidateRuleCache();
    res.json({ ok: true, rule: r });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || "disable_failed" });
  }
});

router.post("/mail-verify/rules/:id/enable", async (req, res) => {
  try {
    const r = await MailClassifierRule.findByIdAndUpdate(req.params.id, { $set: { status: "active" } }, { new: true });
    if (!r) return res.status(404).json({ ok: false, error: "rule_not_found" });
    invalidateRuleCache();
    res.json({ ok: true, rule: r });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || "enable_failed" });
  }
});

// Manual trigger for the hourly poll. Useful for ops ("I just sent a test mail")
// and for verifying a freshly reconnected mailbox without waiting for the hour.
// The worker's own overlap guard makes a concurrent cron tick a no-op.
router.post("/poll-now", async (_req, res) => {
  try {
    const summary = await pollOnce({ trigger: "manual" });
    if (summary.disabled) {
      // Mail capture → AI → Discord is switched off. Say so rather than
      // reporting a successful poll that read nothing.
      return res.status(503).json({
        ok: false,
        disabled: true,
        reason: "mail_poll_disabled",
        detail: "Mail capture and Discord digests are disabled. Set MAIL_POLL_ENABLED=1 to re-enable."
      });
    }
    if (summary.skipped) {
      // A cron tick is mid-flight; this request did no work.
      return res.status(409).json({ ok: false, skipped: true, reason: "poll_already_running" });
    }
    res.json({ ok: !summary.error, ...summary });
  } catch (err) {
    res.status(500).json({ error: err?.message || "poll_failed" });
  }
});

// Stored AI digests for a mailbox — backs a future "AI summaries" view in the
// Mails tab and lets ops confirm what was pushed to Discord.
router.post("/digests", async (req, res) => {
  try {
    const { ownerEmail, gmailEmail, limit, before } = req.body || {};
    const user = await resolveGmailUser(ownerEmail, gmailEmail);
    if (!user) return res.status(404).json({ error: "no_connected_gmail" });

    const query = { gmailEmail: user.email };
    if (before) query.date = { $lt: new Date(before) };

    const digests = await MailDigest.find(query)
      .sort({ date: -1 })
      .limit(Math.min(100, Number(limit) || 25))
      .lean();

    const state = await GmailPollState.findOne({ gmailEmail: user.email }).lean();

    res.json({
      gmailEmail: user.email,
      pollState: state
        ? {
            lastPolledAt: state.lastPolledAt,
            lastSuccessAt: state.lastSuccessAt,
            totalNotified: state.totalNotified,
            authError: state.authErrorAt ? state.authErrorMessage : null,
            authErrorAt: state.authErrorAt
          }
        : null,
      digests
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || "digests_failed" });
  }
});

// =========================
// Client milestone alerts (interview / assignment / offer → the client)
// =========================

// Preview a branded alert email in the browser. GET so it renders directly:
//   /gmail/inbox/client-alert/preview?category=interview
// Sends nothing — pure template render with sample data.
router.get("/client-alert/preview", (req, res) => {
  try {
    const category = NOTIFIABLE_CATEGORIES.includes(String(req.query.category))
      ? String(req.query.category)
      : "interview";
    const sample = {
      interview: {
        subject: "Interview invitation — Backend Engineer at Acme",
        summary: "Acme's hiring team wants to schedule a 45-minute technical interview this week. They proposed Thursday or Friday afternoon and asked you to confirm a slot.",
        keyPoints: ["45-min technical round", "Thursday or Friday PM", "Reply to confirm a slot"],
        actionRequired: "Reply with your preferred time before end of day."
      },
      assessment: {
        subject: "Take-home assignment — Frontend role at Nimbus",
        summary: "Nimbus sent a take-home coding assignment. It's due in 3 days and should take about 4 hours.",
        keyPoints: ["Take-home coding task", "Due in 3 days", "~4 hours of work"],
        actionRequired: "Start the assignment and submit before the deadline."
      },
      offer: {
        subject: "Your offer from Vertex Labs",
        summary: "Vertex Labs extended a full-time offer for the Senior Engineer position, including compensation details and a start date to confirm.",
        keyPoints: ["Full-time Senior Engineer", "Comp details attached", "Start date to confirm"],
        actionRequired: "Review the offer and respond to the recruiter."
      }
    }[category];

    const { subject, html } = renderClientMilestoneEmail({
      client: { name: "Alex Carter", email: "alex@example.com" },
      digest: { category, from: "Talent Team <talent@company.com>", urls: ["https://mail.google.com/"], ...sample },
      dashboardUrl: process.env.CLIENT_DASHBOARD_URL || process.env.FRONTEND_URL || ""
    });
    res.set("Content-Type", "text/html; charset=utf-8").send(`<!-- subject: ${subject} -->\n${html}`);
  } catch (err) {
    res.status(500).send(`preview_failed: ${err?.message || "unknown"}`);
  }
});

// Send a real test alert to an address, over the configured channel (SMTP by
// default — so the send lands in the App-Password account's Sent folder).
//   body: { to, category, channel? }
router.post("/client-alert/test", async (req, res) => {
  try {
    const { to, category, channel } = req.body || {};
    if (!to) return res.status(400).json({ error: "missing_to" });
    const cat = NOTIFIABLE_CATEGORIES.includes(String(category)) ? String(category) : "interview";
    const useChannel =
      String(channel || process.env.CLIENT_MAIL_CHANNEL || "smtp").toLowerCase() === "sendgrid" ? "sendgrid" : "smtp";

    if (useChannel === "smtp" && !isSmtpConfigured()) return res.status(503).json({ error: "smtp_not_configured" });
    if (useChannel === "sendgrid" && !isSendgridConfigured()) return res.status(503).json({ error: "sendgrid_not_configured" });

    const { subject, html, text } = renderClientMilestoneEmail({
      client: { name: (to.split("@")[0] || "there"), email: to },
      digest: {
        category: cat,
        subject: `Test ${cat} alert`,
        from: "FlashFire Test <test@flashfirehq.com>",
        summary: "This is a test of the FlashFire client milestone alert email.",
        keyPoints: ["Template render check", "Delivery check"],
        urls: ["https://mail.google.com/"]
      },
      dashboardUrl: process.env.CLIENT_DASHBOARD_URL || process.env.FRONTEND_URL || ""
    });

    const result =
      useChannel === "smtp"
        ? await sendViaSmtp({ to, subject, html, text })
        : await sendEmail({
            to,
            subject,
            html,
            text,
            fromEmail: process.env.CLIENT_MAIL_FROM_EMAIL || undefined,
            fromName: process.env.CLIENT_MAIL_FROM_NAME || "FlashFire",
            categories: ["client-milestone-test"]
          });
    if (!result.ok) return res.status(502).json({ ok: false, channel: useChannel, error: result.error });
    // messageId (SMTP) is the Sent-folder receipt.
    res.json({ ok: true, to, category: cat, channel: useChannel, messageId: result.messageId, status: result.status });
  } catch (err) {
    res.status(500).json({ error: err?.message || "test_send_failed" });
  }
});

// Manually run the daily 5am summary now (header + one message per useful mail).
router.post("/daily-summary-now", async (_req, res) => {
  try {
    const result = await sendDailySummary();
    res.json({ ok: !result?.skipped, ...result });
  } catch (err) {
    res.status(500).json({ error: err?.message || "summary_failed" });
  }
});

// Manually run the "connect your mail" connection check now (throttled per client).
router.post("/connection-check-now", async (_req, res) => {
  try {
    const result = await checkConnectionsAndAlert();
    res.json({ ok: !result?.skipped, ...result });
  } catch (err) {
    res.status(500).json({ error: err?.message || "connection_check_failed" });
  }
});

// =========================
// Health check — GET /gmail/inbox/health
// =========================
// One call that verifies every moving part of the mail pipeline for real:
// Mongo, the master switch, Google OAuth config, SMTP auth (actual login),
// the Discord webhook (validity, no message posted), each connected mailbox's
// live token, and client / payment-email coverage. No secrets are returned.
router.get("/health", async (_req, res) => {
  const checks = {};
  const problems = [];
  const warnings = [];

  // 1. Mongo
  const rs = mongoose.connection.readyState;
  checks.mongo = { ok: rs === 1, state: ["disconnected", "connected", "connecting", "disconnecting"][rs] || String(rs) };
  if (!checks.mongo.ok) problems.push("MongoDB is not connected");

  // 2. Pipeline master switch
  const enabled = isMailPollEnabled();
  checks.pipeline = { ok: enabled, enabled, note: enabled ? "running" : "off (auto-on only on Render; set MAIL_POLL_ENABLED=1 to force)" };
  if (!enabled) warnings.push("Mail pipeline is disabled here (expected off outside Render)");

  // 3. Google OAuth (poller needs these to read Gmail)
  const gid = !!process.env.GOOGLE_CLIENT_ID;
  const gsec = !!process.env.GOOGLE_CLIENT_SECRET;
  checks.googleOAuth = { ok: gid && gsec, clientId: gid, clientSecret: gsec };
  if (!checks.googleOAuth.ok) problems.push("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing — Gmail cannot be read");

  // 4. SMTP — real connect + auth
  checks.smtp = await verifySmtp();
  if (!checks.smtp.ok) problems.push(`SMTP not working: ${checks.smtp.error} — client alert emails will not send`);

  // 5. Discord webhook — validity, no post
  checks.discord = { configured: !!mailNotifyWebhook(), ...(await verifyWebhook()) };
  if (!checks.discord.ok) problems.push(`Discord webhook problem: ${checks.discord.error} — no ops notifications`);

  // 6. Connected mailboxes — live token health
  try {
    const mailboxes = await GmailUser.find({ refreshToken: { $exists: true, $ne: "" } }).select("email refreshToken").lean();
    const perMailbox = [];
    for (const m of mailboxes) {
      try {
        await getAccessToken(m.refreshToken);
        perMailbox.push({ email: m.email, ok: true });
      } catch (e) {
        // Google's token error body is multi-line; collapse whitespace so the
        // JSON response stays valid and the error reads on one line.
        const msg = (errorText(e) || String(e?.message || e)).replace(/\s+/g, " ").trim();
        perMailbox.push({ email: m.email, ok: false, dead: isGmailAuthError(msg), error: msg.slice(0, 200) });
      }
    }
    const healthy = perMailbox.filter((x) => x.ok).length;
    checks.mailboxes = { connected: mailboxes.length, healthy, dead: perMailbox.filter((x) => !x.ok) };
    if (mailboxes.length && healthy === 0) problems.push("No connected mailbox has a working token");
  } catch (e) {
    checks.mailboxes = { ok: false, error: String(e?.message || e).slice(0, 160) };
  }

  // 7. Client + payment-email coverage
  try {
    const active = await getActiveUnpausedClients();
    const withPayment = active.filter((c) => c.paymentEmail).length;
    checks.clients = {
      activeUnpaused: active.length,
      withPaymentEmail: withPayment,
      withoutPaymentEmail: active.length - withPayment
    };
    if (active.length && withPayment === 0) {
      warnings.push("No active client has a paymentEmail — milestone alert emails will all be skipped");
    }
  } catch (e) {
    checks.clients = { ok: false, error: String(e?.message || e).slice(0, 160) };
  }

  checks.config = { classifier: "rules", channel: "smtp", scanActiveOnly: true, dailySummary: "05:00 IST" };

  const ok = problems.length === 0;
  res.status(ok ? 200 : 503).json({
    ok,
    summary: ok ? (warnings.length ? "working, with warnings" : "all systems go") : "problems found",
    problems,
    warnings,
    checks,
    checkedAt: new Date().toISOString()
  });
});

export default router;
