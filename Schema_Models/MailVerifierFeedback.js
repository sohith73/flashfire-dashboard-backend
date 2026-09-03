import mongoose from "mongoose";

// Per-sender-domain feedback from the milestone verifier (the AI second stage
// behind client alerts). One doc per domain, counters bumped on every verdict:
//   rejectCount  — the rules classifier flagged a mail from this domain as a
//                  milestone and the AI said it was NOT one (false positive)
//   genuineCount — the AI confirmed a real milestone from this domain
//
// Two consumers:
//   1. mailVerifierLearning.shouldSuppressSender() — a domain with repeated
//      AI rejections and zero genuine passes is suppressed BEFORE the AI call:
//      deterministic, zero-cost, and it makes the pipeline stop re-litigating
//      the same newsletter sender every day.
//   2. GET /gmail/mail-verify/feedback — the evidence list (example subjects +
//      rejection reasons) an engineer reads to tighten the regexes in
//      Utils/mailRulesClassifier.js deliberately, with tests, instead of the
//      classifier rewriting itself at runtime.
const ExampleSchema = new mongoose.Schema(
  {
    subject: { type: String, default: "" },
    reason: { type: String, default: "" },
    rulesCategory: { type: String, default: "" },
    genuine: { type: Boolean, default: false },
    at: { type: Date, default: Date.now }
  },
  { _id: false }
);

const MailVerifierFeedbackSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, unique: true, lowercase: true, trim: true },
    rejectCount: { type: Number, default: 0 },
    genuineCount: { type: Number, default: 0 },
    lastSeenAt: { type: Date, default: null },
    // Rolling window of recent verdicts (newest first, capped via $slice).
    examples: { type: [ExampleSchema], default: [] }
  },
  { timestamps: true, collection: "mailverifierfeedback" }
);

MailVerifierFeedbackSchema.index({ rejectCount: -1 });

export const MailVerifierFeedback = mongoose.model("MailVerifierFeedback", MailVerifierFeedbackSchema);
