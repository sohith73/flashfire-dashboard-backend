import { AutopilotCreds } from "../Schema_Models/AutopilotCreds.js";

// Every client is capped at 30 pushes per run: the default when nothing is
// saved, and the highest value an operator may set.
// Standard JobRight password for client accounts; a stored per-client
// password always wins over it.
const DEFAULT_JR_PASSWORD = "Jobhunt@2026";
const DEFAULT_JOB_CAP = 30;
const MAX_JOB_CAP = 30;

// Autopilot credential store - see Schema_Models/AutopilotCreds.js for what
// lives here and why it is plaintext. Every route below is mounted behind
// requireOpsKey (x-ops-key header); the list route still never returns secrets.

// GET /autopilot/creds - which clients have credentials on file (no secrets).
export const listAutopilotCreds = async (_req, res) => {
  try {
    const docs = await AutopilotCreds.find({}).select("clientEmail updatedAt").lean();
    res.status(200).json({
      success: true,
      count: docs.length,
      data: docs.map((d) => ({ clientEmail: d.clientEmail, updatedAt: d.updatedAt }))
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /autopilot/creds/:email - full record for one client (the app uses it
// to run the JobRight + panel logins).
export const getAutopilotCreds = async (req, res) => {
  try {
    const email = String(req.params.email || "").toLowerCase().trim();
    if (!email.includes("@")) return res.status(400).json({ success: false, message: "bad email" });
    const doc = await AutopilotCreds.findOne({ clientEmail: email }).lean();
    if (!doc) return res.status(404).json({ success: false, message: "no credentials on file" });
    res.status(200).json({
      success: true,
      data: {
        clientEmail: doc.clientEmail,
        jrEmail: doc.jrEmail || "",
        jrPassword: doc.jrPassword || DEFAULT_JR_PASSWORD,
        extEmail: doc.extEmail || "",
        extPassword: doc.extPassword || "",
        extCode: doc.extCode || "",
        // A stored 0 predates the cap; report the effective value instead.
        maxJobs: Number.isFinite(doc.maxJobs) && doc.maxJobs > 0 ? Math.min(doc.maxJobs, MAX_JOB_CAP) : DEFAULT_JOB_CAP
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /autopilot/creds/:email - upsert. Only provided fields are changed, so
// an operator can update just the JobRight password without retyping the rest.
export const putAutopilotCreds = async (req, res) => {
  try {
    const email = String(req.params.email || "").toLowerCase().trim();
    if (!email.includes("@")) return res.status(400).json({ success: false, message: "bad email" });
    const allowed = ["jrEmail", "jrPassword", "extEmail", "extPassword", "extCode", "updatedBy"];
    const set = {};
    for (const k of allowed) {
      if (typeof req.body?.[k] === "string") set[k] = req.body[k].trim();
    }
    // maxJobs is numeric, so it cannot ride the string loop above - and an
    // empty string must leave the stored value alone rather than reset it.
    if (req.body?.maxJobs !== undefined && req.body.maxJobs !== "") {
      const n = Number.parseInt(req.body.maxJobs, 10);
      if (!Number.isInteger(n) || n < 1 || n > MAX_JOB_CAP) {
        return res.status(400).json({ success: false, message: `maxJobs must be an integer between 1 and ${MAX_JOB_CAP}` });
      }
      set.maxJobs = n;
    }
    if (!Object.keys(set).length) {
      return res.status(400).json({ success: false, message: "no credential fields in body" });
    }
    await AutopilotCreds.updateOne({ clientEmail: email }, { $set: set }, { upsert: true });
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
