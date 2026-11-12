// Background cover letter writer: the DB and R2 side of the cover letter queue.
// Rules and query shapes live in Utils/coverLetterQueue.js; the prompt lives in
// Utils/speedyApplyCoverLetterWriter.js (buildTailorMessages).
//
// Called from src/services/autoOptimizationWorker.js, which runs on PM2
// instance 0 only. A failure here only ever writes coverLetterOptimization and
// optimizedCoverLetter; the card's autoOptimization and optimizedResume are
// never touched.

import { JobModel } from "../Schema_Models/JobModel.js";
import { UserModel } from "../Schema_Models/UserModel.js";
import { ProfileModel } from "../Schema_Models/ProfileModel.js";
import { SpeedyApplyProfile } from "../Schema_Models/SpeedyApplyProfile.js";
import { AI_USAGE_SOURCES } from "./aiUsage.js";
import { putJSONToR2 } from "./r2Storage.js";
import { loadOptimizedResumeData } from "./optimizedResumeData.js";
import { buildContact, buildCoverLetterCandidate, buildTailorMessages } from "./speedyApplyCoverLetterWriter.js";
import { coverLetterOpenAiKey, writeCoverLetterParagraphs } from "./coverLetterOpenAi.js";
import { jobLetterKey, loadBaseLetterText, queueEligible } from "./baseCoverLetter.js";
import {
  CLAIM_SORT,
  REQUEUE_CAP,
  claimFilter,
  claimUpdate,
  completedLetterSet,
  completedStatusSet,
  enqueueUpdate,
  failureUpdate,
  requeueFilter,
  skippedUpdate,
  staleFilter,
  staleRecoveryUpdate,
} from "./coverLetterQueue.js";

const TAG = "[CoverLetterQueue]";
const CLIENT_FIELDS = "name email planType baseCoverLetter";
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The account for an email, exact first, then case-insensitive. */
export async function findClientByEmail(email, fields = CLIENT_FIELDS) {
  const e = String(email || "").trim();
  if (!e) return null;
  return (
    (await UserModel.findOne({ email: e }).select(fields).lean()) ||
    (await UserModel.findOne({ email: { $regex: new RegExp(`^${escapeRegex(e)}$`, "i") } }).select(fields).lean())
  );
}

/**
 * (a) and (c): queue one card's cover letter after its optimized resume was
 * saved, when the client is Executive and has a base letter. Never throws, so
 * the resume save that called it can never fail because of it.
 * Resolves to true when the card was queued.
 */
export async function enqueueCoverLetterIfEligible(job, { reason = "resume saved" } = {}) {
  try {
    if (!job?._id || !job.userID) return false;
    const user = await findClientByEmail(job.userID, "planType baseCoverLetter");
    if (!queueEligible(user)) return false;
    await JobModel.updateOne({ _id: job._id }, enqueueUpdate());
    console.log(`${TAG} [${job.userID}] [${job._id}] queued (${reason})`);
    return true;
  } catch (err) {
    console.error(`${TAG} enqueue failed for job ${job?._id} (resume unaffected):`, err?.message || err);
    return false;
  }
}

/**
 * (b): after a base letter save, queue this client's saved cards with an
 * optimized resume whose letter came from another base. Newest 500.
 * Resolves to the number of cards queued.
 */
export async function requeueClientCards(emails, hash) {
  const rows = await JobModel.find(requeueFilter(emails, hash)).select("_id").sort({ _id: -1 }).limit(REQUEUE_CAP).lean();
  if (!rows.length) return 0;
  const ids = rows.map((r) => r._id);
  const result = await JobModel.updateMany({ _id: { $in: ids } }, enqueueUpdate());
  return Number(result?.matchedCount ?? ids.length);
}

export async function claimNextCoverLetterJob(now = new Date()) {
  return JobModel.findOneAndUpdate(claimFilter(now), claimUpdate(now), { new: true, sort: CLAIM_SORT }).lean();
}

export async function recoverStaleCoverLetterJobs(now = new Date()) {
  const result = await JobModel.updateMany(staleFilter(now), staleRecoveryUpdate());
  if (result?.modifiedCount > 0) console.log(`${TAG} Recovered ${result.modifiedCount} stale cover letter job(s)`);
}

export async function markCoverLetterFailed(jobId, message, attempts) {
  await JobModel.updateOne({ _id: jobId }, failureUpdate(message, attempts));
}

async function markCoverLetterSkipped(jobId, reason) {
  await JobModel.updateOne({ _id: jobId }, skippedUpdate(reason));
}

async function loadResume(job, tag) {
  try {
    const loaded = await loadOptimizedResumeData(job.optimizedResume);
    if (loaded.ok) return loaded.data;
    console.warn(`${tag} optimized resume ${loaded.reason}, using the base profile`);
  } catch (err) {
    console.warn(`${tag} optimized resume load failed, using the base profile:`, err?.message || err);
  }
  return null;
}

/**
 * Write and store one card's cover letter. Throws on a retryable failure
 * (the worker then calls markCoverLetterFailed). Resolves to
 * { status: "completed", key } or { status: "skipped", reason }.
 */
export async function processCoverLetterJob(job) {
  const tag = `${TAG} [${job.userID}] [${job._id}]`;
  const user = await findClientByEmail(job.userID);
  if (!queueEligible(user)) {
    const reason = user ? (user.baseCoverLetter?.key ? "Client is not on the Executive plan" : "Client has no base cover letter") : "Client account not found";
    await markCoverLetterSkipped(job._id, reason);
    console.log(`${tag} Skipped: ${reason}`);
    return { status: "skipped", reason };
  }
  if (!String(job.jobDescription || "").trim() && !String(job.jobTitle || "").trim()) {
    const reason = "Job card has no title and no job description";
    await markCoverLetterSkipped(job._id, reason);
    return { status: "skipped", reason };
  }

  const base = await loadBaseLetterText(user.baseCoverLetter);
  if (!base.ok) {
    if (base.reason === "missing") {
      await markCoverLetterSkipped(job._id, "Base cover letter is empty in storage");
      return { status: "skipped", reason: "Base cover letter is empty in storage" };
    }
    throw new Error("Could not read the base cover letter from R2");
  }

  const apiKey = coverLetterOpenAiKey();
  if (!apiKey) throw new Error("auto_fill_chatgpt_API is not set");

  const email = String(user.email || job.userID).trim();
  const emails = [...new Set([email, email.toLowerCase(), String(job.userID)])];
  const [sa, dash, resumeData] = await Promise.all([
    SpeedyApplyProfile.findOne({ clientEmail: { $in: emails.map((e) => e.toLowerCase()) } }).select("profile").lean(),
    ProfileModel.findOne({ email: { $in: emails } })
      .select("firstName lastName email contactEmail contactNumber address yearsOfExperience preferredRoles bachelorsUniDegree mastersUniDegree aiSummary")
      .lean(),
    loadResume(job, tag),
  ]);
  const saProfile = sa?.profile && typeof sa.profile === "object" ? sa.profile : null;
  const contact = buildContact({ saProfile, dash, user });
  const candidate = buildCoverLetterCandidate({ optimizedResumeData: resumeData, saProfile, dash });
  const jobInfo = {
    title: String(job.jobTitle || "").slice(0, 200),
    company: String(job.companyName || "").slice(0, 200),
    description: String(job.jobDescription || ""),
  };

  const written = await writeCoverLetterParagraphs({
    apiKey,
    name: contact.name,
    source: AI_USAGE_SOURCES.SPEEDYAPPLY_COVER_LETTER_AUTO,
    logTag: tag,
    buildMessages: (retryReason) => buildTailorMessages({ job: jobInfo, candidate, baseLetter: base.text, retryReason }),
  });
  if (!written.ok) throw new Error(`The AI did not return a usable letter: ${written.reason}`);

  const now = new Date();
  const baseHash = user.baseCoverLetter.hash || "";
  const key = jobLetterKey(job.userID, job._id);
  const stored = await putJSONToR2(
    key,
    {
      paragraphs: written.paragraphs,
      jobTitle: jobInfo.title,
      companyName: jobInfo.company,
      model: written.model,
      baseHash,
      createdAt: now.toISOString(),
    },
    { clientName: job.userID, jobID: String(job._id) },
  );
  if (!stored?.success) throw new Error(`R2 upload failed: ${stored?.error || "unknown"}`);

  const letterSet = completedLetterSet({
    dataKey: key,
    previousVersion: job.optimizedCoverLetter?.version,
    baseHash,
    model: written.model,
    now,
  });
  // Completed only if nobody requeued the card meanwhile (a base letter save
  // during this run resets it to pending so it is written again from the new base).
  const done = await JobModel.findOneAndUpdate(
    { _id: job._id, "coverLetterOptimization.status": "processing" },
    { $set: { ...letterSet, ...completedStatusSet(now) } },
    { new: false },
  )
    .select("_id")
    .lean();
  if (!done) await JobModel.updateOne({ _id: job._id }, { $set: letterSet });

  console.log(`${tag} Cover letter saved (${written.words} words). R2 key: ${key}`);
  return { status: "completed", key };
}
