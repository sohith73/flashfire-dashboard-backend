import express from "express";
import multer from "multer";
import { google } from "googleapis";
import { GmailUser } from "../Schema_Models/GmailUser.js";
import {
  sendingMailboxesForOwner,
  accountsForOwner,
  ownerHasMailbox,
  markMailboxAuthFailed,
  MAILBOX_KIND
} from "../src/services/mailbox/mailboxRegistry.js";
import { sendViaGmailSmtp } from "../src/services/mailbox/gmailSmtp.js";
import { RecruiterEmailGroup } from "../Schema_Models/RecruiterEmailGroup.js";
import { RecruiterEmailTemplate } from "../Schema_Models/RecruiterEmailTemplate.js";
import { RecruiterEmailAutomation } from "../Schema_Models/RecruiterEmailAutomation.js";
import { GmailSendLog } from "../Schema_Models/GmailSendLog.js";
import { UserModel } from "../Schema_Models/UserModel.js";
import { JobModel } from "../Schema_Models/JobModel.js";
import { ensureAiTemplateForOwner, refreshStaleEducationClaims } from "./RecruiterAiTemplate.js";
import { isRecruiterSendDay, weekendSkipReason, weekdayName, RECRUITER_SEND_TIMEZONE } from "../Utils/businessDays.js";

const EXECUTIVE_AUTOMATION_THRESHOLD = 200;
// Counts a job toward the threshold if it is in any "active pipeline" status:
// saved, applied, or interviewing. Excludes removed / rejected / offer.
const PIPELINE_STATUS_RE = /^(saved|applied|interview)/i;
function pipelineCountFilter(userEmail) {
  return {
    userID: userEmail,
    currentStatus: { $regex: PIPELINE_STATUS_RE }
  };
}

const router = express.Router();

function normalizeEmailSubject(subject) {
  if (typeof subject !== "string") return "";
  let s = subject.trim();
  if (!s) return "";
  if (/Ã/.test(s)) {
    try {
      const decoded = Buffer.from(s, "latin1").toString("utf8");
      if (!/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(decoded)) s = decoded;
    } catch (_) {}
  }
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
}

/**
 * Encode a header value for MIME (RFC 2047) so non-ASCII characters (e.g. em dash "—")
 * display correctly instead of mojibake like "Ã¢Â€Â"".
 * Uses =?UTF-8?B?base64?= and splits into chunks of max 75 chars per encoded-word.
 */
function encodeRfc2047Header(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  const isAscii = /^[\x00-\x7F]*$/.test(value);
  if (isAscii) return value;
  const utf8 = Buffer.from(value, "utf8");
  const maxBytesPerWord = 57;
  const parts = [];
  for (let i = 0; i < utf8.length; i += maxBytesPerWord) {
    const chunk = utf8.subarray(i, i + maxBytesPerWord);
    parts.push(`=?UTF-8?B?${chunk.toString("base64")}?=`);
  }
  return parts.join("\r\n ");
}

async function createSendLog({ ownerEmail, fromEmail, toEmail, subject, status, errorMessage = null, source = "manual" }) {
  try {
    await GmailSendLog.create({
      ownerEmail: ownerEmail.toLowerCase(),
      fromEmail,
      toEmail,
      subject,
      status,
      errorMessage,
      source
    });
  } catch (e) {
    console.error("Failed to write GmailSendLog:", e?.message);
  }
}

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/jpeg",
      "image/png",
      "image/gif"
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed. Please upload PDF, DOC, DOCX, or image files.`));
    }
  }
});

const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File size exceeds 25MB limit" });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
};

router.get("/auth/google", (req, res) => {
  const ownerEmail = typeof req.query.email === "string" ? req.query.email : "";
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly"
    ],
    prompt: "consent",
    state: ownerEmail ? encodeURIComponent(ownerEmail) : undefined
  });
  res.redirect(url);
});

router.get("/auth/google/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send("Missing code");
  try {
    // Use native fetch (Node 18+) instead of googleapis' bundled node-fetch
    // to avoid ERR_STREAM_PREMATURE_CLOSE on Render's network.
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code"
      }).toString()
    });
    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("Token exchange failed:", tokenRes.status, errText);
      return res.status(500).send("Google OAuth error: token exchange failed");
    }
    const tokens = await tokenRes.json();
    const email = await getEmail(tokens.access_token);
    const ownerEmail = typeof state === "string" ? decodeURIComponent(state) : undefined;
    await GmailUser.findOneAndUpdate(
      { email },
      {
        email,
        refreshToken: tokens.refresh_token,
        ...(ownerEmail ? { ownerEmail } : {})
      },
      { upsert: true, new: true }
    );
    res.send(`✅ ${email} connected. You can close this tab.`);
  } catch (e) {
    console.error(e);
    res.status(500).send("Google OAuth error");
  }
});

router.post("/status", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ connected: false, error: "Email is required" });
    }
    // Connected by app password or by Google OAuth.
    return res.json({ connected: await ownerHasMailbox(email) });
  } catch (error) {
    console.error("Gmail status error:", error);
    return res.status(500).json({ connected: false, error: "Failed to check Gmail status" });
  }
});

router.post("/accounts", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }
    // The app-password mailbox alone when there is one, else the OAuth accounts.
    return res.json({ accounts: await accountsForOwner(email) });
  } catch (error) {
    console.error("Gmail accounts error:", error);
    return res.status(500).json({ error: "Failed to load Gmail accounts" });
  }
});

router.post("/send", upload.single("attachment"), handleMulterError, async (req, res) => {
  try {
    const { ownerEmail, to, subject, text } = req.body || {};

    if (!ownerEmail || !to || !subject || !text) {
      return res.status(400).json({ error: "ownerEmail, to, subject, text required" });
    }

    const normalizedSubject = normalizeEmailSubject(subject);

    const rawRecipients = String(to)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

    if (!rawRecipients.length) {
      return res.status(400).json({ error: "At least one recipient email is required" });
    }

    // Same rule as the automation. A hand-composed mail is still a cold mail
    // arriving in a recruiter's inbox on a Saturday.
    if (!isRecruiterSendDay()) {
      return res.status(409).json({ error: weekendSkipReason(), status: "weekend" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const r of rawRecipients) {
      if (!emailRegex.test(r)) {
        return res.status(400).json({ error: `Invalid recipient email: ${r}` });
      }
    }

    const attachment = req.file
      ? {
          filename: req.file.originalname,
          content: req.file.buffer,
          mimetype: req.file.mimetype
        }
      : null;

    let fromEmails = req.body.fromEmails;
    if (fromEmails && !Array.isArray(fromEmails)) {
      fromEmails = [fromEmails];
    }

    // App password first; it is the only sender while it exists.
    const users = await sendingMailboxesForOwner(ownerEmail, { fromEmails });

    if (!users.length) {
      return res.status(404).json({ error: "No connected Gmail accounts for this user" });
    }

    const results = [];

    for (const u of users) {
      const perUserErrors = [];

      for (const recipient of rawRecipients) {
        try {
          await sendGmail(u, { to: recipient, subject: normalizedSubject, text, attachment });
          await createSendLog({
            ownerEmail,
            fromEmail: u.email,
            toEmail: recipient,
            subject: normalizedSubject,
            status: "success",
            source: "manual"
          });
        } catch (e) {
          const message = e?.message || "Unknown error";
          console.error(`Error sending from ${u.email} to ${recipient}:`, message);
          perUserErrors.push({ recipient, error: message });
          await createSendLog({
            ownerEmail,
            fromEmail: u.email,
            toEmail: recipient,
            subject: normalizedSubject,
            status: "failed",
            errorMessage: message,
            source: "manual"
          });
        }
      }

      if (perUserErrors.length === 0) {
        results.push({ email: u.email, status: "sent" });
      } else {
        results.push({
          email: u.email,
          status: "error",
          error: `Failed for ${perUserErrors.length} recipient(s): ${perUserErrors
            .map((e) => `${e.recipient} (${e.error})`)
            .join("; ")}`
        });
      }
    }

    return res.json({
      results,
      total: results.length,
      sent: results.filter((r) => r.status === "sent").length,
      attachment: attachment ? attachment.filename : null
    });
  } catch (error) {
    console.error("Send email error:", error);
    return res.status(500).json({ error: error.message || "Failed to send emails" });
  }
});

router.post("/logs", async (req, res) => {
  try {
    const { ownerEmail } = req.body || {};
    if (!ownerEmail || !String(ownerEmail).trim()) {
      return res.status(400).json({ error: "ownerEmail is required" });
    }
    const page = Math.max(1, parseInt(req.body.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.body.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const total = await GmailSendLog.countDocuments({ ownerEmail: ownerEmail.toLowerCase().trim() });
    const logs = await GmailSendLog.find({ ownerEmail: ownerEmail.toLowerCase().trim() })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
    const totalPages = Math.ceil(total / limit) || 1;
    res.json({
      logs: logs.map((l) => ({
        id: String(l._id),
        fromEmail: l.fromEmail,
        toEmail: l.toEmail,
        subject: l.subject,
        status: l.status,
        errorMessage: l.errorMessage || null,
        source: l.source,
        sentAt: l.createdAt
      })),
      total,
      page,
      limit,
      totalPages
    });
  } catch (error) {
    console.error("Gmail logs error:", error);
    res.status(500).json({ error: "Failed to load logs" });
  }
});

router.get("/templates", async (req, res) => {
  try {
    const templates = await RecruiterEmailTemplate.find({})
      .sort({ createdAt: -1 })
      .select("name subject createdAt updatedAt")
      .lean();
    const result = templates.map((t) => ({
      id: String(t._id),
      name: t.name,
      subject: t.subject,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt
    }));
    res.json({ templates: result });
  } catch (error) {
    res.status(500).json({ error: "Failed to load templates" });
  }
});

router.get("/templates/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const template = await RecruiterEmailTemplate.findById(id).lean();
    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }
    res.json({
      id: String(template._id),
      name: template.name,
      subject: template.subject,
      text: template.text,
      attachmentFilename: template.attachment?.filename || null
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to load template" });
  }
});

router.post("/templates", upload.single("attachment"), handleMulterError, async (req, res) => {
  try {
    const { name, subject, text, ownerEmail } = req.body || {};
    if (!name || !name.trim() || !subject || !subject.trim() || !text || !text.trim()) {
      return res.status(400).json({ error: "Name, subject and text are required" });
    }
    let attachment = null;
    if (req.file) {
      attachment = {
        filename: req.file.originalname,
        mimetype: req.file.mimetype,
        content: req.file.buffer
      };
    }
    const template = await RecruiterEmailTemplate.create({
      name: name.trim(),
      subject: subject.trim(),
      text: text.trim(),
      attachment,
      createdBy: ownerEmail || ""
    });
    res.status(201).json({
      id: String(template._id),
      name: template.name,
      subject: template.subject
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to create template" });
  }
});

router.put("/templates/:id", upload.single("attachment"), handleMulterError, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, subject, text } = req.body || {};
    const template = await RecruiterEmailTemplate.findById(id);
    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }
    if (name && name.trim()) template.name = name.trim();
    if (subject && subject.trim()) template.subject = subject.trim();
    if (text !== undefined) template.text = String(text).trim();
    if (req.file) {
      template.attachment = {
        filename: req.file.originalname,
        mimetype: req.file.mimetype,
        content: req.file.buffer
      };
    }
    await template.save();
    res.json({
      id: String(template._id),
      name: template.name,
      subject: template.subject
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to update template" });
  }
});

router.post("/automation/config/get", async (req, res) => {
  try {
    const { ownerEmail } = req.body || {};
    if (!ownerEmail || !ownerEmail.trim()) {
      return res.status(400).json({ error: "ownerEmail is required" });
    }
    const doc = await RecruiterEmailAutomation.findOne({
      ownerEmail: ownerEmail.toLowerCase().trim()
    })
      .populate("group")
      .populate("template");
    if (!doc) {
      return res.json({ config: null });
    }
    res.json({
      config: {
        id: String(doc._id),
        ownerEmail: doc.ownerEmail,
        groupId: doc.group ? String(doc.group._id) : null,
        groupName: doc.group ? doc.group.name : null,
        templateId: doc.template ? String(doc.template._id) : null,
        templateName: doc.template ? doc.template.name : null,
        dailyLimit: doc.dailyLimit,
        enabled: doc.enabled,
        skipThreshold: !!doc.skipThreshold
      }
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to load automation config" });
  }
});

router.patch("/automation/config", async (req, res) => {
  try {
    const { ownerEmail, enabled, skipThreshold } = req.body || {};
    if (!ownerEmail || !ownerEmail.trim()) {
      return res.status(400).json({ error: "ownerEmail is required" });
    }
    // Only update the fields actually provided so the enabled toggle and the
    // "Skip 200 limit" toggle can be flipped independently.
    const updates = {};
    if (typeof enabled !== "undefined") updates.enabled = !!enabled;
    if (typeof skipThreshold !== "undefined") updates.skipThreshold = !!skipThreshold;
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: "Nothing to update" });
    }
    const doc = await RecruiterEmailAutomation.findOneAndUpdate(
      { ownerEmail: ownerEmail.toLowerCase().trim() },
      { $set: updates },
      { new: true }
    );
    if (!doc) {
      return res.status(404).json({ error: "No automation config found. Save group, template and limit first." });
    }
    res.json({
      config: {
        id: String(doc._id),
        enabled: doc.enabled,
        skipThreshold: !!doc.skipThreshold
      }
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to update automation status" });
  }
});

router.post("/automation/config", async (req, res) => {
  try {
    const { ownerEmail, groupId, templateId, dailyLimit, enabled } = req.body || {};
    if (!ownerEmail || !ownerEmail.trim()) {
      return res.status(400).json({ error: "ownerEmail is required" });
    }
    if (!groupId || !templateId) {
      return res.status(400).json({ error: "groupId and templateId are required" });
    }
    const rawLimit = Number(dailyLimit || 0);
    if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
      return res.status(400).json({ error: "dailyLimit must be greater than zero" });
    }
    // Hard cap at 5 — Gmail rate-limit bounces past that on the workflow
    // account. Clamp silently so old UIs sending 20 still save 5.
    const MAX_AUTOMATION_DAILY_LIMIT = 5;
    const limitNumber = Math.min(Math.floor(rawLimit), MAX_AUTOMATION_DAILY_LIMIT);
    const groupExists = await RecruiterEmailGroup.exists({ _id: groupId });
    if (!groupExists) {
      return res.status(400).json({ error: "Invalid groupId" });
    }
    const templateExists = await RecruiterEmailTemplate.exists({ _id: templateId });
    if (!templateExists) {
      return res.status(400).json({ error: "Invalid templateId" });
    }
    const doc = await RecruiterEmailAutomation.findOneAndUpdate(
      { ownerEmail: ownerEmail.toLowerCase().trim() },
      {
        ownerEmail: ownerEmail.toLowerCase().trim(),
        group: groupId,
        template: templateId,
        dailyLimit: limitNumber,
        enabled: !!enabled
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json({
      config: {
        id: String(doc._id),
        ownerEmail: doc.ownerEmail,
        groupId: String(doc.group),
        templateId: String(doc.template),
        dailyLimit: doc.dailyLimit,
        enabled: doc.enabled
      }
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to save automation config" });
  }
});

// Manually trigger "today's" recruiter emails for ONE user, right now, instead
// of waiting for the 11 PM IST cron. Idempotent: enforces one batch per IST day
// (atomic claim inside processAutomation), so repeat clicks / cron won't double-send.
router.post("/automation/run-now", async (req, res) => {
  try {
    const { ownerEmail } = req.body || {};
    if (!ownerEmail || !ownerEmail.trim()) {
      return res.status(400).json({ error: "ownerEmail is required" });
    }
    const automation = await RecruiterEmailAutomation.findOne({
      ownerEmail: ownerEmail.toLowerCase().trim()
    })
      .populate("group")
      .populate("template");
    if (!automation) {
      return res.status(404).json({ error: "No automation config found. Save group, template and limit first." });
    }
    if (!automation.enabled) {
      return res.status(400).json({ error: "Automation is off for this user. Turn it on first." });
    }

    const result = await processAutomation(automation, { force: false });

    const messages = {
      missing_group_template: "Select a recruiter group and a template, then save settings first.",
      no_user: "User not found.",
      not_executive: "User is not on the Executive plan.",
      below_threshold: `User hasn't reached ${EXECUTIVE_AUTOMATION_THRESHOLD} applications. Turn on "Skip 200 limit" to send anyway.`,
      no_emails: "The selected recruiter group has no emails.",
      no_recipients: "No new recipients available to send to.",
      no_gmail: "No Gmail account is connected for this user.",
      weekend: weekendSkipReason()
    };

    if (result.status === "sent") {
      return res.json({
        ok: true,
        status: "sent",
        sent: result.sent,
        failed: result.failed,
        recipients: result.recipients
      });
    }
    if (result.status === "already_sent_today") {
      return res.json({
        ok: false,
        status: "already_sent_today",
        message: "Today's emails were already sent for this user.",
        lastRunAt: result.lastRunAt
      });
    }
    // Not a failure the operator can fix by changing settings, so it is
    // answered like the other two send routes: 409, with the day named.
    if (result.status === "weekend") {
      return res.status(409).json({ ok: false, status: "weekend", error: result.reason || messages.weekend });
    }
    return res.status(400).json({
      ok: false,
      status: result.status,
      error: messages[result.status] || "Could not send today's emails."
    });
  } catch (error) {
    console.error("run-now error:", error);
    return res.status(500).json({ error: "Failed to send today's emails" });
  }
});

// Retry a single failed (or any) send-log entry. The body isn't stored on the
// log, so we rebuild it from the user's current automation template and re-send
// to the same recipient from the same Gmail account (falling back to any
// connected account). A fresh log row records the retry outcome.
router.post("/automation/resend", async (req, res) => {
  try {
    const { logId } = req.body || {};
    if (!logId) {
      return res.status(400).json({ error: "logId is required" });
    }
    const log = await GmailSendLog.findById(logId);
    if (!log) {
      return res.status(404).json({ error: "Log entry not found" });
    }
    const ownerEmailLc = log.ownerEmail.toLowerCase();

    // A retry of Friday's failure can wait for Monday; the recipient sees a
    // weekend mail either way.
    if (!isRecruiterSendDay()) {
      return res.status(409).json({ error: weekendSkipReason(), status: "weekend" });
    }

    const automation = await RecruiterEmailAutomation.findOne({ ownerEmail: ownerEmailLc })
      .populate("template");
    if (!automation || !automation.template) {
      return res.status(400).json({ error: "No template configured for this user — cannot resend." });
    }

    // Prefer the original sending account; otherwise the current sender
    // (the app password when there is one).
    const senders = await sendingMailboxesForOwner(ownerEmailLc);
    const gmailUser =
      senders.find((m) => m.email === String(log.fromEmail || "").toLowerCase()) || senders[0] || null;
    if (!gmailUser) {
      return res.status(400).json({ error: "No Gmail account connected for this user." });
    }

    let attachment = null;
    if (automation.template.attachment && automation.template.attachment.content) {
      const bufferContent = Buffer.isBuffer(automation.template.attachment.content)
        ? automation.template.attachment.content
        : Buffer.from(
            automation.template.attachment.content.buffer || automation.template.attachment.content
          );
      attachment = {
        filename: automation.template.attachment.filename,
        mimetype: automation.template.attachment.mimetype,
        content: bufferContent
      };
    }
    const subject = normalizeEmailSubject(automation.template.subject || log.subject);

    try {
      await sendGmail(gmailUser, {
        to: log.toEmail,
        subject,
        text: automation.template.text,
        attachment
      });
      await createSendLog({
        ownerEmail: log.ownerEmail,
        fromEmail: gmailUser.email,
        toEmail: log.toEmail,
        subject,
        status: "success",
        source: log.source
      });
      return res.json({ ok: true, status: "sent", toEmail: log.toEmail });
    } catch (error) {
      const message = error && error.message ? error.message : "Unknown error";
      console.error(`Resend error to ${log.toEmail}: ${message}`);
      await createSendLog({
        ownerEmail: log.ownerEmail,
        fromEmail: gmailUser.email,
        toEmail: log.toEmail,
        subject,
        status: "failed",
        errorMessage: message,
        source: log.source
      });
      return res.status(502).json({ ok: false, status: "failed", error: message });
    }
  } catch (error) {
    console.error("resend error:", error);
    return res.status(500).json({ error: "Failed to resend email" });
  }
});

async function getEmail(accessToken) {
  // Use native fetch to avoid ERR_STREAM_PREMATURE_CLOSE from googleapis' bundled node-fetch
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`getEmail failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.emailAddress;
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

function createMimeMessage(from, to, subject, text, attachment = null) {
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const encodedSubject = encodeRfc2047Header(subject);

  const lines = [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`
  ];

  if (attachment) {
    const encodedFilename = encodeFilename(attachment.filename);
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(text);
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${attachment.mimetype}; name=${encodedFilename}`);
    lines.push(`Content-Disposition: attachment; filename=${encodedFilename}`);
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    const base64Content = attachment.content.toString("base64");
    for (let i = 0; i < base64Content.length; i += 76) {
      lines.push(base64Content.substr(i, 76));
    }
    lines.push("");
    lines.push(`--${boundary}--`);
  } else {
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(text);
  }

  return lines.join("\r\n");
}

// In-memory access token cache: refreshToken -> { accessToken, expiresAt }
const _tokenCache = new Map();

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

async function sendGmail(user, { to, subject, text, attachment = null }) {
  // App password: the same mail, sent over Gmail SMTP as the client.
  if (user.kind === MAILBOX_KIND.APP_PASSWORD) {
    try {
      await sendViaGmailSmtp({
        gmailEmail: user.email,
        password: user.getPassword(),
        mail: {
          to,
          subject,
          text,
          attachments: attachment
            ? [{ filename: attachment.filename, content: attachment.content, contentType: attachment.mimetype }]
            : []
        }
      });
    } catch (err) {
      if (err?.isMailboxAuthError || err?.code === "SECRET_UNREADABLE") {
        await markMailboxAuthFailed(user, err.message);
      }
      throw err;
    }
    return;
  }

  const mimeMessage = createMimeMessage(user.email, to, subject, text, attachment);
  const accessToken = await getAccessToken(user.refreshToken);
  const raw = Buffer.from(mimeMessage)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ raw })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gmail send failed: ${res.status} ${errText}`);
  }
}

async function runAiTemplatePrePass() {
  // Before anything is generated or sent, correct any stored template whose
  // education sentence has gone out of date - a client who has graduated since
  // the template was written must stop telling recruiters they are still
  // studying. Deterministic and cheap, so it runs every night over all of them.
  try {
    await refreshStaleEducationClaims();
  } catch (e) {
    console.error("[RecruiterAutomation] education sweep error:", e?.message);
  }

  try {
    const executiveUsers = await UserModel.find({ planType: "Executive" })
      .select("email")
      .lean();
    if (!executiveUsers.length) return;

    for (const u of executiveUsers) {
      const email = (u.email || "").toLowerCase();
      if (!email) continue;
      const count = await JobModel.countDocuments(pipelineCountFilter(email));
      if (count < EXECUTIVE_AUTOMATION_THRESHOLD) continue;

      const result = await ensureAiTemplateForOwner(email);
      if (result === "linked") {
        console.log(`[RecruiterAutomation] AI template linked for ${email} (pipeline=${count})`);
      } else if (result === "skip_no_resume") {
        console.log(`[RecruiterAutomation] AI skipped for ${email}: no resume assigned`);
      } else if (result === "skip_no_group") {
        console.log(`[RecruiterAutomation] AI skipped for ${email}: ${result}`);
      }
    }
  } catch (e) {
    console.error("[RecruiterAutomation] AI pre-pass error:", e?.message);
  }
}

// IST (Asia/Kolkata) calendar day as YYYY-MM-DD, used for the once-per-day guard.
function istDayKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

// Run the recruiter automation for a SINGLE (populated) automation row — the
// exact same checks and send logic used by the nightly cron. Enforces one send
// batch per IST day via an atomic claim on `lastRunDayKey`, so the manual
// "send now" button and the cron can never double-send for a user in a day.
// Returns a structured status the caller can surface to the operator.
async function processAutomation(automation, { force = false } = {}) {
  if (!automation) return { status: "no_config" };

  // Monday to Friday only, and NOT forceable. `force` exists to let an operator
  // re-run a day that was already claimed; it is not a licence to put cold
  // outreach in a recruiter's inbox on a Sunday. Checked before the day claim
  // so a weekend never burns the once-per-day guard - Monday's batch still runs.
  if (!isRecruiterSendDay()) {
    return { status: "weekend", reason: weekendSkipReason() };
  }
  if (!automation.group || !automation.template) {
    return { status: "missing_group_template" };
  }
  const ownerEmailLc = automation.ownerEmail.toLowerCase();
  const todayKey = istDayKey(new Date());

  // Fast pre-check (the authoritative guard is the atomic claim below).
  if (!force && automation.lastRunDayKey === todayKey) {
    return { status: "already_sent_today", lastRunAt: automation.lastRunAt };
  }

  const user = await UserModel.findOne({ email: ownerEmailLc })
    .select("planType email")
    .lean();
  if (!user) return { status: "no_user" };
  if (user.planType !== "Executive") {
    return { status: "not_executive", planType: user.planType };
  }

  const pipelineCount = await JobModel.countDocuments(pipelineCountFilter(ownerEmailLc));
  if (!automation.skipThreshold && pipelineCount < EXECUTIVE_AUTOMATION_THRESHOLD) {
    return { status: "below_threshold", pipelineCount, threshold: EXECUTIVE_AUTOMATION_THRESHOLD };
  }
  if (automation.skipThreshold && pipelineCount < EXECUTIVE_AUTOMATION_THRESHOLD) {
    console.log(`[RecruiterAutomation] ${ownerEmailLc}: skipThreshold ON — sending despite pipeline=${pipelineCount} < ${EXECUTIVE_AUTOMATION_THRESHOLD}`);
  }

  const allEmails = Array.isArray(automation.group.emails) ? automation.group.emails : [];
  const normalizedAll = Array.from(
    new Set(
      allEmails
        .map((v) => v && v.toString().trim().toLowerCase())
        .filter((v) => v)
    )
  );
  if (!normalizedAll.length) return { status: "no_emails" };

  const alreadySentSet = new Set(
    (automation.sentTo || [])
      .map((v) => v && v.toString().trim().toLowerCase())
      .filter((v) => v)
  );
  let pool = normalizedAll.filter((email) => !alreadySentSet.has(email));
  let resetHistory = false;
  // Defense-in-depth: cap the per-tick send at 5 even if Mongo doc still
  // carries the old dailyLimit:20 value. Saving via the UI clamps on write,
  // but existing docs predating the clamp must not flood Gmail.
  const HARD_DAILY_CAP = 5;
  const effectiveDailyLimit = Math.min(automation.dailyLimit || 0, HARD_DAILY_CAP);
  if (pool.length < effectiveDailyLimit) {
    pool = normalizedAll;
    resetHistory = true;
  }
  const limit = Math.min(effectiveDailyLimit, pool.length);
  const selected = [];
  const poolCopy = [...pool];
  while (selected.length < limit && poolCopy.length > 0) {
    const index = Math.floor(Math.random() * poolCopy.length);
    selected.push(poolCopy[index]);
    poolCopy.splice(index, 1);
  }
  if (!selected.length) return { status: "no_recipients" };

  const gmailUsers = await sendingMailboxesForOwner(ownerEmailLc);
  if (!gmailUsers.length) return { status: "no_gmail" };

  // Atomic once-per-day claim: only the first request that flips lastRunDayKey
  // to today proceeds; concurrent/duplicate triggers get "already sent today".
  // (When force=true we skip the day condition to allow an explicit re-send.)
  const claimFilter = force
    ? { _id: automation._id }
    : { _id: automation._id, lastRunDayKey: { $ne: todayKey } };
  const claimed = await RecruiterEmailAutomation.findOneAndUpdate(
    claimFilter,
    { $set: { lastRunDayKey: todayKey, lastRunAt: new Date() } },
    { new: true }
  );
  if (!claimed) {
    return { status: "already_sent_today", lastRunAt: automation.lastRunAt };
  }

  let attachment = null;
  if (automation.template.attachment && automation.template.attachment.content) {
    const bufferContent = Buffer.isBuffer(automation.template.attachment.content)
      ? automation.template.attachment.content
      : Buffer.from(
          automation.template.attachment.content.buffer || automation.template.attachment.content
        );
    attachment = {
      filename: automation.template.attachment.filename,
      mimetype: automation.template.attachment.mimetype,
      content: bufferContent
    };
  }
  const automationSubject = normalizeEmailSubject(automation.template.subject);
  let sent = 0;
  let failed = 0;
  for (const gUser of gmailUsers) {
    for (const recipient of selected) {
      try {
        await sendGmail(gUser, {
          to: recipient,
          subject: automationSubject,
          text: automation.template.text,
          attachment
        });
        await createSendLog({
          ownerEmail: automation.ownerEmail,
          fromEmail: gUser.email,
          toEmail: recipient,
          subject: automationSubject,
          status: "success",
          source: "automation"
        });
        sent++;
      } catch (error) {
        const message = error && error.message ? error.message : "Unknown error";
        console.error(`Automation email error from ${gUser.email} to ${recipient}: ${message}`);
        await createSendLog({
          ownerEmail: automation.ownerEmail,
          fromEmail: gUser.email,
          toEmail: recipient,
          subject: automationSubject,
          status: "failed",
          errorMessage: message,
          source: "automation"
        });
        failed++;
      }
    }
  }
  const newHistory = resetHistory ? selected : Array.from(new Set([...alreadySentSet, ...selected]));
  await RecruiterEmailAutomation.updateOne(
    { _id: automation._id },
    { $set: { sentTo: newHistory } }
  );

  return { status: "sent", sent, failed, recipients: selected };
}

export async function runRecruiterAutomationDailyJob() {
  // Weekend: stop here rather than walking every automation row to log the same
  // skip N times. The template pre-pass is skipped too - there is nothing for it
  // to prepare until Monday, and it costs an AI call per new client.
  if (!isRecruiterSendDay()) {
    console.log(
      `[RecruiterAutomation] ${weekdayName()} (${RECRUITER_SEND_TIMEZONE}) — recruiter mail is Monday to Friday only, nothing sent`
    );
    return;
  }

  // Pre-pass: for any Executive user crossing the threshold whose automation
  // row exists with a group set but no template, build an AI template (resume +
  // profile -> GPT) and link it. Defaults dailyLimit=20, enabled=true.
  await runAiTemplatePrePass();

  const automations = await RecruiterEmailAutomation.find({
    enabled: true,
    dailyLimit: { $gt: 0 }
  })
    .populate("group")
    .populate("template");

  for (const automation of automations) {
    try {
      const result = await processAutomation(automation, { force: false });
      if (result.status === "sent") {
        console.log(`[RecruiterAutomation] ${automation.ownerEmail}: sent ${result.sent} (failed ${result.failed})`);
      } else {
        console.log(`[RecruiterAutomation] skip ${automation.ownerEmail}: ${result.status}`);
      }
    } catch (e) {
      console.error(`[RecruiterAutomation] error for ${automation?.ownerEmail}:`, e?.message);
    }
    // 3s gap between users so OAuth token refreshes don't all hit Google
    // simultaneously and cause "Premature close" connection drops on Render.
    await new Promise(r => setTimeout(r, 3000));
  }
}

export default router;
