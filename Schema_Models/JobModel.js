import mongoose from "mongoose";
export const JobSchema = new mongoose.Schema({
  jobID: {
    type: String,
    required: true,
    // unique: true,
    default: () => Date.now().toString()
  },
  dateAdded: {
    type: String,
    required: true,
    default: () => String(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))
  },
  userID: {
    type: String,
    required: true,
    default: 'www.userID.com'
  },
  jobTitle: {
    type: String,
    required: true,
    maxlength: 50,
    default: 'www.jobTitle.com'
  },
  currentStatus: {
    type: String,
    required: true,
    default: 'saved'
  },
  jobDescription: {
    type: String,
    required: false,
    default: ''
  },
  joblink: {
    type: String,
    required: false,
    default: ''
  },
  companyName: {
    type: String,
    required: true,
    default: 'unknown'
  },
  /**
   * Canonical form of `joblink`, produced by Utils/jobLinkKey.js. Duplicate
   * detection compares THIS, never the raw link: ?utm_source=…, a trailing
   * slash and a www. prefix all describe the same posting, and comparing raw
   * strings let the same URL in five times for one client.
   *
   * Empty string means the link carries no identity (blank, or a placeholder
   * like www.google.com). Readers must treat '' as "cannot compare" and skip
   * the check, or every blank-link job matches every other one.
   */
  joblinkKey: {
    type: String,
    required: false,
    default: ''
  },
  /** Job location (e.g. from extension); used for exclusion reconciliation */
  jobLocation: {
    type: String,
    required: false,
    default: ''
  },
  timeline: {
    type: [String],
    required: true,
    default: ['Added']
  },
  createdAt: {
    type: String,
    default: () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    required: true,
    immutable: true
  },
  updatedAt: {
    type: String,
    required: true,
    default: () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  },
  attachments: {
    type: [String],
    required: true,
    default: [],
    attachedAt : () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  },
  changesMade: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  downloaded:{
    type: Boolean,
    default: false
  },
  operatorName: {
    type: String,
    required: false,
    default: 'user'
  },
  operatorEmail: {
    type: String,
    required: false,
    default: 'user@flashfirehq'
  },
  extensionCode: {
    type: String,
    required: false,
    default: null
  },
  addedBy: {
    type: String,
    required: false,
    default: null
  },
  /** Who created the job in the dashboard: end client vs operations (extension jobs may omit). */
  createdByRole: {
    type: String,
    required: false,
    enum: ["user", "operations"],
    default: undefined,
  },
  appliedDate: {
    type: String,
    required: false,
    default: null
  },
  removalReason: {
    type: String,
    required: false,
    default: null
  },
  removalDate: {
    type: String,
    required: false,
    default: null
  },
  removedBy: {
    type: String,
    required: false,
    default: null
  },
  optimizedResume: {
    // R2 storage key for resume data (replaces heavy resumeData field)
    resumeDataKey: {
      type: String,
      default: null
    },
    // Legacy field - kept for backward compatibility with old records
    // resumeData: {
    //   type: mongoose.Schema.Types.Mixed,
    //   default: null
    // },
    hasResume: {
      type: Boolean,
      default: false
    },
    showSummary: {
      type: Boolean,
      default: true
    },
    showProjects: {
      type: Boolean,
      default: false
    },
    showLeadership: {
      type: Boolean,
      default: true
    },
    showPublications: {
      type: Boolean,
      default: false
    },
    // Medical resume "Therapeutic Areas" section (plain text, never AI-optimized)
    showTherapeuticAreas: {
      type: Boolean,
      default: false
    },
    sectionOrder: {
      type: [String],
      default: [
        "personalInfo",
        "summary",
        "workExperience",
        "projects",
        "leadership",
        "skills",
        "education",
        "publications",
        "therapeuticAreas"
      ]
    },
    version: {
      type: Number,
      default: 0
    },
    createdAt: {
      type: String,
      default: () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    },
    // Flag to indicate if data is stored in R2 or MongoDB
    storageType: {
      type: String,
      enum: ['r2', 'mongodb', 'legacy'],
      default: 'legacy'
    }
  },
  // Whether the optimized resume has been viewed by operations
  optimizedResumeSeen: { type: Boolean, default: false },
  // Auto-optimization tracking (background worker)
  autoOptimization: {
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed', 'skipped'],
      default: null
    },
    attempts: { type: Number, default: 0 },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lastFailedAt: { type: Date, default: null },
    retryAfter: { type: Date, default: null },
    error: { type: String, default: null }
  },
  // Second-stage screening tracking (secondJudgeWorker). Only set to
  // 'pending' for jobs pushed by the JR-Direct extension auto-judge flow.
  // The worker opens the real employer site via the scraper and re-judges the
  // full posting text against the client profile. Outcomes:
  //   • CLOSED/EXPIRED posting (skipKind 'threshold') → moved to the Removed
  //     column ("removed by AI") straight away; nobody can apply to it.
  //   • LOCATION mismatch (skipKind 'location-mismatch') → 'failed', i.e.
  //     FLAGGED for operator review. The job stays in its column and is never
  //     auto-removed; an operator resolves it to 'reviewed' (keep or remove).
  //   • 'passed' / 'skipped' → kept, no move.
  secondJudge: {
    status: {
      type: String,
      enum: ['pending', 'processing', 'passed', 'failed', 'skipped', 'reviewed'],
      default: null
    },
    attempts: { type: Number, default: 0 },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lastFailedAt: { type: Date, default: null },
    retryAfter: { type: Date, default: null },
    // Grade from the second judge (0-100) and the operator-facing reason.
    score: { type: Number, default: null },
    reason: { type: String, default: null },
    // Which check failed: 'threshold' (closed/expired posting — auto-removed),
    // 'location-mismatch' (flagged for review), or '' when the job passed.
    // null means the row predates this field (pre-upgrade flag).
    skipKind: { type: String, default: null },
    // How many chars the scraper returned for the real-site JD (diagnostics).
    scrapedChars: { type: Number, default: null },
    error: { type: String, default: null }
  }
});

// Performance indexes for fast per-user queries and recent-first sorting
JobSchema.index({ userID: 1, _id: -1 });
JobSchema.index({ operatorEmail: 1, _id: -1 });
JobSchema.index({ currentStatus: 1 });
JobSchema.index({ jobID: 1 });
JobSchema.index({ jobID: 1, userID: 1 });
// Index for sorting by most recently updated (for job tracker) - kept for backward compatibility
JobSchema.index({ userID: 1, updatedAt: -1 });
JobSchema.index({ userID: 1, dateAdded: -1 });
// Duplicate-link lookup on the add path. Deliberately NOT unique:
//   • joblink defaults to '' and operators paste placeholders, so hundreds of
//     rows legitimately share an empty key and a unique index would reject them
//   • duplicates already exist in the collection, so building a unique index
//     would fail outright
//   • a race would surface as a raw E11000 to the operator instead of the
//     readable "already added" message the controllers return
// The application-level check in Utils/jobLinkKey.js is the guard; this index
// only makes it fast.
JobSchema.index({ userID: 1, joblinkKey: 1 });
// Shared-application-form guard: counts how many distinct employers one link is
// recorded under, across ALL clients, so userID cannot lead the index here.
JobSchema.index({ joblinkKey: 1 });
// Index for auto-optimization worker polling
JobSchema.index({ 'autoOptimization.status': 1, 'autoOptimization.retryAfter': 1, _id: 1 });
// Index for second-judge worker polling
JobSchema.index({ 'secondJudge.status': 1, 'secondJudge.retryAfter': 1, _id: 1 });

export const JobModel = mongoose.model('JobDB', JobSchema)


