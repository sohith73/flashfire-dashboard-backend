// import mongoose from "mongoose";

// // Schema for undergraduate transcript (similar to resume structure)
// const undergraduateTranscriptSchema = new mongoose.Schema({
//   url: { type: String, required: true }, // Cloudinary URL
//   uploadedAt: { type: Date, default: Date.now },
//   fileName: { type: String, default: "" }
// }, { _id: false });

// export const profileSchema = new mongoose.Schema({
//   email: {
//     type: String,
//     required: true,
//     unique: true,
//   },
//   contactEmail: {
//     type: String,
//     required: false,
//   },
//   firstName: {
//     type: String,
//     required: true,
//   },
//   lastName: {
//     type: String,
//     required: true,
//   },
//   contactNumber: {
//     type: String,
//     required: true,
//   },
//   dob: {
//     type: String,
//     required: true,
//   },
//   address: {
//     type: String,
//     required: true,
//   },
//   visaStatus: {
//     type: String,
//     enum: ["CPT", "F1", "F1 OPT", "F1 STEM OPT", "H1B", "Green Card", "U.S. Citizen", "Other"],
//     required: true,
//   },
//   otherVisaType: {
//     type: String,
//     required: false,
//     default: "",
//   },
//   bachelorsUniDegree: {
//     type: String,
//     required: true,
//   },
//   bachelorsGradMonthYear: {
//     type: String,
//     required: true,
//   },
//   bachelorsGPA: {
//     type: String,
//     required: false,
//     default: "",
//   },
//   mastersUniDegree: {
//     type: String,
//     required: true,
//   },
//   mastersGradMonthYear: {
//     type: String,
//     required: true,
//   },
//   mastersGPA: {
//     type: String,
//     required: false,
//     default: "",
//   },
//   transcriptUrl: {
//     type: String,
//     required: false,
//     default: "",
//   },
//   // Keep the old gpa field for backward compatibility
//   gpa: { 
//     type: Number, 
//     required: false,
//     min: 0,
//     max: 4,
//     validate: {
//       validator: function(v) {
//         return v === null || v === undefined || (v >= 0 && v <= 4);
//       },
//       message: 'GPA must be between 0 and 4'
//     }
//   },
//   undergraduateTranscript: { type: undergraduateTranscriptSchema, default: null }, // PDF file storage
//   preferredRoles: {
//     type: [String],
//     required: true,
//   },
//   experienceLevel: {
//     type: String,
//     enum: ["Entry level", "0-2 Years", "0-3 Years", "0-4 Years", "0-5 Years", "0-6 Years", "0-7 Years", "Other"],
//     required: true,
//   },
//   expectedSalaryRange: {
//     type: String,
//     enum: ["60k-100k", "100k-150k", "150k-200k", "Other"],
//     required: true,
//   },
//   preferredLocations: {
//     type: [String],
//     required: true,
//   },
//   targetCompanies: {
//     type: [String],
//     required: true,
//   },
//   reasonForLeaving: {
//     type: String,
//     required: false,
//   },
//   joinTime: {
//     type: String,
//     enum: ["in 1 week", "in 2 week", "in 3 week", "in 4 week", "in 6-7 week"],
//     required: true,
//     default: "in 1 week"
//   },
//   linkedinUrl: {
//     type: String,
//     required: false,
//   },
//   githubUrl: {
//     type: String,
//     required: false,
//   },
//   portfolioUrl: {
//     type: String,
//     required: false,
//   },
//   resumeUrl: {
//     type: String,
//     required: false,
//   },
//   coverLetterUrl: {
//     type: String,
//     required: false,
//   },
//   portfolioFileUrl: {
//     type: String,
//     required: false,
//   },
//   confirmAccuracy: {
//     type: Boolean,
//     required: true,
//   },
//   agreeTos: {
//     type: Boolean,
//     required: true,
//   },
//   ssn: {
//     type: String,
//     validate: {
//       validator: function(v) {
//         return v === "" || /^\d{3}$/.test(v);
//       },
//       message: "SSN must be the last 3 digits or left blank."
//     },
//     required: false,
//   },
//   references: {
//     type: String,
//     required: false,
//     default: "",
//   },
//   dashboardManager: {
//     type: String,
//     required: false,
//     default: "",
//   },
//   dashboardManagerContact: {
//     type: String,
//     required: false,
//     default: "",
//   },
// }, {
//   timestamps: true
// });

// export const ProfileModel = mongoose.model("Profile", profileSchema);

import mongoose from "mongoose";

// Schema for undergraduate transcript (similar to resume structure)
const undergraduateTranscriptSchema = new mongoose.Schema({
  url: { type: String, required: true }, // Cloudinary URL
  uploadedAt: { type: Date, default: Date.now },
  fileName: { type: String, default: "" }
}, { _id: false });

export const profileSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
  },
  contactEmail: {
    type: String,
    required: false,
  },
  firstName: {
    type: String,
    required: true,
  },
  lastName: {
    type: String,
    required: true,
  },
  contactNumber: {
    type: String,
    required: true,
  },
  dob: {
    type: String,
    required: true,
  },
  address: {
    type: String,
    required: true,
  },
  visaStatus: {
    type: String,
    enum: ["CPT", "F1", "F1 OPT", "F1 STEM OPT", "H1B", "Green Card", "U.S. Citizen", "Canadian Citizen", "Permanent Resident (PR)", "Post-Graduation Work Permit (PGWP)", "Open Work Permit (OWP)", "Employer-Specific (Closed) Work Permit", "Study Permit", "Student Visa", "Short-term Study Visa", "Graduate Visa", "Skilled Worker Visa", "Global Talent Visa", "Other"],
    required: true,
  },
  otherVisaType: {
    type: String,
    required: false,
    default: "",
  },
  bachelorsUniDegree: {
    type: String,
    required: true,
  },
  bachelorsStartDate: {
    type: String,
    required: false,
    default: "",
  },
  bachelorsGradMonthYear: {
    type: String,
    required: true,
  },
  bachelorsEndDate: {
    type: String,
    required: false,
    default: "",
  },
  bachelorsGPA: {
    type: String,
    required: false,
    default: "",
  },
  mastersUniDegree: {
    type: String,
    required: false,
    default: "",
  },
  mastersStartDate: {
    type: String,
    required: false,
    default: "",
  },
  mastersGradMonthYear: {
    type: String,
    required: false,
    default: "",
  },
  mastersEndDate: {
    type: String,
    required: false,
    default: "",
  },
  mastersGPA: {
    type: String,
    required: false,
    default: "",
  },
  transcriptUrl: {
    type: String,
    required: false,
    default: "",
  },
  // Keep the old gpa field for backward compatibility
  gpa: { 
    type: Number, 
    required: false,
    min: 0,
    max: 4,
    validate: {
      validator: function(v) {
        return v === null || v === undefined || (v >= 0 && v <= 4);
      },
      message: 'GPA must be between 0 and 4'
    }
  },
  undergraduateTranscript: { type: undergraduateTranscriptSchema, default: null }, // PDF file storage
  preferredRoles: {
    type: [String],
    required: true,
  },
  experienceLevel: {
    type: String,
    // Accepts the onboarding form's seniority labels plus the legacy
    // year-range values (older profiles / scraper). Kept as a union so
    // create-path .save() validation no longer rejects current form values.
    enum: [
      "Entry Level", "Mid Level", "Senior Level", "Executive",
      "Entry level", "0-2 Years", "0-3 Years", "0-4 Years", "0-5 Years", "0-6 Years", "0-7 Years", "Other",
    ],
    required: true,
  },
  // YOE — total years of professional experience (numeric). Optional; used
  // by the scraper/AI to gauge seniority more precisely than the level label.
  yearsOfExperience: {
    type: Number,
    required: false,
    min: 0,
    max: 60,
    default: null,
  },
  expectedSalaryRange: {
    type: String,
    enum: ["60k-100k", "100k-150k", "150k-200k", "Other"],
    required: true,
  },
  preferredLocations: {
    type: [String],
    required: true,
  },
  targetCompanies: {
    type: [String],
    required: true,
  },
  reasonForLeaving: {
    type: String,
    required: false,
  },
  // Free-text availability note from the onboarding form (e.g. "after May").
  availabilityNote: {
    type: String,
    required: false,
    default: "",
  },
  // Free-text salary expectation note from the onboarding form.
  expectedSalaryNarrative: {
    type: String,
    required: false,
    default: "",
  },
  // Employment types the candidate WILL accept. Multi-select from the
  // /profile UI. Defaults to ["Full-time"] when the client never edited
  // it — matches the legacy behavior (most clients want full-time only).
  // Used by the JR-direct extension + scraper to filter postings before
  // AI judging and surfaced in the AI summary so the model honors it.
  // Allowed values: "Full-time" | "Part-time" | "Contract" | "Internship".
  employmentTypes: {
    type: [String],
    required: false,
    default: ["Full-time"],
  },
  veteranStatus: {
    type: String,
    required: false,
    default: "",
  },
  disabilityStatus: {
    type: String,
    required: false,
    default: "",
  },
  scholarshipRequired: {
    type: String,
    required: false,
    default: "",
  },
  usWorkEligibility: {
    type: String,
    required: false,
    default: "",
  },
  joinTime: {
    type: String,
    // Onboarding form labels + legacy values, unioned so create-path
    // validation accepts what the form actually sends.
    enum: [
      "Immediately", "2 weeks", "1 month", "2-3 months", "3+ months",
      "in 1 week", "in 2 week", "in 3 week", "in 4 week", "in 6-7 week",
    ],
    required: true,
    default: "in 1 week"
  },
  linkedinUrl: {
    type: String,
    required: false,
  },
  githubUrl: {
    type: String,
    required: false,
  },
  portfolioUrl: {
    type: String,
    required: false,
  },
  resumeUrl: {
    type: String,
    required: false,
  },
  coverLetterUrl: {
    type: String,
    required: false,
  },
  portfolioFileUrl: {
    type: String,
    required: false,
  },
  confirmAccuracy: {
    type: Boolean,
    required: true,
  },
  agreeTos: {
    type: Boolean,
    required: true,
  },
  ssn: {
    type: String,
    validate: {
      validator: function(v) {
        return v === "" || /^\d{3}$/.test(v);
      },
      message: "SSN must be the last 3 digits or left blank."
    },
    required: false,
  },
  references: {
    type: String,
    required: false,
    default: "",
  },
  dashboardManager: {
    type: String,
    required: false,
    default: "",
  },
  dashboardManagerContact: {
    type: String,
    required: false,
    default: "",
  },
  referredBy: {
    type: String,
    required: false,
    default: "",
  },
  // Maximum number of jobs operators are allowed to push for this
  // client. /addjob checks JobModel.count vs this and refuses past the
  // cap with TARGET_REACHED so we don't over-fill the tracker. Set in
  // CT RegisterClient or the AI Summary admin tab.
  //
  // Defaults to 30 so every new client is capped at the standard daily
  // target out of the box. NOTE: this default only stamps NEWLY created
  // profiles — pre-existing rows with a null value are not migrated, but
  // dailyCapGuard.readCap already treats null/0 as the same 30 (its
  // DEFAULT_DAILY_CAP), so uncapped legacy clients are enforced at 30 too.
  // There is no "unlimited" value: a positive number sets an explicit cap,
  // anything else resolves to the 30 default.
  targetJobCount: {
    type: Number,
    required: false,
    default: 30,
    min: 0,
    max: 10000,
  },
  // AI-generated candidate summary (≤500 words). Built once from
  // profile + resume by the JR-direct extension and reused by every
  // job-fit grading call so picks stay consistent + cheaper.
  aiSummary: {
    type: String,
    required: false,
    default: "",
  },
  // Metadata about the last summary build — model used, source,
  // timestamp. Kept separately so we can invalidate / regenerate.
  aiSummaryMeta: {
    builtAt: { type: Date, required: false, default: null },
    model: { type: String, required: false, default: "" },
    source: { type: String, required: false, default: "" }, // "profile+resume" / "profile-only"
    wordCount: { type: Number, required: false, default: 0 },
    // Snapshot of the profile fields the prompt actually consumed at build time.
    // On the next rebuild we diff this against the current profile so the AI
    // gets an explicit changed-fields list ("removed location 'New York'") and
    // can strip stale references — without this the model often retains old
    // wording even when the new profile contradicts it.
    profileSnapshot: { type: Object, required: false, default: null },
    // Timestamp of last build attempt (success OR failure). Used by the
    // cron sweeper to skip recently-failed profiles, avoiding wasted
    // OpenAI/Gemini calls on broken profiles every 30 min.
    lastAttemptAt: { type: Date, required: false, default: null },
    // Async build lifecycle. POST /build-ai-summary now returns 202 and runs
    // the OpenAI work in the background (the full build is 90-150s, longer
    // than Cloudflare's ~100s origin timeout, so a synchronous response 502s).
    //   status         — "idle" | "building" | "done" | "error"
    //   buildStartedAt — when the current/last background build began
    //   lastError      — { error, message, step } from the last failed build
    // The clients-tracking AI Summary page polls GET /ai-summary-status until
    // status leaves "building".
    status: { type: String, required: false, default: "idle" },
    buildStartedAt: { type: Date, required: false, default: null },
    lastError: { type: Object, required: false, default: null },
    // Per-bullet provenance map from the AI build. Each # section header
    // maps to two parallel arrays of source codes — one per bullet, one per
    // prose line — in document order. Codes: "R" = resume, "P" = profile,
    // "RP" = both, "I" = inferred. Used by the UI to color-tint each line
    // so operators can see at a glance which facts came from where. Stripped
    // of inline markers before the summary string is persisted.
    provenance: { type: Object, required: false, default: null },
    // Which inputs actually fed this build — { notes:bool, resume:bool,
    // profile:bool }. The UI renders this as input-source pills next to
    // the model name so operators can confirm the notes / resume actually
    // reached the model.
    builtInputs: {
      notes: { type: Boolean, required: false, default: false },
      resume: { type: Boolean, required: false, default: false },
      profile: { type: Boolean, required: false, default: true },
      // True when profile.removalFeedback had at least one reasoned entry at
      // build time, i.e. the client's own removal reasons were injected into
      // the prompt. Drives the "Removal feedback" input pill in
      // clients-tracking so operators can see the summary reflects the
      // client's latest removals.
      removalFeedback: { type: Boolean, required: false, default: false },
    },
    // Sampling temperature used for this build. Surfaced in the UI so
    // operators can tell whether a brief was generated with the strict
    // 0.15 setting or an experimental tuning.
    temperature: { type: Number, required: false, default: 0 },
  },
  // Snapshot of the PREVIOUS aiSummary, taken every time a build or manual
  // edit overwrites it. Powers the "what changed" diff in clients-tracking
  // so operators can see exactly which bullets a rebuild (e.g. one driven
  // by client removal feedback) added or dropped. One version deep.
  aiSummaryPrevious: {
    text: { type: String, required: false, default: "" },
    builtAt: { type: Date, required: false, default: null },
    source: { type: String, required: false, default: "" },
    wordCount: { type: Number, required: false, default: 0 },
  },
  // True when the profile has changed since the last summary build.
  // Set true by Add_Update_Profile.js / file-upload paths; reset to false
  // when BuildAiSummary or UpdateAiSummary completes. Drives "rebuild"
  // banners in the AI Summary admin page.
  summaryStale: {
    type: Boolean,
    required: false,
    default: true,
  },
  // When a rebuild trigger fires while a build is ALREADY running, that
  // trigger is skipped (two concurrent builds race on the same document) and
  // its timestamp is recorded here instead. The running build compares this
  // against its own start time on persist: newer means it never saw the change
  // that fired the skipped trigger, so it leaves summaryStale=true and the
  // 30-min sweep rebuilds. Lives OUTSIDE aiSummaryMeta on purpose — the build
  // rewrites that whole object and would clobber the flag.
  summaryRebuildRequestedAt: {
    type: Date,
    required: false,
    default: null,
  },
  // Operator-saved "format overlay". When enabled, every future
  // BuildAiSummary rebuild re-injects the bullets the operator added on top
  // of the AI's output (per # section). Set via POST /save-summary-overlay
  // from the clients-tracking AI Summary editor.
  //   savedText   — full edited summary the operator clicked "Save format" on.
  //   savedAt     — timestamp of the save.
  //   enabled     — toggle so clear-overlay can disable without losing the text.
  aiSummaryOverlay: {
    savedText: { type: String, required: false, default: "" },
    savedAt: { type: Date, required: false, default: null },
    enabled: { type: Boolean, required: false, default: false },
    // Section headers the operator marked "do not touch". On every rebuild the
    // saved text for each locked header replaces the AI's freshly-generated
    // section. Unlocked sections merge via mergeOverlay (sticky bullets only).
    lockedSections: { type: [String], required: false, default: [] },
  },
  // Operator-authored "Notes to AI" — free-text block injected into every
  // BuildAiSummary prompt as authoritative context. Use for client-specific
  // guidance the structured profile can't capture (e.g. "candidate wants ML
  // research roles only, not infra"; "skip recruiters outside Bay Area";
  // "exclude any company on the 'avoid' list circulated by ops").
  aiNotes: {
    text: { type: String, required: false, default: "" },
    updatedAt: { type: Date, required: false, default: null },
    updatedBy: { type: String, required: false, default: "" },
  },
  // Client-authored removal feedback. When the client drags a job card to
  // Removed on their dashboard they must say why; UpdateChanges pushes each
  // reason here (newest first, capped via $slice) and fires an auto summary
  // rebuild. BuildAiSummary injects these as a high-priority signal block —
  // second only to operator aiNotes — so the picker stops surfacing jobs
  // matching the complaint. Kept separate from aiNotes on purpose: aiNotes
  // is operator-edited directive text with strict SCRAP/SKIP semantics;
  // this is raw client feedback with its own routing rules.
  removalFeedback: [{
    _id: false,
    jobID: { type: String, required: false, default: "" },
    jobTitle: { type: String, required: false, default: "" },
    companyName: { type: String, required: false, default: "" },
    reason: { type: String, required: false, default: "" },
    removedAt: { type: Date, required: false, default: null },
    removedBy: { type: String, required: false, default: "user" },
  }],
  // Per-client scrape-source allowlist for the JR-direct extension. Values are
  // site slugs: "jobright", "indeed" (ca.indeed.com), "reed" (reed.co.uk),
  // and/or "flexa" (flexa.careers). The extension only
  // captures cards from sites in this list for the selected client. Empty/unset
  // → defaults to ["jobright"] (JobRight-only) on the extension side, so a
  // client is never scraped from a site ops didn't enable. Set in
  // clients-tracking → AI Summary tab → "Scrape sources".
  scrapeSources: {
    type: [String],
    required: false,
    default: ["jobright"],
  },
  // Operator's per-client OpenAI API key. Used by the JR-direct extension's
  // SW to call api.openai.com directly for the auto-judge step. Stored as
  // plain text per ops decision — extension fetches it on /extension/clientLogin
  // and stores it in chrome.storage.local on the operator's device.
  openaiKey: {
    type: String,
    required: false,
    default: "",
  },
}, {
  timestamps: true
});

export const ProfileModel = mongoose.model("Profile", profileSchema);






