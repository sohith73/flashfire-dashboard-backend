import mongoose from "mongoose";

// Per-client throttle for the "connect / reconnect your mail" Discord nudge.
// The connection check runs every hour, but each client is alerted at most once
// per throttle window (default 24h) — this doc records when we last pinged.
const MailClientAlertStateSchema = new mongoose.Schema(
  {
    clientEmail: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Last "no mail connected" nudge.
    lastNotConnectedAlertAt: { type: Date, default: null },
    // Last "token dead, reconnect" nudge.
    lastTokenDeadAlertAt: { type: Date, default: null }
  },
  { timestamps: true }
);

export const MailClientAlertState = mongoose.model("MailClientAlertState", MailClientAlertStateSchema);
