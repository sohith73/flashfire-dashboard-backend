import mongoose from "mongoose";

/**
 * One row per reminder delivery attempt (daily summary, inactivity alert),
 * written by the single delivery path in src/services/clientReminderWorker.js
 * for the cron, the threshold auto-send and the operator's "Send now".
 *
 * Why a collection of its own when ClientReminderConfig already has history:
 * that array is capped at 50 rows per client, newest first, and skips count
 * towards the cap, so it holds about six weeks for one client and cannot
 * answer "what went out to everybody yesterday". This is the append-only
 * audit trail the Operations > Reminders history pages through. The embedded
 * array stays, because the per-item "last sent" state is read from there.
 */
const reminderDeliverySchema = new mongoose.Schema(
  {
    clientEmail: { type: String, required: true, lowercase: true, trim: true },
    clientName: { type: String, default: "" },
    itemKey: { type: String, required: true },
    periodKey: { type: String, default: "" },
    // cron | auto-threshold | manual (send-now)
    trigger: { type: String, default: "cron" },
    // sent | failed | skipped (email is the only channel; "partial" only
    // appears on rows written while Mattermost was a second channel)
    status: { type: String, required: true },
    // Machine reason: "ok", "nothing_added", "email: <smtp error>", ...
    reason: { type: String, default: "" },
    subject: { type: String, default: "" },
    email: {
      attempted: { type: Boolean, default: false },
      ok: { type: Boolean, default: false },
      to: { type: String, default: "" },
      error: { type: String, default: "" }
    },
    stats: {
      added: { type: Number, default: 0 },
      applied: { type: Number, default: 0 }
    },
    at: { type: Date, required: true }
  },
  { versionKey: false, collection: "reminderdeliveries" }
);

// The history list: everyone, newest first, optionally by status.
reminderDeliverySchema.index({ at: -1 });
reminderDeliverySchema.index({ status: 1, at: -1 });
// One client's history.
reminderDeliverySchema.index({ clientEmail: 1, at: -1 });
// Makes the backfill from the embedded history idempotent: re-running it
// cannot duplicate a row, and a live write never collides with it because two
// attempts for one client and item never share a millisecond.
reminderDeliverySchema.index({ clientEmail: 1, itemKey: 1, at: 1 }, { unique: true });

export const ReminderDelivery =
  mongoose.models.ReminderDelivery || mongoose.model("ReminderDelivery", reminderDeliverySchema);

export default ReminderDelivery;
