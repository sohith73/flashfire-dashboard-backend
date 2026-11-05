// Which mailbox does a client read and send through?
//
// Two ways to connect a client's Gmail:
//   * app_password - Google app password, IMAP + SMTP (Schema_Models/MailAppPassword)
//   * oauth        - Google OAuth refresh token, Gmail REST API (Schema_Models/GmailUser)
//
// The app password takes precedence. While it exists, a client's recruiter
// mail goes out through it, the Mails tab reads through it, and the hourly
// scan reads it instead of an OAuth connection on the same address. OAuth
// stays the fallback for clients without one, and becomes the path again
// once Google verifies the app.
//
// Every caller gets the same plain object:
//   { kind, email, ownerEmail, refreshToken?, appPasswordId?, getPassword?() }
// The password is decrypted lazily, only by the code about to log in with it.

import { GmailUser } from "../../../Schema_Models/GmailUser.js";
import { GmailPollState } from "../../../Schema_Models/GmailPollState.js";
import { MailAppPassword } from "../../../Schema_Models/MailAppPassword.js";
import { sealSecret, openSecret } from "../../../Utils/secretBox.js";
import { verifyImapLogin } from "./gmailImap.js";
import { verifySmtpLogin } from "./gmailSmtp.js";

export const MAILBOX_KIND = Object.freeze({ APP_PASSWORD: "app_password", OAUTH: "oauth" });

const SECRET_PURPOSE = "mail-app-password";
// On connect, the hourly scan looks back this far, so interview / offer mail
// that arrived while the client was disconnected is still caught. It matches
// the 48h age limit on client alerts (clientMailNotifier MAX_ALERT_AGE_HOURS).
export const CONNECT_CATCH_UP_HOURS = 48;

const lc = (s) => String(s || "").toLowerCase().trim();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fromAppPasswordDoc(doc) {
  const ownerEmail = lc(doc.ownerEmail);
  const sealed = doc.passwordEnc;
  return {
    kind: MAILBOX_KIND.APP_PASSWORD,
    email: lc(doc.gmailEmail),
    ownerEmail,
    appPasswordId: doc._id,
    authFailedAt: doc.authFailedAt || null,
    getPassword: () => openSecret(sealed, { purpose: SECRET_PURPOSE, context: ownerEmail })
  };
}

function fromOauthDoc(doc) {
  return {
    kind: MAILBOX_KIND.OAUTH,
    email: lc(doc.email),
    ownerEmail: lc(doc.ownerEmail),
    refreshToken: doc.refreshToken,
    createdAt: doc.createdAt
  };
}

const hasToken = { refreshToken: { $exists: true, $ne: "" } };

/**
 * Every mailbox the hourly scan should read. App-password mailboxes first;
 * an OAuth mailbox on an address that also has an app password is dropped,
 * so the same inbox is never read twice.
 */
export async function listPollableMailboxes() {
  const [apps, oauth] = await Promise.all([
    MailAppPassword.find({}).select("+passwordEnc").lean(),
    GmailUser.find(hasToken).lean()
  ]);
  const out = apps.map(fromAppPasswordDoc);
  const taken = new Set(out.map((m) => m.email));
  for (const g of oauth) {
    const m = fromOauthDoc(g);
    if (taken.has(m.email)) continue;
    taken.add(m.email);
    out.push(m);
  }
  return out;
}

/** Lightweight list (no secrets) for status views: { email, ownerEmail, kind }. */
export async function listConnectedMailboxSummaries() {
  const [apps, oauth] = await Promise.all([
    MailAppPassword.find({}).select("gmailEmail ownerEmail authFailedAt").lean(),
    GmailUser.find(hasToken).select("email ownerEmail").lean()
  ]);
  const out = apps.map((a) => ({
    email: lc(a.gmailEmail),
    ownerEmail: lc(a.ownerEmail),
    kind: MAILBOX_KIND.APP_PASSWORD,
    authFailed: !!a.authFailedAt
  }));
  const taken = new Set(out.map((m) => m.email));
  for (const g of oauth) {
    const email = lc(g.email);
    if (taken.has(email)) continue;
    taken.add(email);
    out.push({ email, ownerEmail: lc(g.ownerEmail), kind: MAILBOX_KIND.OAUTH, authFailed: false });
  }
  return out;
}

async function appPasswordForOwner(ownerEmail) {
  const owner = lc(ownerEmail);
  if (!owner) return null;
  const doc = await MailAppPassword.findOne({ ownerEmail: owner }).select("+passwordEnc").lean();
  return doc ? fromAppPasswordDoc(doc) : null;
}

/**
 * The mailboxes a client sends recruiter mail from. The app password alone
 * when there is one (sending from it AND from an OAuth account would mail
 * each recruiter twice); otherwise every OAuth account, as before.
 * `fromEmails` narrows the OAuth list; it never overrides the app password.
 */
export async function sendingMailboxesForOwner(ownerEmail, { fromEmails } = {}) {
  const app = await appPasswordForOwner(ownerEmail);
  if (app) return [app];
  const owner = lc(ownerEmail);
  const filter = { ownerEmail: owner };
  const wanted = (Array.isArray(fromEmails) ? fromEmails : fromEmails ? [fromEmails] : []).map(lc).filter(Boolean);
  if (wanted.length) filter.email = { $in: wanted };
  const docs = await GmailUser.find(filter).lean();
  return docs.map(fromOauthDoc);
}

/**
 * The one mailbox the Mails tab works on. An explicit gmailEmail picks that
 * account; otherwise the app password, else the newest OAuth account.
 */
export async function resolveMailboxForOwner(ownerEmail, gmailEmail) {
  const owner = lc(ownerEmail);
  if (!owner) return null;
  const app = await appPasswordForOwner(owner);
  const wanted = lc(gmailEmail);
  if (app && (!wanted || wanted === app.email)) return app;
  if (wanted) {
    const doc = await GmailUser.findOne({ ownerEmail: owner, email: wanted }).lean();
    return doc ? fromOauthDoc(doc) : null;
  }
  const doc = await GmailUser.findOne({ ownerEmail: owner }).sort({ createdAt: -1 }).lean();
  return doc ? fromOauthDoc(doc) : null;
}

/** Accounts for the account pickers: the app password alone if present, else OAuth accounts. */
export async function accountsForOwner(ownerEmail) {
  const owner = lc(ownerEmail);
  const app = await MailAppPassword.findOne({ ownerEmail: owner }).select("gmailEmail connectedAt createdAt").lean();
  if (app) {
    return [{ email: lc(app.gmailEmail), createdAt: app.connectedAt || app.createdAt, kind: MAILBOX_KIND.APP_PASSWORD }];
  }
  const docs = await GmailUser.find({ ownerEmail: owner }).select("email createdAt").sort({ createdAt: -1 }).lean();
  return docs.map((d) => ({ _id: d._id, email: d.email, createdAt: d.createdAt, kind: MAILBOX_KIND.OAUTH }));
}

/** True when the client has any connected mailbox. */
export async function ownerHasMailbox(ownerEmail) {
  const owner = lc(ownerEmail);
  const [app, oauth] = await Promise.all([MailAppPassword.exists({ ownerEmail: owner }), GmailUser.exists({ ownerEmail: owner })]);
  return !!(app || oauth);
}

// ─── Health bookkeeping (app passwords only; OAuth uses GmailPollState) ──

export async function markMailboxAuthFailed(mailbox, message) {
  if (mailbox?.kind !== MAILBOX_KIND.APP_PASSWORD) return;
  try {
    await MailAppPassword.updateOne({ _id: mailbox.appPasswordId }, { $set: { authFailedMessage: String(message || "").slice(0, 300) } });
    // Keep the FIRST failure time, so "broken since" stays truthful.
    await MailAppPassword.updateOne({ _id: mailbox.appPasswordId, authFailedAt: null }, { $set: { authFailedAt: new Date() } });
  } catch (e) {
    console.warn(`[mailbox] could not record auth failure for ${mailbox.email}: ${e.message}`);
  }
}

export async function markMailboxHealthy(mailbox) {
  if (mailbox?.kind !== MAILBOX_KIND.APP_PASSWORD) return;
  await MailAppPassword.updateOne(
    { _id: mailbox.appPasswordId },
    { $set: { lastVerifiedAt: new Date(), authFailedAt: null, authFailedMessage: "" } }
  ).catch((e) => console.warn(`[mailbox] could not record healthy login for ${mailbox.email}: ${e.message}`));
}

// ─── Connect / status (operator profile popup) ──────────────────────

/** Google shows app passwords as "abcd efgh ijkl mnop". Returns 16 letters or null. */
export function normalizeAppPassword(raw) {
  const s = String(raw || "").replace(/\s+/g, "");
  return /^[A-Za-z]{16}$/.test(s) ? s.toLowerCase() : null;
}

export class ConnectError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Verify the app password against Gmail (IMAP login AND SMTP login), then
 * store it encrypted. Replaces any existing one for this client.
 * Nothing is saved unless both logins succeed.
 */
export async function connectAppPassword({ ownerEmail, gmailEmail, appPassword }) {
  const owner = lc(ownerEmail);
  const mailbox = lc(gmailEmail);
  if (!owner) throw new ConnectError(400, "owner_required", "Client email is missing.");
  if (!EMAIL_RE.test(mailbox)) throw new ConnectError(400, "invalid_gmail_email", "Enter the client's Gmail address.");
  const password = normalizeAppPassword(appPassword);
  if (!password) {
    throw new ConnectError(400, "invalid_app_password", "An app password is 16 letters, like abcd efgh ijkl mnop.");
  }

  // Another client already owns this mailbox: reading it twice would alert twice.
  const clash = await MailAppPassword.findOne({ gmailEmail: mailbox, ownerEmail: { $ne: owner } }).select("ownerEmail").lean();
  if (clash) {
    throw new ConnectError(409, "mailbox_in_use", "This Gmail address is already connected to another client.");
  }

  try {
    await verifyImapLogin({ gmailEmail: mailbox, password });
  } catch (err) {
    if (err?.isMailboxAuthError) {
      throw new ConnectError(422, "imap_login_failed", `Gmail refused the app password for reading mail. ${hintFor(err)}`);
    }
    throw new ConnectError(502, "imap_unreachable", "Could not reach Gmail to check the app password. Try again in a minute.");
  }
  try {
    await verifySmtpLogin({ gmailEmail: mailbox, password });
  } catch (err) {
    if (err?.isMailboxAuthError) {
      throw new ConnectError(422, "smtp_login_failed", `Gmail refused the app password for sending mail. ${hintFor(err)}`);
    }
    throw new ConnectError(502, "smtp_unreachable", "Could not reach Gmail to check sending. Try again in a minute.");
  }

  const now = new Date();
  const doc = await MailAppPassword.findOneAndUpdate(
    { ownerEmail: owner },
    {
      $set: {
        gmailEmail: mailbox,
        passwordEnc: sealSecret(password, { purpose: SECRET_PURPOSE, context: owner }),
        connectedAt: now,
        lastVerifiedAt: now,
        authFailedAt: null,
        authFailedMessage: ""
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  await primePollState({ ownerEmail: owner, gmailEmail: mailbox, now });
  return toStatus(doc);
}

// Clear an old OAuth auth error on this address and move the scan cursor to
// at most CONNECT_CATCH_UP_HOURS ago (never forward past mail already read).
async function primePollState({ ownerEmail, gmailEmail, now }) {
  const catchUpFrom = now.getTime() - CONNECT_CATCH_UP_HOURS * 3600 * 1000;
  try {
    const state = await GmailPollState.findOne({ gmailEmail }).lean();
    if (!state) {
      await GmailPollState.create({ ownerEmail, gmailEmail, lastInternalDate: catchUpFrom });
      return;
    }
    await GmailPollState.updateOne(
      { _id: state._id },
      {
        $set: {
          ownerEmail,
          authErrorAt: null,
          authErrorMessage: "",
          consecutiveFailures: 0,
          ...(Number(state.lastInternalDate || 0) < catchUpFrom ? { lastInternalDate: catchUpFrom } : {})
        }
      }
    );
  } catch (e) {
    // Not fatal: the first scan bootstraps its own cursor.
    console.warn(`[mailbox] could not prime poll state for ${gmailEmail}: ${e.message}`);
  }
}

function hintFor(err) {
  const m = String(err?.message || "");
  if (/IMAP is disabled/i.test(m)) return "IMAP is turned off for this account. A Workspace admin has to allow it.";
  return "Check the Gmail address, make sure 2-Step Verification is on, and create a fresh app password.";
}

function toStatus(doc) {
  if (!doc) return { connected: false };
  return {
    connected: true,
    gmailEmail: doc.gmailEmail,
    connectedAt: doc.connectedAt || doc.createdAt || null,
    lastVerifiedAt: doc.lastVerifiedAt || null,
    needsReplacing: !!doc.authFailedAt,
    authFailedAt: doc.authFailedAt || null
  };
}

/** What the profile popup shows. Never includes the password. */
export async function appPasswordStatus(ownerEmail) {
  const doc = await MailAppPassword.findOne({ ownerEmail: lc(ownerEmail) })
    .select("gmailEmail connectedAt createdAt lastVerifiedAt authFailedAt")
    .lean();
  return toStatus(doc);
}
