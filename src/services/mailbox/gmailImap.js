// Gmail over IMAP, authenticated with an app password.
//
// Everything here returns the SAME shapes the Gmail REST API code paths
// produce, so the hourly mail scan (mailPollWorker) and the Mails tab
// (GmailInboxRouter) work unchanged on top of it:
//
//   * Message and thread ids are Gmail's own X-GM-MSGID / X-GM-THRID, written
//     in hex. That is exactly what the REST API calls a message id, so
//     MailDigest / InboxThread / InboxMessage rows written by either path line
//     up, and switching a client between OAuth and app password never
//     re-alerts on old mail.
//   * Labels are mapped to the REST API's system ids (INBOX, UNREAD, STARRED,
//     SENT, DRAFT, SPAM, TRASH, IMPORTANT). Custom labels keep their name.
//
// One ImapFlow connection per session. Callers open a session, do their work,
// and close it (always, in finally).

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { splitAddresses, htmlToText, isTextLike } from "../../../Utils/gmailMessage.js";

export const IMAP_HOST = "imap.gmail.com";
export const IMAP_PORT = 993;

// Messages above this are fetched truncated. Gmail's own receive limit is 50 MB;
// a truncated source still parses its headers and leading body parts.
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const FETCH_CHUNK = 100;
const SNIPPET_BYTES = 2048;
const MAX_SEEN_THREADS_IN_TOKEN = 500;

// ─── Errors ─────────────────────────────────────────────────────────

/**
 * Google refused the credentials, or IMAP is switched off for the account.
 * Neither fixes itself: an operator has to replace the app password.
 * The message deliberately matches isGmailAuthError() (Utils/discordMailNotify.js).
 */
export class MailboxAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "MailboxAuthError";
    this.code = "APP_PASSWORD_REJECTED";
    this.isMailboxAuthError = true;
  }
}

const AUTH_TEXT_RE = /AUTHENTICATIONFAILED|invalid credentials|application-specific password|web login required|\[ALERT\]|not enabled for IMAP|535[- ]5\.7\.8|username and password not accepted/i;

/** Map an ImapFlow / socket error to something callers can act on. */
export function normalizeImapError(err) {
  if (!err) return new Error("IMAP: unknown error");
  if (err.isMailboxAuthError) return err;
  const text = [err.message, err.responseText, err.serverResponseCode, err.response].filter(Boolean).join(" ");
  if (err.authenticationFailed || AUTH_TEXT_RE.test(text)) {
    if (/not enabled for IMAP/i.test(text)) {
      return new MailboxAuthError("IMAP is disabled for this Gmail account (APP_PASSWORD_REJECTED)");
    }
    return new MailboxAuthError(
      `Gmail rejected the app password: AUTHENTICATIONFAILED${err.responseText ? ` (${String(err.responseText).slice(0, 120)})` : ""}`
    );
  }
  const out = new Error(`IMAP error: ${text || err.code || "unknown"}`.slice(0, 400));
  out.code = err.code;
  out.cause = err;
  return out;
}

// ─── Ids ────────────────────────────────────────────────────────────

/** Gmail decimal X-GM-MSGID / X-GM-THRID → REST API hex id. */
export function gmIdToHex(dec) {
  if (dec === undefined || dec === null || dec === "") return "";
  return BigInt(String(dec)).toString(16);
}

/** REST API hex id → decimal for X-GM-MSGID / X-GM-THRID searches. Throws on junk. */
export function hexToGmId(hex) {
  const s = String(hex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{1,20}$/.test(s)) {
    const e = new Error("invalid_gmail_id");
    e.status = 400;
    throw e;
  }
  return BigInt(`0x${s}`).toString();
}

// ─── Labels ─────────────────────────────────────────────────────────

const SYSTEM_LABEL_MAP = {
  "\\inbox": "INBOX",
  "\\sent": "SENT",
  "\\important": "IMPORTANT",
  "\\starred": "STARRED",
  "\\draft": "DRAFT",
  "\\drafts": "DRAFT",
  "\\spam": "SPAM",
  "\\junk": "SPAM",
  "\\trash": "TRASH"
};

/** IMAP X-GM-LABELS + flags (+ the folder it was read from) → REST-style labelIds. */
export function toLabelIds({ labels, flags, folderLabel } = {}) {
  const out = new Set();
  for (const l of labels || []) {
    const mapped = SYSTEM_LABEL_MAP[String(l).toLowerCase()];
    if (mapped) out.add(mapped);
    else if (l) out.add(String(l));
  }
  const f = flags || new Set();
  if (!f.has("\\Seen")) out.add("UNREAD");
  if (f.has("\\Flagged")) out.add("STARRED");
  if (f.has("\\Draft")) out.add("DRAFT");
  if (folderLabel) out.add(folderLabel);
  return Array.from(out);
}

// Which folder to open, and what Gmail search to run inside it, for one of
// the Mails tab filters. Spam, Trash and Drafts are separate folders; every
// other view is a search over All Mail.
export function viewForLabel(labelId) {
  switch (String(labelId || "").toUpperCase()) {
    case "SPAM":
      return { specialUse: "\\Junk", raw: "", folderLabel: "SPAM" };
    case "TRASH":
      return { specialUse: "\\Trash", raw: "", folderLabel: "TRASH" };
    case "DRAFT":
      return { specialUse: "\\Drafts", raw: "", folderLabel: "DRAFT" };
    case "SENT":
      return { specialUse: "\\All", raw: "in:sent" };
    case "STARRED":
      return { specialUse: "\\All", raw: "is:starred" };
    case "UNREAD":
      return { specialUse: "\\All", raw: "is:unread" };
    case "IMPORTANT":
      return { specialUse: "\\All", raw: "is:important" };
    case "INBOX":
      return { specialUse: "\\All", raw: "in:inbox" };
    case "":
      return { specialUse: "\\All", raw: "" };
    default:
      // A custom label name.
      return { specialUse: "\\All", raw: `label:"${String(labelId).replace(/"/g, "")}"` };
  }
}

// ─── Page tokens ────────────────────────────────────────────────────

export function encodePageToken(t) {
  return Buffer.from(JSON.stringify(t), "utf8").toString("base64url");
}

export function decodePageToken(token) {
  if (!token) return null;
  try {
    const t = JSON.parse(Buffer.from(String(token), "base64url").toString("utf8"));
    if (!t || typeof t !== "object" || !Number.isInteger(t.beforeUid) || t.beforeUid < 1) return null;
    return { beforeUid: t.beforeUid, seen: Array.isArray(t.seen) ? t.seen.map(String).slice(-MAX_SEEN_THREADS_IN_TOKEN) : [] };
  } catch {
    return null;
  }
}

// ─── Parsing ────────────────────────────────────────────────────────

function addrText(field) {
  if (!field) return "";
  if (Array.isArray(field)) return field.map((f) => f?.text || "").filter(Boolean).join(", ");
  return field.text || "";
}

function referencesText(refs) {
  if (!refs) return "";
  return Array.isArray(refs) ? refs.join(" ") : String(refs);
}

/**
 * Parse a raw RFC 822 source into the parts both callers need.
 * `attachments` mirror the REST shape; attachmentId is "imap-<index>", an
 * index into mailparser's attachment list, resolved again on download.
 */
export async function parseSource(source) {
  const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const attachments = (parsed.attachments || [])
    .map((a, index) => ({ a, index }))
    .filter(({ a }) => a.filename || a.contentDisposition === "attachment")
    .map(({ a, index }) => ({
      attachmentId: `imap-${index}`,
      filename: a.filename || `attachment-${index + 1}`,
      mimetype: a.contentType || "application/octet-stream",
      size: Number(a.size || a.content?.length || 0),
      content: a.content
    }));
  return {
    headers: {
      from: addrText(parsed.from),
      to: splitAddresses(addrText(parsed.to)),
      cc: splitAddresses(addrText(parsed.cc)),
      bcc: splitAddresses(addrText(parsed.bcc)),
      replyTo: addrText(parsed.replyTo),
      subject: parsed.subject || "",
      rfcMessageId: parsed.messageId || "",
      inReplyTo: parsed.inReplyTo || "",
      referencesHeader: referencesText(parsed.references),
      date: parsed.date || null
    },
    html: typeof parsed.html === "string" ? parsed.html : "",
    text: parsed.text || "",
    attachments
  };
}

function makeSnippet(text, html) {
  const s = (text && text.trim()) || htmlToText(html || "");
  return s.replace(/\s+/g, " ").trim().slice(0, 200);
}

function decodeQuotedPrintable(buf) {
  const s = buf.toString("latin1").replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(s.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeCharset(buf, charset) {
  try {
    return new TextDecoder(charset || "utf-8", { fatal: false }).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

/** Decode a (possibly truncated) body part fetched for a snippet. Best effort. */
export function decodePartPreview(buf, { encoding, charset, alreadyDecoded } = {}) {
  if (!buf || !buf.length) return "";
  let bytes = buf;
  const enc = String(encoding || "").toLowerCase();
  if (!alreadyDecoded) {
    if (enc === "base64") {
      const clean = buf.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, "");
      bytes = Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), "base64");
    } else if (enc === "quoted-printable") {
      bytes = decodeQuotedPrintable(buf);
    }
  }
  return decodeCharset(bytes, charset);
}

/** The first text/plain part (else text/html) in a BODYSTRUCTURE tree. */
export function findPreviewPart(node) {
  let html = null;
  const walk = (n) => {
    if (!n) return null;
    const type = String(n.type || "").toLowerCase();
    if (type === "text/plain" && n.disposition !== "attachment") return n;
    if (type === "text/html" && n.disposition !== "attachment" && !html) html = n;
    for (const c of n.childNodes || []) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  const plain = walk(node);
  return plain || html;
}

function hasAttachmentParts(node) {
  if (!node) return false;
  if (node.disposition === "attachment" || node.dispositionParameters?.filename || node.parameters?.name) {
    return !String(node.type || "").startsWith("multipart/");
  }
  return (node.childNodes || []).some(hasAttachmentParts);
}

// ─── Client factory (test seam) ─────────────────────────────────────

let clientFactory = (opts) => new ImapFlow(opts);

/** Tests swap in a fake ImapFlow. Pass null to restore the real one. */
export function __setImapClientFactory(fn) {
  clientFactory = fn || ((opts) => new ImapFlow(opts));
}

// ─── Session ────────────────────────────────────────────────────────

export class GmailImapSession {
  constructor(client, gmailEmail) {
    this.client = client;
    this.gmailEmail = gmailEmail;
    this._folders = null;
    this._uidCache = new Map(); // hex message id → { uid, path }
  }

  /** Connect and log in. Throws MailboxAuthError when Google refuses. */
  static async open({ gmailEmail, password }) {
    const client = clientFactory({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: true,
      auth: { user: gmailEmail, pass: password },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 120_000
    });
    // An unhandled 'error' event would crash the process.
    if (typeof client.on === "function") {
      client.on("error", (e) => console.warn(`[imap] ${gmailEmail}: connection error: ${e?.message || e}`));
    }
    try {
      await client.connect();
    } catch (err) {
      try {
        client.close?.();
      } catch {
        /* already closed */
      }
      throw normalizeImapError(err);
    }
    return new GmailImapSession(client, gmailEmail);
  }

  async close() {
    try {
      await this.client.logout();
    } catch {
      try {
        this.client.close?.();
      } catch {
        /* nothing left to close */
      }
    }
  }

  async folders() {
    if (this._folders) return this._folders;
    this._folders = await this.client.list();
    return this._folders;
  }

  /** Path of a special-use folder (\All, \Junk, ...). INBOX is always "INBOX". */
  async folderPath(specialUse) {
    if (specialUse === "INBOX") return "INBOX";
    const list = await this.folders();
    const hit = list.find((f) => f.specialUse === specialUse);
    if (!hit) {
      if (specialUse === "\\All") {
        throw new Error('IMAP: the "All Mail" folder is hidden in this Gmail account (Settings > Labels > Show in IMAP)');
      }
      return null;
    }
    return hit.path;
  }

  async withFolder(path, fn) {
    const lock = await this.client.getMailboxLock(path);
    try {
      return await fn();
    } finally {
      lock.release();
    }
  }

  async _search(query) {
    const r = await this.client.search(query, { uid: true });
    return Array.isArray(r) ? r.slice().sort((a, b) => a - b) : [];
  }

  async _fetchMeta(uids, extra = {}) {
    const out = [];
    for (let i = 0; i < uids.length; i += FETCH_CHUNK) {
      const chunk = uids.slice(i, i + FETCH_CHUNK);
      const rows = await this.client.fetchAll(
        chunk,
        { uid: true, internalDate: true, emailId: true, threadId: true, labels: true, flags: true, ...extra },
        { uid: true }
      );
      out.push(...rows);
    }
    return out;
  }

  // ── Hourly scan ───────────────────────────────────────────────────

  /**
   * INBOX message ids received at or after `afterSec`, oldest first, newest
   * `max` kept. Mirrors listNewMessageIds() in mailPollWorker.
   */
  async listNewInboxIds(afterSec, max) {
    return this.withFolder("INBOX", async () => {
      // SINCE matches by day, so it returns a superset; the exact cut is below.
      let uids = await this._search({ since: new Date(afterSec * 1000) });
      if (uids.length > max * 10) uids = uids.slice(-max * 10);
      const rows = await this._fetchMeta(uids);
      const cutoff = afterSec * 1000;
      const fresh = rows
        .filter((r) => r.emailId && new Date(r.internalDate).getTime() >= cutoff)
        .sort((a, b) => new Date(b.internalDate) - new Date(a.internalDate))
        .slice(0, max)
        .reverse();
      return fresh.map((r) => {
        const id = gmIdToHex(r.emailId);
        this._uidCache.set(id, { uid: r.uid, path: "INBOX" });
        return id;
      });
    });
  }

  /** Full source of one message by hex id, looked up in INBOX, All Mail, Spam, Trash. */
  async _fetchSourceById(hexId) {
    const cached = this._uidCache.get(hexId);
    if (cached) {
      const row = await this.withFolder(cached.path, () =>
        this.client.fetchOne(
          String(cached.uid),
          { uid: true, source: { maxLength: MAX_SOURCE_BYTES }, internalDate: true, emailId: true, threadId: true, labels: true, flags: true },
          { uid: true }
        )
      );
      if (row) return { row, path: cached.path };
    }
    const dec = hexToGmId(hexId);
    for (const special of ["INBOX", "\\All", "\\Junk", "\\Trash"]) {
      const path = await this.folderPath(special);
      if (!path) continue;
      const found = await this.withFolder(path, async () => {
        const uids = await this._search({ emailId: dec });
        if (!uids.length) return null;
        return this.client.fetchOne(
          String(uids[0]),
          { uid: true, source: { maxLength: MAX_SOURCE_BYTES }, internalDate: true, emailId: true, threadId: true, labels: true, flags: true },
          { uid: true }
        );
      });
      if (found) return { row: found, path, special };
    }
    return null;
  }

  /**
   * Same shape as mailPollWorker's fetchMessage():
   * { meta, snippet, threadId, internalDate, bodyText, textAttachments, allAttachments }
   */
  async fetchMessageForScan(hexId, { maxAttachmentBytes = 7_500_000 } = {}) {
    const hit = await this._fetchSourceById(hexId);
    if (!hit) throw new Error(`IMAP: message ${hexId} not found`);
    const { row } = hit;
    const p = await parseSource(row.source);
    const labels = toLabelIds({ labels: row.labels, flags: row.flags });
    const allAttachments = p.attachments.map(({ content, ...meta }) => meta);
    const textAttachments = p.attachments
      .filter((a) => isTextLike(a) && a.size <= maxAttachmentBytes)
      .map(({ content, ...meta }) => ({ ...meta, buffer: content, text: content.toString("utf8") }));
    const internalDate = new Date(row.internalDate).getTime() || 0;
    return {
      meta: {
        ...p.headers,
        date: internalDate ? new Date(internalDate) : p.headers.date,
        labels,
        isUnread: labels.includes("UNREAD")
      },
      snippet: makeSnippet(p.text, p.html),
      threadId: gmIdToHex(row.threadId),
      internalDate,
      bodyText: (p.text || "").trim() || htmlToText(p.html),
      textAttachments,
      allAttachments
    };
  }

  // ── Mails tab ─────────────────────────────────────────────────────

  /** Folder list in the REST /labels shape. */
  async labels() {
    const list = await this.client.list({ statusQuery: { messages: true, unseen: true } });
    const bySpecial = {
      "\\Sent": "SENT",
      "\\Drafts": "DRAFT",
      "\\Junk": "SPAM",
      "\\Trash": "TRASH",
      "\\Flagged": "STARRED",
      "\\Important": "IMPORTANT"
    };
    const out = [];
    for (const f of list) {
      if (f.flags?.has?.("\\Noselect")) continue;
      if (f.specialUse === "\\All") continue;
      const id = f.path === "INBOX" ? "INBOX" : bySpecial[f.specialUse] || f.path;
      out.push({
        id,
        name: f.path === "INBOX" ? "INBOX" : f.name,
        type: id === f.path && f.path !== "INBOX" ? "user" : "system",
        messagesUnread: f.status?.unseen || 0,
        messagesTotal: f.status?.messages || 0
      });
    }
    return out;
  }

  /**
   * One page of threads for a Mails tab view, newest first.
   * Returns { threads: [threadSummary], nextPageToken, resultSizeEstimate }.
   * threadSummary carries everything listAndCacheThreads() stores.
   */
  async listThreads({ labelId, q, pageToken, maxResults = 25 }) {
    const view = viewForLabel(labelId);
    const path = await this.folderPath(view.specialUse);
    if (!path) return { threads: [], nextPageToken: null, resultSizeEstimate: 0 };
    const raw = [view.raw, String(q || "").trim()].filter(Boolean).join(" ");
    const page = decodePageToken(pageToken);
    const seen = new Set(page?.seen || []);

    return this.withFolder(path, async () => {
      let uids = await this._search(raw ? { gmraw: raw } : { all: true });
      const total = uids.length;
      if (page) uids = uids.filter((u) => u < page.beforeUid);

      // Walk newest → oldest, grouping by thread, until a page is full.
      const picked = new Map(); // threadDec → newest matching row
      let lowestScanned = null;
      for (let end = uids.length; end > 0 && picked.size < maxResults; end -= FETCH_CHUNK) {
        const chunk = uids.slice(Math.max(0, end - FETCH_CHUNK), end);
        const rows = (await this._fetchMeta(chunk, { envelope: true, bodyStructure: true })).sort((a, b) => b.uid - a.uid);
        for (const r of rows) {
          lowestScanned = r.uid;
          const t = String(r.threadId || r.emailId || r.uid);
          if (seen.has(t) || picked.has(t)) continue;
          picked.set(t, r);
          if (picked.size >= maxResults) break;
        }
      }
      if (!picked.size) return { threads: [], nextPageToken: null, resultSizeEstimate: total };

      // Full thread stats come from the whole thread, not just the matching
      // message: one OR-search plus one fetch for the page. Spam, Trash and
      // Drafts are counted inside their own folder.
      const threadDecs = Array.from(picked.keys()).filter((t) => /^\d+$/.test(t));
      let members = [];
      if (threadDecs.length) {
        const query = threadDecs.length === 1 ? { threadId: threadDecs[0] } : { or: threadDecs.map((t) => ({ threadId: t })) };
        const memberUids = await this._search(query);
        members = await this._fetchMeta(memberUids, { envelope: true, bodyStructure: true });
      }
      const byThread = new Map();
      for (const m of members) {
        const t = String(m.threadId);
        if (!byThread.has(t)) byThread.set(t, []);
        byThread.get(t).push(m);
      }

      const threads = [];
      for (const [t, newest] of picked) {
        const msgs = (byThread.get(t) || [newest]).sort((a, b) => new Date(a.internalDate) - new Date(b.internalDate));
        const last = msgs[msgs.length - 1];
        const allLabels = new Set();
        const participants = new Set();
        let unread = 0;
        let hasAttach = false;
        for (const m of msgs) {
          const ids = toLabelIds({ labels: m.labels, flags: m.flags, folderLabel: view.folderLabel });
          ids.forEach((l) => allLabels.add(l));
          if (ids.includes("UNREAD")) unread++;
          const env = m.envelope || {};
          for (const a of env.from || []) participants.add(a.name ? `${a.name} <${a.address}>` : a.address);
          for (const a of env.to || []) participants.add(a.name ? `${a.name} <${a.address}>` : a.address);
          if (hasAttachmentParts(m.bodyStructure)) hasAttach = true;
        }
        const env = last.envelope || {};
        const fromA = (env.from || [])[0];
        threads.push({
          threadId: gmIdToHex(last.threadId || t),
          subject: env.subject || "",
          fromLatest: fromA ? (fromA.name ? `${fromA.name} <${fromA.address}>` : fromA.address || "") : "",
          participants: Array.from(participants).filter(Boolean),
          lastMessageAt: last.internalDate ? new Date(last.internalDate) : null,
          messageCount: msgs.length,
          unreadCount: unread,
          labels: Array.from(allLabels),
          hasAttachments: hasAttach,
          snippet: await this._snippetFor(last)
        });
      }

      const moreLeft = lowestScanned !== null && uids.some((u) => u < lowestScanned);
      const nextPageToken = moreLeft
        ? encodePageToken({
            beforeUid: lowestScanned,
            seen: [...seen, ...picked.keys()].slice(-MAX_SEEN_THREADS_IN_TOKEN)
          })
        : null;
      return { threads, nextPageToken, resultSizeEstimate: total };
    });
  }

  async _snippetFor(row) {
    try {
      const part = findPreviewPart(row.bodyStructure);
      if (!part) return "";
      const key = part.part || "1";
      const got = await this.client.fetchOne(
        String(row.uid),
        { uid: true, bodyParts: [{ key, maxLength: SNIPPET_BYTES }] },
        { uid: true }
      );
      const buf = got?.bodyParts?.get(key);
      const text = decodePartPreview(buf, {
        encoding: part.encoding,
        charset: part.parameters?.charset,
        alreadyDecoded: got?.binaryParts?.has?.(key)
      });
      return makeSnippet(String(part.type).toLowerCase() === "text/html" ? "" : text, String(part.type).toLowerCase() === "text/html" ? text : "");
    } catch {
      return "";
    }
  }

  /** Hex message ids in a thread, oldest first. Looks in All Mail, then Spam/Trash. */
  async threadMessageIds(threadHex) {
    const dec = hexToGmId(threadHex);
    for (const special of ["\\All", "\\Junk", "\\Trash", "\\Drafts"]) {
      const path = await this.folderPath(special);
      if (!path) continue;
      const rows = await this.withFolder(path, async () => {
        const uids = await this._search({ threadId: dec });
        return uids.length ? this._fetchMeta(uids) : [];
      });
      if (rows.length) {
        return rows
          .sort((a, b) => new Date(a.internalDate) - new Date(b.internalDate))
          .map((r) => {
            const id = gmIdToHex(r.emailId);
            this._uidCache.set(id, { uid: r.uid, path });
            return id;
          });
      }
    }
    return [];
  }

  /**
   * One full message for the Mails tab cache (InboxMessage + R2 bodies).
   * Returns { threadId, meta, snippet, html, text, attachments(meta only) }.
   */
  async fetchMessageForInbox(hexId) {
    const hit = await this._fetchSourceById(hexId);
    if (!hit) return null;
    const { row, special } = hit;
    const p = await parseSource(row.source);
    const folderLabel = special === "\\Junk" ? "SPAM" : special === "\\Trash" ? "TRASH" : undefined;
    const labels = toLabelIds({ labels: row.labels, flags: row.flags, folderLabel });
    const internalDate = new Date(row.internalDate).getTime() || 0;
    return {
      threadId: gmIdToHex(row.threadId),
      meta: {
        ...p.headers,
        date: internalDate ? new Date(internalDate) : p.headers.date,
        labels,
        isUnread: labels.includes("UNREAD")
      },
      snippet: makeSnippet(p.text, p.html),
      html: p.html,
      text: p.text,
      attachments: p.attachments.map(({ content, ...meta }) => meta)
    };
  }

  /** Bytes of one attachment, by the "imap-<n>" id handed out in fetchMessageForInbox. */
  async attachmentContent(hexId, attachmentId) {
    const hit = await this._fetchSourceById(hexId);
    if (!hit) return null;
    const p = await parseSource(hit.row.source);
    const att = p.attachments.find((a) => a.attachmentId === attachmentId);
    return att || null;
  }
}

/** Log in and out once. Resolves on success, throws MailboxAuthError on bad credentials. */
export async function verifyImapLogin({ gmailEmail, password }) {
  const s = await GmailImapSession.open({ gmailEmail, password });
  await s.close();
  return true;
}
