import { ProfileModel } from "../../Schema_Models/ProfileModel.js";
import { buildSummaryForEmail } from "../BuildAiSummary.js";

function triggerSummaryRebuild(email, reason) {
  if (!email) return;
  setImmediate(() => {
    buildSummaryForEmail(email, reason)
      .then((r) => {
        if (r?.success) console.log(`[summary-rebuild:${reason}] ok email=${email} words=${r.wordCount}`);
        else if (r?.skipped) console.log(`[summary-rebuild:${reason}] skipped email=${email} — a build is already running, profile left stale for the sweep`);
        else console.warn(`[summary-rebuild:${reason}] fail email=${email} err=${r?.error}`);
      })
      .catch((e) => console.error(`[summary-rebuild:${reason}] threw email=${email}`, e));
  });
}

const ALLOWED_FIELDS = new Set([
  // Personal
  "firstName", "lastName", "middleName", "suffix", "pronouns",
  "contactEmail", "contactNumber", "phoneExt", "dob",
  // Location
  "address", "streetAddress", "addressLine2", "city", "state", "country", "zip",
  // Work auth
  "visaStatus", "otherVisaType", "visaExpiry", "needsSponsorship",
  // Current / previous job
  "currentTitle", "lastEmployer", "lastJobTitle", "lastJobStart", "lastJobEnd", "lastJobResponsibilities",
  // Education
  "schoolName", "degreeLevel", "fieldOfStudy", "graduationYear", "coursework",
  "bachelorsUniDegree", "bachelorsStartDate", "bachelorsGradMonthYear", "bachelorsEndDate", "bachelorsGPA",
  "mastersUniDegree", "mastersStartDate", "mastersGradMonthYear", "mastersEndDate", "mastersGPA",
  "transcriptUrl",
  // Skills / summary
  "summaryText", "skillsText", "certificationsText", "languagesText",
  // Compensation / availability
  "preferredRoles", "experienceLevel", "expectedSalaryRange",
  "salaryMin", "salaryMax", "currentSalary", "noticePeriod",
  "preferredLocations", "targetCompanies", "reasonForLeaving", "joinTime", "joinDate",
  // Links
  "linkedinUrl", "githubUrl", "portfolioUrl", "twitterUrl", "stackoverflowUrl", "dribbbleUrl",
  "resumeUrl", "coverLetterUrl", "portfolioFileUrl",
  // Diversity / EEO
  "gender", "ethnicity", "veteranStatus", "disability",
  // Misc
  "hearAboutUs", "referralName", "securityClearance", "driversLicense",
  "references", "referredBy",
]);

const ARRAY_FIELDS = new Set(["preferredRoles", "preferredLocations", "targetCompanies"]);
const URL_FIELDS = new Set(["linkedinUrl", "githubUrl", "portfolioUrl", "resumeUrl", "coverLetterUrl", "portfolioFileUrl", "transcriptUrl"]);
const DATE_FIELDS = new Set(["dob", "visaExpiry", "bachelorsStartDate", "bachelorsGradMonthYear", "bachelorsEndDate", "mastersStartDate", "mastersGradMonthYear", "mastersEndDate"]);
const MAX_STR = 2000;
const MAX_ARR = 100;
const MAX_ARR_ITEM = 200;

function sanitize(value, field) {
  if (ARRAY_FIELDS.has(field)) {
    let arr;
    if (Array.isArray(value)) arr = value;
    else if (typeof value === "string") arr = value.split(/[,;]/);
    else return [];
    return arr
      .map(v => String(v).trim().slice(0, MAX_ARR_ITEM))
      .filter(Boolean)
      .slice(0, MAX_ARR);
  }
  if (value === null || value === undefined) return "";
  let v = typeof value === "string" ? value.trim() : value;
  if (typeof v === "string") {
    v = v.slice(0, MAX_STR);
    if (URL_FIELDS.has(field) && v) {
      // allow http(s) only — block javascript:, data:, etc.
      if (!/^https?:\/\//i.test(v)) return "";
    }
    if (DATE_FIELDS.has(field) && v) {
      // accept YYYY-MM-DD, MM/YYYY, MM YYYY, Month YYYY — reject anything > 32 chars or with control chars
      if (v.length > 32 || /[\x00-\x1f]/.test(v)) return "";
    }
  }
  return v;
}

export async function extGetProfile(req, res) {
  try {
    const email = req.user?.email;
    if (!email) return res.status(401).json({ message: "Unauthorized" });
    const profile = await ProfileModel.findOne({ email }).lean();
    return res.status(200).json({ success: true, profile: profile || { email } });
  } catch (err) {
    console.error("extGetProfile error", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

export async function extPatchProfile(req, res) {
  try {
    const email = req.user?.email;
    if (!email) return res.status(401).json({ message: "Unauthorized" });

    const body = req.body || {};
    let patch = {};

    if (body.patch && typeof body.patch === "object") {
      patch = body.patch;
    } else if (typeof body.field === "string") {
      patch = { [body.field]: body.value };
    } else {
      patch = body;
    }

    const $set = {};
    for (const [key, val] of Object.entries(patch)) {
      if (!ALLOWED_FIELDS.has(key)) continue;
      $set[key] = sanitize(val, key);
    }

    if (Object.keys($set).length === 0) {
      return res.status(400).json({ message: "No valid fields in patch" });
    }

    // Any profile change marks the AI summary stale.
    $set.summaryStale = true;

    // strictQuery false on upsert — only set fields present
    const updated = await ProfileModel.findOneAndUpdate(
      { email },
      { $set, $setOnInsert: { email } },
      { new: true, upsert: true, setDefaultsOnInsert: false, strict: false, runValidators: false }
    ).lean();

    triggerSummaryRebuild(email, "ext-patch");
    return res.status(200).json({ success: true, profile: updated, updated: Object.keys($set) });
  } catch (err) {
    console.error("extPatchProfile error", err);
    return res.status(500).json({ message: "Internal server error", error: err.message });
  }
}
