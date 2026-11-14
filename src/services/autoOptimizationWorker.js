import axios from 'axios';
import { JobModel } from '../../Schema_Models/JobModel.js';
import { uploadJSONToR2 } from '../../Utils/r2Storage.js';
import { sanitizeSectionTitles } from '../../Utils/sectionTitles.js';
import { DiscordConnect } from '../../Utils/DiscordConnect.js';
import { buildResumeOptimizationInstructionPrompt } from '../../Utils/resumeOptimizationPrompt.js';
import { claimNextWork } from '../../Utils/coverLetterQueue.js';
import {
  claimNextCoverLetterJob,
  enqueueCoverLetterIfEligible,
  markCoverLetterFailed,
  processCoverLetterJob,
  recoverStaleCoverLetterJobs
} from '../../Utils/coverLetterAutoWriter.js';

// ─── Configuration ───────────────────────────────────────────────────
const RESUME_API_URL = process.env.RESUME_API_URL || 'http://localhost:5000';
const POLL_INTERVAL_MS = parseInt(process.env.AUTO_OPT_POLL_INTERVAL_MS) || 10000;
const DELAY_BETWEEN_JOBS_MS = parseInt(process.env.AUTO_OPT_DELAY_BETWEEN_JOBS_MS) || 5000;
const MAX_ATTEMPTS = parseInt(process.env.AUTO_OPT_MAX_ATTEMPTS) || 3;
const REQUEST_TIMEOUT_MS = parseInt(process.env.AUTO_OPT_REQUEST_TIMEOUT_MS) || 120000;
const WORKER_ENABLED = process.env.AUTO_OPT_ENABLED !== 'false';
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const DISCORD_ERROR_URL = process.env.DISCORD_OPTIMIZATION_ERROR_URL;
// Cover letter jobs are one gpt-4o-mini call each, so a shorter gap is enough.
const COVER_LETTER_DELAY_MS = parseInt(process.env.AUTO_OPT_CL_DELAY_MS) || 2000;

let isProcessing = false;
let workerRunning = false;
let pollTimer = null;

function hasStableId(entry) {
  return entry && entry.id !== undefined && entry.id !== null && entry.id !== '';
}

/** Pair workExperience or skills rows: match by id first, then zip remaining in order. */
function pairRowsByIdThenIndex(origArr, optArr) {
  const orig = Array.isArray(origArr) ? origArr : [];
  const opt = Array.isArray(optArr) ? optArr : [];
  const pairedOrigIdx = new Set();
  const pairedOptIdx = new Set();
  const pairs = [];

  orig.forEach((o, oi) => {
    if (!hasStableId(o)) return;
    const idStr = String(o.id);
    const j = opt.findIndex(
      (p, idx) => !pairedOptIdx.has(idx) && hasStableId(p) && String(p.id) === idStr
    );
    if (j >= 0) {
      pairs.push({ orig: o, opt: opt[j] });
      pairedOrigIdx.add(oi);
      pairedOptIdx.add(j);
    }
  });

  const unpairedOrig = orig.filter((_, i) => !pairedOrigIdx.has(i));
  const unpairedOpt = opt.filter((_, i) => !pairedOptIdx.has(i));
  const len = Math.max(unpairedOrig.length, unpairedOpt.length);
  for (let k = 0; k < len; k++) {
    pairs.push({ orig: unpairedOrig[k], opt: unpairedOpt[k] });
  }

  return pairs;
}

function diffWorkExperienceEntry(orig, opt) {
  const originals = {};
  const changes = {};
  let hasChanges = false;
  if (!orig || !opt) {
    return { hasChanges: false, originals, changes, id: orig?.id ?? opt?.id };
  }
  ['position', 'company', 'duration', 'location', 'roleType'].forEach((field) => {
    if (orig[field] !== opt[field]) {
      originals[field] = orig[field];
      changes[field] = opt[field];
      hasChanges = true;
    }
  });
  if (JSON.stringify(orig.responsibilities) !== JSON.stringify(opt.responsibilities)) {
    originals.responsibilities = [...(orig.responsibilities || [])];
    changes.responsibilities = [...(opt.responsibilities || [])];
    hasChanges = true;
  }
  return { hasChanges, originals, changes, id: orig.id };
}

function deepCloneDiff(val) {
  if (val === undefined) return val;
  try {
    return JSON.parse(JSON.stringify(val));
  } catch {
    return val;
  }
}

/** Sections compared as full before/after (same idea as Optimizer granular diff, but always merged). */
const EXTRA_CHANGE_SECTION_KEYS = ['projects', 'leadership', 'education', 'publications'];

/**
 * Build changesMade aligned with JobModal getChangedFieldsOnly() (same shapes for UI).
 * @param {object} baselineForDiff — Same fields as sent to optimize API (e.g. summary from filtered resume).
 * @param {object} optimizedData — Parsed optimize-with-gemini response.
 */
function buildOptimizationChangesMade(baselineForDiff, optimizedData) {
  const startingContent = {};
  const finalChanges = {};

  if (!baselineForDiff || !optimizedData) {
    return {
      startingContent: { summary: baselineForDiff?.summary ?? '' },
      finalChanges: { summary: optimizedData?.summary ?? '' },
      timestamp: new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
      changedSections: ['summary'],
      source: 'auto-optimization'
    };
  }

  const origPI = baselineForDiff.personalInfo || {};
  const optPI = optimizedData.personalInfo || {};
  const personalInfoChanged = Object.keys(origPI).filter((key) => origPI[key] !== optPI[key]);
  if (personalInfoChanged.length > 0) {
    startingContent.personalInfo = {};
    finalChanges.personalInfo = {};
    personalInfoChanged.forEach((key) => {
      startingContent.personalInfo[key] = origPI[key];
      finalChanges.personalInfo[key] = optPI[key];
    });
  }

  if ((baselineForDiff.summary || '') !== (optimizedData.summary || '')) {
    startingContent.summary = baselineForDiff.summary || '';
    finalChanges.summary = optimizedData.summary || '';
  }

  const changedWorkExp = [];
  for (const { orig, opt } of pairRowsByIdThenIndex(
    baselineForDiff.workExperience,
    optimizedData.workExperience
  )) {
    const { hasChanges, originals, changes, id } = diffWorkExperienceEntry(orig, opt);
    if (hasChanges && orig && opt) {
      changedWorkExp.push({ id, original: originals, optimized: changes });
    } else if (orig && !opt) {
      changedWorkExp.push({
        id: orig.id,
        original: {
          ...['position', 'company', 'duration', 'location', 'roleType'].reduce((acc, f) => {
            acc[f] = orig[f];
            return acc;
          }, {}),
          responsibilities: [...(orig.responsibilities || [])]
        },
        optimized: {}
      });
    } else if (!orig && opt) {
      changedWorkExp.push({
        id: opt.id,
        original: {},
        optimized: {
          ...['position', 'company', 'duration', 'location', 'roleType'].reduce((acc, f) => {
            acc[f] = opt[f];
            return acc;
          }, {}),
          responsibilities: [...(opt.responsibilities || [])]
        }
      });
    }
  }

  if (changedWorkExp.length > 0) {
    startingContent.workExperience = changedWorkExp.map((item) => ({
      id: item.id,
      ...item.original
    }));
    finalChanges.workExperience = changedWorkExp.map((item) => ({
      id: item.id,
      ...item.optimized
    }));
  }

  const changedSkills = [];
  for (const { orig, opt } of pairRowsByIdThenIndex(baselineForDiff.skills, optimizedData.skills)) {
    if (orig && opt && (orig.category !== opt.category || orig.skills !== opt.skills)) {
      changedSkills.push({
        id: orig.id,
        original: { category: orig.category, skills: orig.skills },
        optimized: { category: opt.category, skills: opt.skills }
      });
    } else if (orig && !opt) {
      changedSkills.push({
        id: orig.id,
        original: { category: orig.category, skills: orig.skills },
        optimized: { category: '', skills: '' }
      });
    } else if (!orig && opt) {
      changedSkills.push({
        id: opt.id,
        original: { category: '', skills: '' },
        optimized: { category: opt.category, skills: opt.skills }
      });
    }
  }

  if (changedSkills.length > 0) {
    startingContent.skills = changedSkills.map((item) => ({
      id: item.id,
      ...item.original
    }));
    finalChanges.skills = changedSkills.map((item) => ({
      id: item.id,
      ...item.optimized
    }));
  }

  // Always surface projects / leadership / education / publications when JSON differs
  // (granular pass above only covers summary, WE, skills, PI — not these sections).
  for (const key of EXTRA_CHANGE_SECTION_KEYS) {
    const a = baselineForDiff[key];
    const b = optimizedData[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      startingContent[key] = deepCloneDiff(a);
      finalChanges[key] = deepCloneDiff(b);
    }
  }

  // Safety net: if row-level diff missed WE/skills/summary, store full section (reorder, edge cases).
  if (
    !startingContent.workExperience &&
    JSON.stringify(baselineForDiff.workExperience) !== JSON.stringify(optimizedData.workExperience)
  ) {
    startingContent.workExperience = deepCloneDiff(baselineForDiff.workExperience);
    finalChanges.workExperience = deepCloneDiff(optimizedData.workExperience);
  }
  if (
    !startingContent.skills &&
    JSON.stringify(baselineForDiff.skills) !== JSON.stringify(optimizedData.skills)
  ) {
    startingContent.skills = deepCloneDiff(baselineForDiff.skills);
    finalChanges.skills = deepCloneDiff(optimizedData.skills);
  }
  if (
    !startingContent.summary &&
    JSON.stringify(baselineForDiff.summary ?? '') !== JSON.stringify(optimizedData.summary ?? '')
  ) {
    startingContent.summary = baselineForDiff.summary ?? '';
    finalChanges.summary = optimizedData.summary ?? '';
  }

  // Last resort: nothing detected at all — compare core keys as full snapshots.
  if (Object.keys(startingContent).length === 0) {
    const structuralKeys = ['personalInfo', 'summary', 'workExperience', 'skills'];
    for (const key of structuralKeys) {
      const a = baselineForDiff[key];
      const b = optimizedData[key];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        startingContent[key] = deepCloneDiff(a);
        finalChanges[key] = deepCloneDiff(b);
      }
    }
  }

  const changedSections = Object.keys(startingContent);

  return {
    startingContent,
    finalChanges,
    timestamp: new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
    changedSections,
    source: 'auto-optimization'
  };
}

// ─── Discord Error Notification ─────────────────────────────────────
async function sendOptimizationError({ job, stage, error, attempts, isPermanent }) {
  if (!DISCORD_ERROR_URL) return;
  try {
    const status = isPermanent ? '🔴 PERMANENTLY FAILED' : `🟡 RETRY (attempt ${attempts}/${MAX_ATTEMPTS})`;
    const geminiInfo = error?.response?.data
      ? `\nGemini Response: ${JSON.stringify(error.response.data).slice(0, 300)}`
      : '';
    const statusCode = error?.response?.status ? `\nHTTP Status: ${error.response.status}` : '';

    const message =
      `\n━━━ Optimization Error ━━━` +
      `\n${status}` +
      `\n\n📋 Job Card Details:` +
      `\n• Job ID: ${job._id}` +
      `\n• Job Title: ${job.jobTitle || 'N/A'}` +
      `\n• Company: ${job.companyName || 'N/A'}` +
      `\n• Client (userID): ${job.userID || 'N/A'}` +
      `\n• Job ID (external): ${job.jobID || 'N/A'}` +
      `\n\n⚠️ Error Details:` +
      `\n• Stage: ${stage}` +
      `\n• Error: ${(error?.message || String(error)).slice(0, 400)}` +
      statusCode +
      geminiInfo +
      `\n\n🕐 Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` +
      `\n━━━━━━━━━━━━━━━━━━━━━━━━`;

    await Promise.race([
      DiscordConnect(DISCORD_ERROR_URL, message),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Discord timeout')), 3000))
    ]);
  } catch (discordErr) {
    console.error('[AutoOptWorker] Failed to send Discord error notification:', discordErr.message);
  }
}

// ─── Stale Job Recovery ──────────────────────────────────────────────
async function recoverStaleJobs() {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const result = await JobModel.updateMany(
    {
      'autoOptimization.status': 'processing',
      'autoOptimization.startedAt': { $lt: cutoff }
    },
    {
      $set: {
        'autoOptimization.status': 'pending',
        'autoOptimization.error': 'Recovered from stale processing state (worker restart)'
      }
    }
  );
  if (result.modifiedCount > 0) {
    console.log(`[AutoOptWorker] Recovered ${result.modifiedCount} stale processing job(s)`);
  }
  try {
    await recoverStaleCoverLetterJobs();
  } catch (err) {
    console.error('[AutoOptWorker] Cover letter stale recovery failed:', err?.message || err);
  }
}

// ─── Claim Next Pending Job (Atomic) ─────────────────────────────────
async function claimNextJob() {
  return JobModel.findOneAndUpdate(
    {
      'autoOptimization.status': 'pending',
      'autoOptimization.attempts': { $lt: MAX_ATTEMPTS },
      jobDescription: { $exists: true, $nin: [null, ''] },
      'optimizedResume.hasResume': { $ne: true },
      $or: [
        { 'autoOptimization.retryAfter': { $exists: false } },
        { 'autoOptimization.retryAfter': null },
        { 'autoOptimization.retryAfter': { $lte: new Date() } }
      ]
    },
    {
      $set: {
        'autoOptimization.status': 'processing',
        'autoOptimization.startedAt': new Date()
      },
      $inc: { 'autoOptimization.attempts': 1 }
    },
    { new: true, sort: { _id: 1 } }
  ).lean();
}

// ─── Mark Job as Failed (with backoff) ───────────────────────────────
async function markFailed(jobId, errorMessage, attempts) {
  const backoffMinutes = Math.pow(2, attempts - 1); // 1, 2, 4 min
  const update = {
    'autoOptimization.error': errorMessage.slice(0, 500),
    'autoOptimization.lastFailedAt': new Date()
  };

  if (attempts >= MAX_ATTEMPTS) {
    update['autoOptimization.status'] = 'failed';
    console.error(`[AutoOptWorker] Job ${jobId} permanently failed after ${attempts} attempts: ${errorMessage}`);
  } else {
    update['autoOptimization.status'] = 'pending';
    update['autoOptimization.retryAfter'] = new Date(Date.now() + backoffMinutes * 60 * 1000);
    console.log(`[AutoOptWorker] Job ${jobId} will retry after ${backoffMinutes} min (attempt ${attempts}/${MAX_ATTEMPTS})`);
  }

  await JobModel.findByIdAndUpdate(jobId, { $set: update });
}

// ─── Mark Job as Skipped (permanent, no retry) ──────────────────────
async function markSkipped(jobId, reason) {
  await JobModel.findByIdAndUpdate(jobId, {
    $set: {
      'autoOptimization.status': 'skipped',
      'autoOptimization.error': reason,
      'autoOptimization.completedAt': new Date()
    }
  });
}

// ─── Process a Single Job ────────────────────────────────────────────
async function processJob(job) {
  const tag = `[AutoOptWorker] [${job.userID}] [${job._id}]`;
  console.log(
    `${tag} Starting optimization for "${job.jobTitle}" at ${job.companyName} (addedBy: ${job.addedBy || '—'})`
  );
  const startMs = Date.now();

  // Step 1: Fetch user's resume from gemini microservice
  let resumeData;
  try {
    const res = await axios.post(
      `${RESUME_API_URL}/api/resume-by-email`,
      { email: job.userID },
      { timeout: REQUEST_TIMEOUT_MS }
    );
    resumeData = res.data;
  } catch (err) {
    if (err.response?.status === 404) {
      await markSkipped(job._id, 'No resume assigned to user');
      console.log(`${tag} Skipped: no resume assigned`);
      return;
    }
    err._stage = 'Resume Fetch (Gemini microservice)';
    throw err;
  }

  if (!resumeData || !resumeData.personalInfo) {
    await markSkipped(job._id, 'Invalid resume data (missing personalInfo)');
    console.log(`${tag} Skipped: invalid resume data`);
    return;
  }

  // Strip microservice envelope fields — do not send to Gemini inside resume_json
  const {
    resumeId: mongoResumeIndexId,
    firstName,
    lastName,
    ...resumePayload
  } = resumeData;

  // Step 2: Prepare filtered resume (mirrors frontend logic from JobModal.tsx)
  const checkboxStates = resumePayload.checkboxStates || {};

  // Warn when checkboxStates is missing — this means user section preferences
  // (showProjects, showLeadership, etc.) will fall back to defaults instead of
  // the user's actual choices. This usually means the Gemini microservice isn't
  // returning checkboxStates for this user's resume.
  if (!resumeData.checkboxStates) {
    console.warn(
      `${tag} checkboxStates missing from resume — using defaults (showSummary=true, showProjects=false, showLeadership=false). ` +
      `User's section preferences will NOT be applied for this optimization.`
    );
  }

  const filteredResume = {
    ...resumePayload,
    summary: checkboxStates.showSummary !== false ? resumePayload.summary : '',
    projects: checkboxStates.showProjects ? resumePayload.projects : [],
    leadership: checkboxStates.showLeadership ? resumePayload.leadership : [],
    publications: resumePayload.publications || []
  };

  // Step 3: Call optimize-with-gemini (resume_id triggers Discord/token tracking when configured)
  const optimizeBody = {
    resume_data: filteredResume,
    job_description:
      buildResumeOptimizationInstructionPrompt(job.jobDescription) + job.jobDescription
  };
  if (mongoResumeIndexId) {
    optimizeBody.resume_id = String(mongoResumeIndexId).trim();
  }

  try {
    var optimizeRes = await axios.post(
      `${RESUME_API_URL}/api/optimize-with-gemini`,
      optimizeBody,
      { timeout: REQUEST_TIMEOUT_MS }
    );
  } catch (err) {
    err._stage = 'Gemini Optimization API';
    throw err;
  }

  const optimizedData = optimizeRes.data;
  if (!optimizedData || (!optimizedData.summary && !optimizedData.workExperience)) {
    const err = new Error('Optimization returned empty/invalid data');
    err._stage = 'Gemini Optimization Response Validation';
    throw err;
  }

  // Guard: if Gemini dropped work experience entries, restore the missing originals.
  // The prompt instructs Gemini to keep all entries but it sometimes ignores this.
  // We never save a result with fewer work experiences than the original.
  const origWorkExp = Array.isArray(filteredResume.workExperience) ? filteredResume.workExperience : [];
  const optWorkExp = Array.isArray(optimizedData.workExperience) ? optimizedData.workExperience : [];
  if (origWorkExp.length > 0 && optWorkExp.length < origWorkExp.length) {
    // Build a lookup of IDs that survived in the optimized output
    const survivedIds = new Set(
      optWorkExp.filter(e => e && e.id != null).map(e => String(e.id))
    );
    // Collect original entries that are completely absent from the optimized result
    const droppedEntries = origWorkExp.filter(e => {
      if (e && e.id != null) return !survivedIds.has(String(e.id));
      // No id: compare by index — entries beyond the optimized array length are dropped
      return optWorkExp.indexOf(e) === -1;
    });
    if (droppedEntries.length > 0) {
      console.warn(
        `${tag} Gemini dropped ${droppedEntries.length} work experience ` +
        `entr${droppedEntries.length === 1 ? 'y' : 'ies'} ` +
        `(original: ${origWorkExp.length}, returned: ${optWorkExp.length}). ` +
        `Restoring originals: ${droppedEntries.map(e => e.position || e.company || e.id).join(', ')}`
      );
      // Append dropped originals at the end so nothing is lost
      optimizedData.workExperience = [...optWorkExp, ...droppedEntries];
    }
  }

  // Step 4: Upload optimized resume to R2
  const r2Result = await uploadJSONToR2(optimizedData, {
    clientName: job.userID,
    jobID: job.jobID || job._id.toString(),
    folder: 'flashfirejobs'
  });

  if (!r2Result.success) {
    const err = new Error(`R2 upload failed: ${r2Result.error || 'unknown'}`);
    err._stage = 'R2 Storage Upload';
    throw err;
  }

  // Step 5: Update job in MongoDB with optimized resume + metadata
  const sectionOrder = resumePayload.sectionOrder || [
    'personalInfo', 'summary', 'workExperience', 'projects',
    'leadership', 'skills', 'education', 'publications', 'therapeuticAreas'
  ];

  // Baseline must match the exact JSON sent to optimize-with-gemini
  const baselineForDiff = { ...filteredResume };
  const changesMade = buildOptimizationChangesMade(baselineForDiff, optimizedData);

  await JobModel.findByIdAndUpdate(job._id, {
    $set: {
      changesMade,
      optimizedResume: {
        resumeDataKey: r2Result.key,
        hasResume: true,
        showSummary: checkboxStates.showSummary !== false,
        showProjects: checkboxStates.showProjects || false,
        showLeadership: checkboxStates.showLeadership || false,
        showPublications: checkboxStates.showPublications || false,
        showTherapeuticAreas: checkboxStates.showTherapeuticAreas || false,
        version: (job.optimizedResume?.version || 0) + 1,
        createdAt: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        sectionOrder,
        // The client's renamed headings, from their base resume.
        sectionTitles: sanitizeSectionTitles(resumePayload.sectionTitles),
        storageType: 'r2'
      },
      optimizedResumeSeen: false,
      'autoOptimization.status': 'completed',
      'autoOptimization.completedAt': new Date(),
      'autoOptimization.error': null,
      updatedAt: new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
    }
  });

  const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`${tag} Completed in ${durationSec}s. R2 key: ${r2Result.key}`);

  // Executive clients with a base letter get this card's cover letter queued.
  // Never throws: the resume above is saved whatever happens here.
  await enqueueCoverLetterIfEligible(job, { reason: 'auto-optimized resume saved' });
}

// ─── Process a Single Cover Letter Job ──────────────────────────────
// Errors only ever write coverLetterOptimization, never autoOptimization.
async function runCoverLetterJob(job) {
  try {
    await processCoverLetterJob(job);
  } catch (err) {
    const attempts = job.coverLetterOptimization?.attempts || 1;
    console.error(
      `[AutoOptWorker] [${job.userID}] [${job._id}] Cover letter attempt ${attempts} failed: ${err?.message || err}`
    );
    try {
      await markCoverLetterFailed(job._id, err?.message || String(err), attempts);
    } catch (markErr) {
      console.error(`[AutoOptWorker] Could not record the cover letter failure for ${job._id}:`, markErr?.message || markErr);
    }
  }
}

// ─── Polling Loop ────────────────────────────────────────────────────
async function pollLoop() {
  if (!workerRunning) return;

  try {
    // Resume jobs first; a cover letter job only when no resume job is claimable.
    const work = await claimNextWork({
      claimResume: claimNextJob,
      claimCoverLetter: claimNextCoverLetterJob
    });
    if (work?.kind === 'cover-letter') {
      isProcessing = true;
      await runCoverLetterJob(work.job);
      isProcessing = false;
      pollTimer = setTimeout(pollLoop, COVER_LETTER_DELAY_MS);
      return;
    }
    const job = work?.job || null;
    if (job) {
      isProcessing = true;
      try {
        await processJob(job);
      } catch (err) {
        const attempts = job.autoOptimization?.attempts || 1;
        const isPermanent = attempts >= MAX_ATTEMPTS;
        await markFailed(job._id, err.message, attempts);
        await sendOptimizationError({
          job,
          stage: err._stage || 'Unknown Stage',
          error: err,
          attempts,
          isPermanent
        });
      }
      isProcessing = false;
      // Short delay between consecutive jobs to avoid overloading Gemini
      pollTimer = setTimeout(pollLoop, DELAY_BETWEEN_JOBS_MS);
    } else {
      // No pending jobs — wait before checking again
      pollTimer = setTimeout(pollLoop, POLL_INTERVAL_MS);
    }
  } catch (err) {
    console.error('[AutoOptWorker] Poll loop error:', err.message);
    isProcessing = false;
    pollTimer = setTimeout(pollLoop, POLL_INTERVAL_MS);
  }
}

// ─── Public API ──────────────────────────────────────────────────────
export function startAutoOptimizationWorker() {
  if (!WORKER_ENABLED) {
    console.log('[AutoOptWorker] Disabled (AUTO_OPT_ENABLED=false)');
    return;
  }
  if (workerRunning) {
    console.log('[AutoOptWorker] Already running');
    return;
  }

  workerRunning = true;

  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();
  if (nodeEnv === 'production' && /localhost|127\.0\.0\.1/i.test(RESUME_API_URL)) {
    console.warn(
      '[AutoOptWorker] RESUME_API_URL points to localhost/127.0.0.1 while NODE_ENV=production. ' +
        'Deployed dashboard hosts cannot reach your laptop — auto-optimization will stay "queued". ' +
        'Set RESUME_API_URL to your public Gemini resume API base URL.'
    );
  }

  console.log('[AutoOptWorker] Starting auto-optimization worker');
  console.log(`[AutoOptWorker] Config: poll=${POLL_INTERVAL_MS}ms, delay=${DELAY_BETWEEN_JOBS_MS}ms, maxAttempts=${MAX_ATTEMPTS}, timeout=${REQUEST_TIMEOUT_MS}ms`);
  console.log(`[AutoOptWorker] Gemini service: ${RESUME_API_URL}`);

  recoverStaleJobs()
    .then(() => pollLoop())
    .catch(err => {
      console.error('[AutoOptWorker] Failed to start:', err);
      workerRunning = false;
    });
}

export function stopAutoOptimizationWorker() {
  workerRunning = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  console.log('[AutoOptWorker] Stopped');
}

export function getWorkerStatus() {
  return {
    running: workerRunning,
    processing: isProcessing,
    enabled: WORKER_ENABLED,
    config: {
      pollIntervalMs: POLL_INTERVAL_MS,
      delayBetweenJobsMs: DELAY_BETWEEN_JOBS_MS,
      maxAttempts: MAX_ATTEMPTS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      geminiServiceUrl: RESUME_API_URL
    }
  };
}
