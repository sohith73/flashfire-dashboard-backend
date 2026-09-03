import mongoose from "mongoose";

// Per-client SpeedyApply autofill data, keyed by the client's dashboard email.
// The SpeedyApply Chrome extension saves the profile a client fills in (name,
// contact, EEO answers, links, etc.), their settings, their parsed resume, the
// application tracker, and the learned label→field aliases here so that logging
// in on any machine restores everything.
//
// The payloads are stored as opaque blobs (Mixed) — the extension owns their
// exact shape, and the backend never needs to interpret them. Keeping them
// loose means a new field in the extension form needs no schema change.
const SpeedyApplyProfileSchema = new mongoose.Schema(
  {
    clientEmail: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    profile: { type: mongoose.Schema.Types.Mixed, default: null }, // the autofill form fields
    settings: { type: mongoose.Schema.Types.Mixed, default: null }, // toggles / preferences
    resume: { type: mongoose.Schema.Types.Mixed, default: null }, // { name, size, mimeType, r2Key }
    tracker: { type: [mongoose.Schema.Types.Mixed], default: undefined }, // logged applications, newest first
    learned: { type: mongoose.Schema.Types.Mixed, default: null }, // label → profile-field aliases

    // The client's Gemini key. Stored AES-encrypted (see Utils/CryptoHelper.js)
    // in `apiKeyEnc`; `apiKey` is the legacy plaintext column, kept only so old
    // rows still resolve. New writes always go to apiKeyEnc and blank apiKey.
    apiKey: { type: String, default: "" },
    apiKeyEnc: { type: String, default: "" },

    updatedAt: { type: Date, default: Date.now }
  },
  { collection: "speedyapplyprofiles", minimize: false }
);

export const SpeedyApplyProfile = mongoose.model("SpeedyApplyProfile", SpeedyApplyProfileSchema);
