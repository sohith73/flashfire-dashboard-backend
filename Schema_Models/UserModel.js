// UserModel.js
import mongoose from "mongoose";
import { baseResumeSchema, coverLetterSchema, optimizedResumeSchema, transcriptSchema, portfolioLinkSchema } from "./Opt.Resumes_Cover_Schemas.js";

export const userSchema = new mongoose.Schema(
  {
    userID: { type: String, required: true, default: () => String(Date.now()) },
    name:   { type: String, required: true },
    email:  { type: String, required: true },
    passwordHashed: { type: String, required: true, default: "--NO Password --/OAUTH" },

    // Base resume (single)
    resumeLink: { type: [baseResumeSchema], default: [] },

    // Plural arrays + [] defaults
    coverLetters:     { type: [coverLetterSchema],     default: [] },
    optimizedResumes: { type: [optimizedResumeSchema], default: [] },
    transcript : {type : [transcriptSchema], default : []},
    portfolioLinks: { type: [portfolioLinkSchema], default: [] },
    planType:  { 
      type: String, 
      required: true, 
      default: "Free Trial",
      enum: ["Free Trial", "Prime", "Ignite", "Professional", "Executive"]
    },
    joinTime: {
      type: String,
      required: true,
      default: "in 1 week",
      enum: ["in 1 week", "in 2 week", "in 3 week", "in 4 week", "in 6-7 week"]
    },
    planLimit: { type: Number, default: null },
    userType:  { type: String, default: "User" },
    dashboardManager: { type: String, required: false, default: "" },
    removedJobsCount: { type: Number, default: 0 },
    // Extra job removals granted by an operator on top of the global REMOVAL_LIMIT (100).
    // Effective cap = REMOVAL_LIMIT + extraRemovalLimit. 0 = no bonus.
    extraRemovalLimit: { type: Number, default: 0 },
    assignedResumeId: { type: String, default: null },
    referralStatus: {
      type: String,
      enum: ["Professional", "Executive", null],
      default: null
    },
    referrals: [
      {
        name: { type: String, required: true },
        plan: {
          type: String,
          enum: ["Professional", "Executive"],
          required: true,
        },
        notes: { type: String, default: "" },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    // Set on the REFERRED client (not the referrer) the first time their
    // referral is processed, so the referrer can never be credited twice for
    // the same person however often their plan is re-saved. `status` also
    // leaves a trail for the names we deliberately refused to guess at.
    referralCredit: {
      referredByName: { type: String, default: "" },
      referrerEmail: { type: String, default: "" },
      plan: { type: String, default: "" },
      status: {
        type: String,
        enum: ["credited", "unmatched", "ambiguous", "self", null],
        default: null,
      },
      candidates: { type: [String], default: [] },
      processedAt: { type: Date, default: null },
    },
    notes: {
      type: String,
      default: ""
    },
    addons: {
      type: [
        {
          type: { type: String },
          price: { type: Number },
          currency: { type: String, default: "USD" },
          addedAt: { type: String },
        }
      ],
      default: []
    },
    amountPaid: { type: String, default: "0" },
    currency: { type: String, default: "USD" }, // "USD", "CAD", "GBP"
  },
  { timestamps: true }
);

export const UserModel = mongoose.model("users", userSchema);
