import mongoose from "mongoose";

// A client's Gmail mailbox connected with a Google app password instead of
// OAuth. One app password gives both directions: IMAP to read everything the
// client receives, SMTP to send recruiter mail as them.
//
// When a client has one, it takes precedence over any OAuth connection for
// reading and sending (src/services/mailbox/mailboxRegistry.js).
//
// One row per client (ownerEmail). Connecting again replaces it.
//
// The password is stored only as AES-256-GCM ciphertext bound to ownerEmail
// (Utils/secretBox.js) and is excluded from every query by default
// (select: false). No route ever returns it.
const MailAppPasswordSchema = new mongoose.Schema(
  {
    // The client's dashboard email (the account the operator opened).
    ownerEmail: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // The Gmail address the app password belongs to.
    gmailEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
    passwordEnc: { type: String, required: true, select: false },
    connectedAt: { type: Date, default: Date.now },
    lastVerifiedAt: { type: Date, default: null },
    // Set when Google rejects the password (revoked, or the client changed
    // their Google password). Cleared on the next successful login.
    authFailedAt: { type: Date, default: null },
    authFailedMessage: { type: String, default: "" }
  },
  { collection: "mailapppasswords", timestamps: true }
);

export const MailAppPassword = mongoose.model("MailAppPassword", MailAppPasswordSchema);
