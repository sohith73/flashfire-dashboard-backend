import mongoose from "mongoose";

const DigestAttachmentSchema = new mongoose.Schema(
  {
    // Gmail's per-message attachment handle. Kept so a digest whose Discord
    // post failed can re-download its bytes on retry instead of losing the file.
    attachmentId: { type: String, default: "" },
    filename: { type: String, default: "" },
    mimetype: { type: String, default: "application/octet-stream" },
    size: { type: Number, default: 0 },
    // True when this file is one we fetch and upload (text-like, within budget).
    uploadable: { type: Boolean, default: false },
    // True once the bytes actually landed on a Discord message.
    uploadedToDiscord: { type: Boolean, default: false }
  },
  { _id: false }
);

// One doc per inbox message the poll worker has seen.
//
// Doubles as the dedupe ledger: the unique (gmailEmail, messageId) index is
// what guarantees a mail is posted to Discord at most once, even if two
// workers race or Gmail's `after:` cursor replays a second.
//
// discordPostedAt === null means "claimed but not yet delivered" — the worker
// re-attempts those on the next tick, so a crash between claim and post does
// not silently drop the notification.
const MailDigestSchema = new mongoose.Schema(
  {
    ownerEmail: { type: String, required: true, lowercase: true, index: true },
    gmailEmail: { type: String, required: true, lowercase: true, index: true },
    threadId: { type: String, default: "" },
    messageId: { type: String, required: true },

    // Raw mail facts
    from: { type: String, default: "" },
    fromEmail: { type: String, default: "" },
    subject: { type: String, default: "" },
    snippet: { type: String, default: "" },
    date: { type: Date, default: null, index: true },
    internalDate: { type: Number, default: 0 },

    // gpt-4o-mini output
    summary: { type: String, default: "" },
    keyPoints: { type: [String], default: [] },
    category: { type: String, default: "other" },
    priority: { type: String, enum: ["high", "medium", "low"], default: "low" },
    actionRequired: { type: String, default: "" },
    urls: { type: [String], default: [] },
    aiModel: { type: String, default: "" },
    // false when the model call failed and we fell back to the raw snippet —
    // the mail still reaches Discord, just unsummarized.
    aiSucceeded: { type: Boolean, default: false },
    aiError: { type: String, default: "" },

    attachments: { type: [DigestAttachmentSchema], default: [] },

    // Discord (ops) delivery state
    discordPostedAt: { type: Date, default: null },
    discordError: { type: String, default: "" },
    discordAttempts: { type: Number, default: 0 },

    // Second-stage AI verification (mailMilestoneVerifier). Runs only on mails
    // the rules classifier flagged as interview/assessment/offer. verifyRan
    // distinguishes "never a candidate" from "checked". verifyGenuine=false with
    // verifyRan=true means the AI rejected it (verifyReason says why).
    verifyRan: { type: Boolean, default: false },
    verifyGenuine: { type: Boolean, default: false },
    verifyCategory: { type: String, default: "" }, // interview|assessment|offer|not-milestone
    verifyConfidence: { type: String, default: "" }, // high|medium|low
    verifyReason: { type: String, default: "" },
    verifyModel: { type: String, default: "" },
    verifyError: { type: String, default: "" },

    // Ops (Discord) eligibility: rules-flagged milestone that either passed
    // verification OR could not be verified (AI down). Verified rejections are
    // NOT ops-eligible — promos stop reaching Discord too.
    opsNotifyEligible: { type: Boolean, default: false, index: true },

    // Client milestone-alert state (SendGrid → the client).
    // clientNotifyEligible is decided once, when the digest is created, from the
    // AI category. clientNotifiedAt !== null is the dedupe guard: the client is
    // emailed at most once per source mail. clientNotifySkippedReason records why
    // an eligible mail was NOT emailed (e.g. no recipient, notifications off).
    clientNotifyEligible: { type: Boolean, default: false, index: true },
    clientNotifyCategory: { type: String, default: "" },
    clientNotifiedAt: { type: Date, default: null },
    clientNotifyTo: { type: String, default: "" }, // resolved recipient (the payment email)
    clientNotifyChannel: { type: String, default: "" }, // "smtp" | "sendgrid"
    clientNotifyMessageId: { type: String, default: "" }, // SMTP message-id = proof of send
    clientNotifyError: { type: String, default: "" },
    clientNotifyAttempts: { type: Number, default: 0 },
    clientNotifySkippedReason: { type: String, default: "" },

    // Client milestone-alert state for the MATTERMOST half.
    //
    // Deliberately a separate stamp from clientNotifiedAt rather than one
    // shared "notified" flag: the two channels fail independently. A webhook
    // 5xx must not block the email, and an SMTP bounce must not suppress the
    // Mattermost post - and neither may be re-sent once it has succeeded. One
    // flag would force an all-or-nothing retry that either double-mails or
    // never posts.
    clientMattermostAt: { type: Date, default: null },
    clientMattermostError: { type: String, default: "" },
    clientMattermostAttempts: { type: Number, default: 0 }
  },
  { timestamps: true }
);

// The dedupe guard. Everything else is a read index.
MailDigestSchema.index({ gmailEmail: 1, messageId: 1 }, { unique: true });
MailDigestSchema.index({ ownerEmail: 1, date: -1 });
MailDigestSchema.index({ discordPostedAt: 1, createdAt: 1 });
// Pending client alerts: eligible, not yet sent. Backs the retry sweep.
MailDigestSchema.index({ gmailEmail: 1, clientNotifyEligible: 1, clientNotifiedAt: 1 });

export const MailDigest = mongoose.model("MailDigest", MailDigestSchema);
