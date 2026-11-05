// A small in-memory stand-in for ImapFlow talking to Gmail.
//
// It implements only what src/services/mailbox/gmailImap.js calls, with
// Gmail's behaviour where it matters: X-GM-MSGID / X-GM-THRID ids, X-GM-LABELS,
// "[Gmail]/All Mail" holding everything except Spam and Trash, and a tiny
// X-GM-RAW subset (in:inbox, in:sent, is:unread, is:starred, free text).

import MailComposer from "nodemailer/lib/mail-composer/index.js";

export async function buildSource(mail) {
  return new MailComposer(mail).compile().build();
}

const FOLDERS = [
  { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
  { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All" },
  { path: "[Gmail]/Sent Mail", name: "Sent Mail", specialUse: "\\Sent" },
  { path: "[Gmail]/Drafts", name: "Drafts", specialUse: "\\Drafts" },
  { path: "[Gmail]/Spam", name: "Spam", specialUse: "\\Junk" },
  { path: "[Gmail]/Trash", name: "Trash", specialUse: "\\Trash" },
  { path: "[Gmail]/Starred", name: "Starred", specialUse: "\\Flagged" }
];

/**
 * messages: [{ emailId, threadId, labels: [...], flags: [...], internalDate, source, folder? }]
 * folder defaults to "mail" (lives in All Mail, plus INBOX when labelled \Inbox);
 * "spam" / "trash" put it only in that folder.
 */
export function createFakeGmail({ password = "abcdabcdabcdabcd", messages = [] } = {}) {
  const state = { password, messages: [], connects: 0, logouts: 0, openSessions: 0, lastAuth: null };
  let nextUid = 1;
  for (const m of messages) addMessage(m);

  function addMessage(m) {
    state.messages.push({
      uid: nextUid++,
      emailId: String(m.emailId),
      threadId: String(m.threadId ?? m.emailId),
      labels: new Set(m.labels || []),
      flags: new Set(m.flags || []),
      internalDate: new Date(m.internalDate || Date.now()),
      source: m.source,
      folder: m.folder || "mail",
      subject: m.subject || "",
      envelope: m.envelope || null,
      bodyStructure: m.bodyStructure || null
    });
  }

  function inFolder(path, msg) {
    if (path === "[Gmail]/Spam") return msg.folder === "spam";
    if (path === "[Gmail]/Trash") return msg.folder === "trash";
    if (msg.folder !== "mail") return false;
    if (path === "INBOX") return msg.labels.has("\\Inbox");
    if (path === "[Gmail]/All Mail") return true;
    if (path === "[Gmail]/Sent Mail") return msg.labels.has("\\Sent");
    if (path === "[Gmail]/Drafts") return msg.labels.has("\\Draft");
    return false;
  }

  function rawMatch(raw, msg) {
    for (const term of String(raw).split(/\s+/).filter(Boolean)) {
      if (term === "in:inbox" && !msg.labels.has("\\Inbox")) return false;
      if (term === "in:sent" && !msg.labels.has("\\Sent")) return false;
      if (term === "is:unread" && msg.flags.has("\\Seen")) return false;
      if (term === "is:starred" && !msg.flags.has("\\Flagged")) return false;
      if (!/^(in|is|label):/.test(term) && !msg.subject.toLowerCase().includes(term.toLowerCase())) return false;
    }
    return true;
  }

  function match(q, msg) {
    if (q.all) return true;
    if (q.or) return q.or.some((sub) => match(sub, msg));
    if (q.since) {
      const day = new Date(q.since);
      day.setUTCHours(0, 0, 0, 0); // SINCE ignores time, like IMAP
      if (msg.internalDate < day) return false;
    }
    if (q.emailId && msg.emailId !== String(q.emailId)) return false;
    if (q.threadId && msg.threadId !== String(q.threadId)) return false;
    if (q.gmraw && !rawMatch(q.gmraw, msg)) return false;
    return true;
  }

  function project(msg, query) {
    const out = { seq: msg.uid, uid: msg.uid };
    if (query.emailId !== false) out.emailId = msg.emailId;
    if (query.threadId) out.threadId = msg.threadId;
    if (query.labels) out.labels = new Set(msg.labels);
    if (query.flags) out.flags = new Set(msg.flags);
    if (query.internalDate) out.internalDate = msg.internalDate;
    if (query.envelope) out.envelope = msg.envelope;
    if (query.bodyStructure) out.bodyStructure = msg.bodyStructure;
    if (query.source) out.source = msg.source;
    if (query.bodyParts) {
      out.bodyParts = new Map();
      for (const bp of query.bodyParts) {
        const key = typeof bp === "string" ? bp : bp.key;
        out.bodyParts.set(key, Buffer.from(msg.previewText || msg.subject || ""));
      }
    }
    return out;
  }

  class FakeImapFlow {
    constructor(opts) {
      this.opts = opts;
      this.selected = null;
    }
    on() {}
    async connect() {
      state.connects++;
      state.lastAuth = { user: this.opts.auth.user, host: this.opts.host, port: this.opts.port, secure: this.opts.secure };
      if (this.opts.auth.pass !== state.password) {
        const err = new Error("Authentication failed");
        err.authenticationFailed = true;
        err.responseText = "Invalid credentials (Failure)";
        err.serverResponseCode = "AUTHENTICATIONFAILED";
        throw err;
      }
      state.openSessions++;
    }
    async logout() {
      state.logouts++;
      state.openSessions--;
    }
    close() {}
    async list(opts = {}) {
      return FOLDERS.map((f) => ({
        ...f,
        flags: new Set(),
        ...(opts.statusQuery
          ? {
              status: {
                messages: state.messages.filter((m) => inFolder(f.path, m)).length,
                unseen: state.messages.filter((m) => inFolder(f.path, m) && !m.flags.has("\\Seen")).length
              }
            }
          : {})
      }));
    }
    async getMailboxLock(path) {
      if (!FOLDERS.some((f) => f.path === path)) throw new Error(`no folder ${path}`);
      this.selected = path;
      return { release: () => {} };
    }
    _here() {
      return state.messages.filter((m) => inFolder(this.selected, m));
    }
    async search(q) {
      return this._here().filter((m) => match(q, m)).map((m) => m.uid);
    }
    async fetchAll(uids, query) {
      const set = new Set(uids.map(Number));
      return this._here().filter((m) => set.has(m.uid)).map((m) => project(m, query));
    }
    async fetchOne(uid, query) {
      const m = this._here().find((x) => x.uid === Number(uid));
      return m ? project(m, query) : false;
    }
  }

  return {
    state,
    addMessage,
    factory: (opts) => new FakeImapFlow(opts)
  };
}
