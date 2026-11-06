import mongoose from "mongoose";

// One document per finished Flashfire Autopilot run, for one client.
//
// The autopilot already knew all of this - it just printed it to a terminal on
// a VPS nobody watches. Persisting it is what lets the Client Tracking portal
// answer "how did last night's scrape go for this client" without anyone
// SSHing anywhere.
//
// The three numbers ops actually asks for:
//   captured - job cards the extension pulled off JobRight (panel "#count")
//   pushed   - of those, how many reached the client's dashboard
//   rejected - captured minus pushed: AI skips, duplicates, blocked and errors
//              rolled together. The breakdown lives in dupes/blocked/errors.
//
// captured is stored under its own name rather than "total" because "total" in
// a report table reads as "total jobs", which it is not.
//
// outcome is the machine key ("list-exhausted"); outcomeLabel and why are the
// plain-English pair the autopilot already computes in describe_outcome(), and
// severity ("good"/"warn"/"bad") is what drives the colour in the UI. Storing
// all three means the portal never has to re-implement that mapping and the
// two surfaces can never drift apart.
const AutopilotRunSchema = new mongoose.Schema(
  {
    clientEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
    clientName: { type: String, default: "" },
    profile: { type: String, default: "" },

    captured: { type: Number, default: 0, min: 0 },
    pushed: { type: Number, default: 0, min: 0 },
    rejected: { type: Number, default: 0, min: 0 },
    picks: { type: Number, default: 0, min: 0 },
    dupes: { type: Number, default: 0, min: 0 },
    blocked: { type: Number, default: 0, min: 0 },
    // Named errorCount, not errors: `errors` is a reserved Mongoose document
    // property (validation state) and shadowing it breaks doc.validate().
    errorCount: { type: Number, default: 0, min: 0 },

    cap: { type: Number, default: 0, min: 0 },
    minutes: { type: Number, default: 0, min: 0 },
    attempts: { type: Number, default: 1, min: 1 },

    outcome: { type: String, default: "" },
    outcomeLabel: { type: String, default: "" },
    why: { type: String, default: "" },
    severity: { type: String, enum: ["good", "warn", "bad", ""], default: "" },
    errorText: { type: String, default: "" },

    // Which machine produced it. With the autopilot running on one VPS today
    // and possibly two later, a run with no host is unattributable.
    host: { type: String, default: "" },
    // "schedule" (nightly), "manual" (someone pressed Scrape in the autopilot
    // UI), "portal" (the Scrape button in Client Tracking) or "europe" (one
    // client of the weekday Europe run; why says what each board found).
    trigger: { type: String, default: "manual" },
    requestedBy: { type: String, default: "" },

    startedAt: { type: Date },
    // While status is "running", finishedAt holds the time of the LAST
    // progress update, so a live run sorts as the newest row and falls inside
    // every report window with no special-casing in the queries. When the run
    // ends it becomes the real finish time. A running row whose finishedAt
    // has stopped moving is a run whose machine went away - the summary
    // reports that as "interrupted" rather than leaving it "running" forever.
    finishedAt: { type: Date, required: true, index: true },

    // "running" from the moment a run starts (newer autopilot builds report at
    // start and then every few seconds), "finished" once it ends. Older builds
    // only ever post at the end, so their rows are born "finished".
    status: { type: String, enum: ["running", "finished"], default: "finished" },

    // What the panel's own counter said was pushed. Kept beside `pushed` for
    // diagnosis only: `pushed` is counted by the server from the jobs that
    // actually landed during the run, because the panel read has been seen to
    // return 0 while 33 jobs arrived (mittapallisharmelee9599, 2026-09-23).
    pushedReported: { type: Number, default: 0, min: 0 },
    // How many times reading the panel threw during the run. Non-zero means
    // captured/pushed from the panel cannot be trusted for this run.
    panelReadErrors: { type: Number, default: 0, min: 0 },

    // Where the browser actually was, so "which URL did the script scrape"
    // is answerable without the laptop that ran it.
    pageUrl: { type: String, default: "" },
    // Live status line from the extension panel while running.
    stage: { type: String, default: "" },
    // Evidence files written on the autopilot machine (captures folder):
    // the PDF report and the full-page HTML snapshot.
    report: { type: String, default: "" },
    snapshot: { type: String, default: "" }
  },
  { timestamps: true, collection: "autopilotruns" }
);

// The report's two access patterns: "latest runs overall" and "this client's
// history". Both sort newest-first, so the index carries the sort as well.
AutopilotRunSchema.index({ clientEmail: 1, finishedAt: -1 });
AutopilotRunSchema.index({ finishedAt: -1 });

export const AutopilotRun = mongoose.model("AutopilotRun", AutopilotRunSchema);
