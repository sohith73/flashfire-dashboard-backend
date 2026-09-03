import mongoose from "mongoose";

// AI-learned EXCLUSION patterns for the mail classifier, stored in Mongo so
// the classifier improves at runtime without a deploy.
//
// Direction of learning is deliberately one-way: a learned rule can only
// EXCLUDE a mail the keyword regexes flagged as a milestone — it can never
// create a new alert. The worst a bad learned rule can do is silence, and the
// AI verifier stage still sees everything the exclusions let through, so a
// missed exclusion costs one AI call, not a wrong client email.
//
// Every rule carries full provenance (which mail triggered it, the verifier's
// reason, the model that wrote it) and can be disabled with one status flip
// (POST /gmail/mail-verify/rules/:id/disable). See
// src/services/mailRegexLearner.js for the proposal + validation pipeline.
const MailClassifierRuleSchema = new mongoose.Schema(
  {
    // The regex source (compiled with the "i" flag at load time).
    pattern: { type: String, required: true },
    // Which field of the mail the pattern is tested against.
    targetField: { type: String, enum: ["subject", "from", "body"], required: true },
    // Which positive category this exclusion guards ("any" = all three).
    category: { type: String, enum: ["interview", "assessment", "offer", "any"], default: "any" },

    status: { type: String, enum: ["active", "disabled"], default: "active", index: true },
    source: { type: String, default: "ai" }, // "ai" | "manual"

    // Provenance: the false positive that taught us this rule.
    explanation: { type: String, default: "" }, // the AI's own justification
    verifierReason: { type: String, default: "" }, // why the verifier rejected the mail
    exampleSubject: { type: String, default: "" },
    exampleFrom: { type: String, default: "" },
    createdByModel: { type: String, default: "" },

    // Effectiveness counters.
    timesMatched: { type: Number, default: 0 },
    lastMatchedAt: { type: Date, default: null }
  },
  { timestamps: true, collection: "mailclassifierrules" }
);

MailClassifierRuleSchema.index({ pattern: 1, targetField: 1 }, { unique: true });

export const MailClassifierRule = mongoose.model("MailClassifierRule", MailClassifierRuleSchema);
