import mongoose from "mongoose";

// Per-client login credentials for the Flashfire Autopilot desktop app, so
// operators never type passwords: the app pulls these and performs the
// JobRight login and the extension-panel login by itself.
//
//   jrEmail / jrPassword   - the client's jobright.ai account. jrPassword
//                            defaults to the standard team password; a
//                            client whose account differs just stores theirs.
//   extEmail / extPassword - the client's FlashFire dashboard login (what the
//                            extension panel's sign-in form takes)
//   extCode                - the 5-digit operator code the panel asks for
//   maxJobs                - per-run push cap. The autopilot stops a run once
//                            this many jobs have been pushed for the client.
//                            Defaults to 30 and may not be set above 30; a 0
//                            left by an older record is read as 30, never as
//                            "unlimited". The dashboard's own lifetime
//                            targetJobCount still applies on top of this.
//
// Storage is PLAINTEXT, deliberately matching the existing precedent in the
// scraper service (scraper_client_settings.jrPassword, operator direction
// 2026-04-27): Mongo runs on a private cluster and the read/write routes are
// gated by the x-ops-key shared secret (Middlewares/RequireOpsKey.js). If that
// posture ever changes, encrypt here and in the scraper together.
const AutopilotCredsSchema = new mongoose.Schema(
  {
    clientEmail: { type: String, required: true, unique: true, lowercase: true, trim: true },
    jrEmail: { type: String, default: "" },
    jrPassword: { type: String, default: "Jobhunt@2026" },
    extEmail: { type: String, default: "" },
    extPassword: { type: String, default: "" },
    extCode: { type: String, default: "" },
    maxJobs: { type: Number, default: 30, min: 1, max: 30 },
    updatedBy: { type: String, default: "" }
  },
  { timestamps: true, collection: "autopilotcreds" }
);

export const AutopilotCreds = mongoose.model("AutopilotCreds", AutopilotCredsSchema);
