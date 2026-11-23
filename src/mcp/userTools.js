// What a client can do from Claude: the same things they can do on the
// FlashFire portal, and nothing an operator does.
//
// Every function takes `ctx` first. ctx comes from the client's API key
// (src/mcp/server.js) and is the ONLY source of identity: no tool accepts an
// email, and every query and write is pinned to ctx. A tool argument can name
// a jobID, but the lookup is always { jobID, userID: <this client> }, so a
// jobID belonging to someone else simply is not found.
//
// Reads query the models directly and return an allowlist of fields, so
// operator-only data (aiDecision, operatorRemoval notes, extension codes, the
// client's SSN or OpenAI key) never reaches Claude. Writes go through the
// portal's own controllers via invokeHandlers, so they obey the same rules.

import { JobModel } from "../../Schema_Models/JobModel.js";
import { UserModel } from "../../Schema_Models/UserModel.js";
import { ProfileModel } from "../../Schema_Models/ProfileModel.js";
import { checkPlanCap } from "../../Utils/dailyCapGuard.js";
import { computeJobTimes } from "../../Utils/jobActivityTime.js";
import CheckForDuplicateJobs from "../../Middlewares/CheckForDuplicateJobs.js";
import AddJob from "../../Controllers/AddJob.js";
import VerifyJobIDAndChanges from "../../Middlewares/VerifyJobIDAndChanges.js";
import UpdateChanges, { REMOVAL_LIMIT } from "../../Controllers/UpdateChanges.js";
import Add_Update_Profile from "../../Controllers/Add_Update_Profile.js";
import { invokeHandlers } from "./invokeHandlers.js";

// A tool failure Claude should show the client as-is.
export class ToolError extends Error {
  constructor(message, code = "tool_error") {
    super(message);
    this.code = code;
  }
}

// The board's columns, as the client sees them. "removed" is stored as
// "deleted" (plus " by <who>"), which is a storage detail Claude never needs.
export const JOB_STATUSES = ["saved", "applied", "interviewing", "offer", "rejected", "removed"];
export const MOVABLE_STATUSES = ["saved", "applied", "interviewing", "offer", "rejected"];

const DESCRIPTION_LIMIT = 8000;
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "applied by Ravi" -> "applied", "deleted by user" -> "removed".
export function baseStatus(raw) {
  const first = String(raw || "").trim().toLowerCase().split(/\s+/)[0] || "saved";
  if (first === "deleted" || first === "removed") return "removed";
  return first;
}

function statusQuery(status) {
  if (status === "removed") return { $regex: /^(deleted|removed)/i };
  return { $regex: new RegExp(`^${escapeRegex(status)}`, "i") };
}

// Jobs are keyed by the lowercased email on read (GetAllJobs) and by the
// stored spelling on write (UpdateChanges). Match both so a mixed-case legacy
// account still sees all of its cards.
function ownerFilter(ctx) {
  const ids = [...new Set([ctx.email, ctx.accountEmail])];
  return ids.length === 1 ? { userID: ids[0] } : { userID: { $in: ids } };
}

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

function jobRow(job) {
  const times = computeJobTimes(job);
  return {
    jobID: job.jobID,
    jobTitle: job.jobTitle,
    companyName: job.companyName,
    location: job.jobLocation || null,
    status: baseStatus(job.currentStatus),
    joblink: job.joblink || null,
    addedAt: iso(times.createdAtMs),
    appliedAt: iso(times.appliedAtMs),
    lastActivityAt: iso(times.activityAt),
    hasOptimizedResume: Boolean(job.optimizedResume?.hasResume),
  };
}

const LIST_PROJECTION =
  "jobID jobTitle companyName jobLocation currentStatus joblink dateAdded appliedDate updatedAt createdAt optimizedResume.hasResume";

// ---------------------------------------------------------------- reads

export async function getOverview(ctx) {
  const [jobs, plan, user] = await Promise.all([
    JobModel.find(ownerFilter(ctx)).select("currentStatus").lean(),
    checkPlanCap(ctx.email),
    UserModel.findOne({ email: ctx.accountEmail }).select("planType removedJobsCount extraRemovalLimit").lean(),
  ]);

  const byStatus = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0]));
  for (const job of jobs) {
    const s = baseStatus(job.currentStatus);
    byStatus[s] = (byStatus[s] || 0) + 1;
  }
  const removalLimit = REMOVAL_LIMIT + (user?.extraRemovalLimit || 0);
  const removalsUsed = user?.removedJobsCount || 0;

  return {
    name: ctx.name,
    email: ctx.accountEmail,
    planType: plan.planType || user?.planType || null,
    totalJobs: jobs.length,
    jobsByStatus: byStatus,
    planUsage: planUsageOf(plan),
    removals: { used: removalsUsed, limit: removalLimit, remaining: Math.max(0, removalLimit - removalsUsed) },
  };
}

function planUsageOf(check) {
  return {
    planType: check.planType || null,
    // null cap means the plan has no application limit.
    applicationLimit: check.cap ?? null,
    applicationsUsed: check.count ?? 0,
    applicationsRemaining: check.cap == null ? null : Math.max(0, check.cap - (check.count ?? 0)),
    referralBonus: check.referralBonus ?? 0,
    addonBonus: check.addonBonus ?? 0,
    limitReached: check.allowed === false,
  };
}

export async function getPlanUsage(ctx) {
  return planUsageOf(await checkPlanCap(ctx.email));
}

export async function listJobs(ctx, { status, search, limit = 25, offset = 0 } = {}) {
  const filter = { ...ownerFilter(ctx) };
  if (status) filter.currentStatus = statusQuery(status);
  const term = String(search || "").trim();
  if (term) {
    const re = new RegExp(escapeRegex(term.slice(0, 100)), "i");
    filter.$or = [{ jobTitle: re }, { companyName: re }];
  }

  const jobs = await JobModel.find(filter).select(LIST_PROJECTION).lean();
  // Newest activity first, the same order the portal's board uses. The date
  // strings in this collection are mixed-locale, so ordering goes through
  // computeJobTimes rather than a string sort.
  const rows = jobs.map(jobRow).sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)));
  const page = rows.slice(offset, offset + limit);
  return {
    total: rows.length,
    offset,
    returned: page.length,
    hasMore: offset + page.length < rows.length,
    jobs: page,
  };
}

export async function getJob(ctx, { jobID }) {
  const job = await JobModel.findOne({ jobID: String(jobID), ...ownerFilter(ctx) })
    .select(`${LIST_PROJECTION} jobDescription timeline attachments removalReason removalDate removedBy addedBy`)
    .lean();
  if (!job) throw new ToolError(`No job with jobID ${jobID} on your board.`, "not_found");

  const description = String(job.jobDescription || "");
  return {
    ...jobRow(job),
    timeline: Array.isArray(job.timeline) ? job.timeline : [],
    attachments: Array.isArray(job.attachments) ? job.attachments : [],
    addedBy: job.addedBy || null,
    removal:
      baseStatus(job.currentStatus) === "removed"
        ? { reason: job.removalReason || null, removedAt: job.removalDate || null, removedBy: job.removedBy || null }
        : null,
    jobDescription: description.slice(0, DESCRIPTION_LIMIT),
    jobDescriptionTruncated: description.length > DESCRIPTION_LIMIT,
  };
}

// The profile fields a client fills in on the portal. SSN, date of birth, the
// OpenAI key and the AI summary internals are left out on purpose.
const PROFILE_FIELDS = [
  "firstName",
  "lastName",
  "contactEmail",
  "contactNumber",
  "address",
  "visaStatus",
  "otherVisaType",
  "bachelorsUniDegree",
  "bachelorsGradMonthYear",
  "bachelorsGPA",
  "mastersUniDegree",
  "mastersGradMonthYear",
  "mastersGPA",
  "preferredRoles",
  "experienceLevel",
  "yearsOfExperience",
  "expectedSalaryRange",
  "currency",
  "preferredLocations",
  "targetCompanies",
  "employmentTypes",
  "availabilityNote",
  "joinTime",
  "linkedinUrl",
  "githubUrl",
  "portfolioUrl",
];

async function findProfile(ctx) {
  const hit = await ProfileModel.findOne({ email: ctx.email }).lean();
  if (hit) return hit;
  return ProfileModel.findOne({ email: { $regex: new RegExp(`^${escapeRegex(ctx.email)}$`, "i") } }).lean();
}

function pickProfile(profile) {
  const out = {};
  for (const field of PROFILE_FIELDS) {
    if (profile[field] !== undefined && profile[field] !== null && profile[field] !== "") out[field] = profile[field];
  }
  return out;
}

export async function getProfile(ctx) {
  const profile = await findProfile(ctx);
  if (!profile) throw new ToolError("You have no profile yet. Fill it in once on the FlashFire portal first.", "not_found");
  return { email: ctx.accountEmail, ...pickProfile(profile) };
}

function docRow(entry) {
  return {
    name: entry.name || entry.jobRole || null,
    url: entry.url || entry.link || entry.optimizedResumeLink || entry.coverLetterLink || null,
    companyName: entry.companyName || null,
    jobRole: entry.jobRole || null,
    jobId: entry.jobId || null,
    createdAt: entry.createdAt || null,
  };
}

export async function listDocuments(ctx) {
  const user = await UserModel.findOne({ email: ctx.accountEmail })
    .select("resumeLink optimizedResumes coverLetters transcript")
    .lean();
  if (!user) throw new ToolError("Account not found.", "not_found");
  const rows = (list) => (Array.isArray(list) ? list.map(docRow).filter((d) => d.url) : []);
  return {
    baseResumes: rows(user.resumeLink),
    optimizedResumes: rows(user.optimizedResumes),
    coverLetters: rows(user.coverLetters),
    transcripts: rows(user.transcript),
  };
}

// ---------------------------------------------------------------- writes

// Turn a controller's HTTP answer into a ToolError with its own message.
function assertOk(result, fallback) {
  if (result.status >= 200 && result.status < 300) return result.body;
  const body = result.body || {};
  const message = body.message || (typeof body.error === "string" ? body.error : fallback);
  const code = (typeof body.error === "string" && body.error) || body.reason || `http_${result.status}`;
  throw new ToolError(message, code);
}

const userDetailsOf = (ctx) => ({ email: ctx.accountEmail, name: ctx.name });

export async function addJob(ctx, { jobTitle, companyName, joblink, jobDescription, jobLocation, status = "saved" }) {
  const jobID = String(Date.now());
  // Only the fields the portal's Add Jobs form sends. AddJob creates the
  // document from jobDetails as given, so nothing else may ride along.
  const jobDetails = {
    jobID,
    jobTitle,
    companyName,
    joblink: joblink || "",
    jobDescription: jobDescription || "",
    jobLocation: jobLocation || "",
    currentStatus: status,
    dateAdded: new Date().toLocaleString("en-US"),
    userID: ctx.accountEmail,
  };
  const result = await invokeHandlers([CheckForDuplicateJobs, AddJob], {
    body: { jobDetails, userDetails: userDetailsOf(ctx) },
  });
  assertOk(result, "Could not add the job.");
  return { added: true, jobID, jobTitle: jobDetails.jobTitle, companyName, status };
}

async function updateStatus(ctx, jobID, status, removalReason) {
  const result = await invokeHandlers([VerifyJobIDAndChanges, UpdateChanges], {
    body: {
      action: "UpdateStatus",
      jobID: String(jobID),
      status,
      removalReason,
      userDetails: userDetailsOf(ctx),
      returnUpdatedJobs: false,
    },
  });
  // VerifyJobIDAndChanges answers 403 for an unknown jobID; say it plainly.
  if (result.status === 403 && /doesnot exist/i.test(result.body?.message || "")) {
    throw new ToolError(`No job with jobID ${jobID} on your board.`, "not_found");
  }
  if (result.body?.message === "Removal limit exceeded") {
    throw new ToolError(result.body.error || "You have used all your job removals.", "removal_limit");
  }
  assertOk(result, "Could not update the job.");
}

export async function updateJobStatus(ctx, { jobID, status }) {
  await getJob(ctx, { jobID }); // a clear not-found before touching anything
  await updateStatus(ctx, jobID, status);
  return { updated: true, jobID: String(jobID), status };
}

export async function removeJob(ctx, { jobID, reason }) {
  const job = await getJob(ctx, { jobID });
  if (job.status === "removed") throw new ToolError("That job is already removed.", "already_removed");
  await updateStatus(ctx, jobID, "deleted", reason);
  return { removed: true, jobID: String(jobID), reason };
}

// The profile fields a client may change from Claude. Identity, education
// history, SSN and the dashboard-manager fields stay portal-only.
export const EDITABLE_PROFILE_FIELDS = [
  "preferredRoles",
  "preferredLocations",
  "targetCompanies",
  "employmentTypes",
  "experienceLevel",
  "yearsOfExperience",
  "expectedSalaryRange",
  "availabilityNote",
  "contactNumber",
  "linkedinUrl",
  "githubUrl",
  "portfolioUrl",
];

export async function updateProfile(ctx, changes) {
  const fields = {};
  for (const key of EDITABLE_PROFILE_FIELDS) {
    if (changes[key] !== undefined) fields[key] = changes[key];
  }
  if (!Object.keys(fields).length) throw new ToolError("Nothing to change: pass at least one field.", "bad_input");

  const profile = await findProfile(ctx);
  if (!profile) throw new ToolError("You have no profile yet. Fill it in once on the FlashFire portal first.", "not_found");

  // Add_Update_Profile keys the profile on userDetails.email and overwrites
  // contactEmail with body.email, so both are set to what is stored today.
  const result = await invokeHandlers([Add_Update_Profile], {
    body: {
      ...fields,
      email: profile.contactEmail || profile.email,
      userDetails: { email: profile.email },
    },
  });
  assertOk(result, "Could not update your profile.");
  return { updated: true, changed: Object.keys(fields) };
}
