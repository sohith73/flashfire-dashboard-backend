import mongoose from "mongoose";

// One doc per client tracks the onboarding email sequence that fires when their
// FIRST job reaches the "Applied" column. Existence of a doc = "already handled"
// — the detector never schedules a client who already has one, so the sequence
// runs at most once per client, ever.
//
// status:
//   scheduled — steps are queued; the sender delivers each when sendAt is due
//   done      — every eligible step was sent
//   skipped   — backfilled existing client (had applied jobs before this feature
//               launched) OR no payment email; never emailed
const StepSchema = new mongoose.Schema(
  {
    key: { type: String, required: true }, // base_resume | cover_letter | linkedin
    subject: { type: String, default: "" },
    sendAt: { type: Date, required: true }, // when this step becomes due
    sentAt: { type: Date, default: null }, // set once delivered (dedupe guard)
    attempts: { type: Number, default: 0 },
    error: { type: String, default: "" },
    messageId: { type: String, default: "" } // SMTP receipt
  },
  { _id: false }
);

const OnboardingMailStateSchema = new mongoose.Schema(
  {
    clientEmail: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    clientName: { type: String, default: "" },
    planType: { type: String, default: "" },
    paymentEmail: { type: String, default: "" },
    firstAppliedAt: { type: Date, default: null },
    status: { type: String, enum: ["scheduled", "done", "skipped"], default: "scheduled", index: true },
    skipReason: { type: String, default: "" },
    steps: { type: [StepSchema], default: [] }
  },
  { timestamps: true }
);

// Sender sweep: find docs with an unsent, due step quickly.
OnboardingMailStateSchema.index({ status: 1, "steps.sentAt": 1, "steps.sendAt": 1 });

export const OnboardingMailState = mongoose.model("OnboardingMailState", OnboardingMailStateSchema);

// A single marker doc (clientEmail = MARKER) records that the one-time backfill
// of pre-existing applied-clients has run, so it never re-runs.
export const ONBOARDING_BACKFILL_MARKER = "__onboarding_backfill_marker__";
