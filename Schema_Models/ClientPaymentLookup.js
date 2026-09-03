// Read-only lookup for a client's stored payment email.
//
// The applications-monitor backend (DASH/clients-tracking) owns the client
// tracking docs and stores `paymentEmail` on them. Both backends share one
// MongoDB, so we read the same collection directly — no HTTP hop.
//
// IMPORTANT — collection name: clients-tracking registers its model as
// `mongoose.model('DashboardTracking', ClientSchema)` with NO explicit
// collection, so Mongoose pluralizes it to `dashboardtrackings`. That is the
// real collection (verified: 27 docs live there; a `DashboardTracking`
// collection does not exist). We bind explicitly to `dashboardtrackings` under
// a DISTINCT model name so we never collide with, or inherit the wrong
// collection from, the existing `DashboardTracking` model registration
// (Schema_Models/ClientTrackingModel.js currently points at a non-existent
// "DashboardTracking" collection — a separate latent bug).

import mongoose from "mongoose";

const ClientPaymentSchema = new mongoose.Schema(
  {
    email: { type: String, lowercase: true, trim: true, index: true },
    name: { type: String },
    planType: { type: String },
    status: { type: String },
    isPaused: { type: Boolean },
    paymentEmail: { type: String, lowercase: true, trim: true, default: "" },
    gmailCredentials: { email: { type: String, default: "" } }
  },
  { strict: false, collection: "dashboardtrackings" }
);

export const ClientPaymentLookup =
  mongoose.models.ClientPaymentLookup ||
  mongoose.model("ClientPaymentLookup", ClientPaymentSchema);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Resolve the payment email for a client, given any address we know them by
 * (their dashboard/login email and/or their connected mailbox).
 *
 * Matches a tracking doc case-insensitively on `email` OR `gmailCredentials.email`
 * against any of the candidate addresses, then returns its `paymentEmail`.
 *
 * @param {...string} candidateEmails
 * @returns {Promise<{paymentEmail: string, matched: boolean, clientName: string}>}
 */
export async function resolvePaymentEmail(...candidateEmails) {
  const cands = [...new Set(candidateEmails.map((e) => String(e || "").toLowerCase().trim()).filter(Boolean))];
  if (!cands.length) return { paymentEmail: "", matched: false, clientName: "" };

  const anyOf = cands.map((e) => new RegExp(`^${esc(e)}$`, "i"));
  const doc = await ClientPaymentLookup.findOne({
    $or: [{ email: { $in: anyOf } }, { "gmailCredentials.email": { $in: anyOf } }]
  })
    .select("email name paymentEmail")
    .lean()
    .catch(() => null);

  if (!doc) return { paymentEmail: "", matched: false, clientName: "" };
  const pay = String(doc.paymentEmail || "").toLowerCase().trim();
  return {
    paymentEmail: EMAIL_RE.test(pay) ? pay : "",
    matched: true, // a client doc was found (paymentEmail may still be empty)
    clientName: doc.name || ""
  };
}

/**
 * Active + unpaused clients (the set the mail monitor cares about).
 * status === "active" AND not paused (isPaused false or absent).
 * @returns {Promise<Array<{email, name, paymentEmail, gmailEmail}>>}
 */
export async function getActiveUnpausedClients() {
  const docs = await ClientPaymentLookup.find({
    status: "active",
    $or: [{ isPaused: false }, { isPaused: { $exists: false } }, { isPaused: null }]
  })
    .select("email name paymentEmail gmailCredentials.email")
    .lean()
    .catch(() => []);

  return docs
    .map((d) => ({
      email: String(d.email || "").toLowerCase().trim(),
      name: d.name || "",
      paymentEmail: String(d.paymentEmail || "").toLowerCase().trim(),
      gmailEmail: String(d.gmailCredentials?.email || "").toLowerCase().trim()
    }))
    .filter((c) => c.email);
}
