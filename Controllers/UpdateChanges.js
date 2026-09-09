// controllers/UpdateChanges.js
import { JobModel } from "../Schema_Models/JobModel.js";
import { UserModel } from "../Schema_Models/UserModel.js";
import { ProfileModel } from "../Schema_Models/ProfileModel.js";
import { DiscordConnect } from "../Utils/DiscordConnect.js";
// isPureLogisticalReason: duplicate/already-applied/posting-closed reasons
// carry zero preference signal — they still land on the job + Discord, but
// never enter removalFeedback or trigger a rebuild. Duplicates are already
// prevented upstream by CheckForDuplicateJobs on /api/jobs. Shared with the
// summary builder, which uses it to drop legacy logistical entries too.
import { buildSummaryForEmail, isPureLogisticalReason } from "./BuildAiSummary.js";

const REMOVAL_LIMIT = 100;
// Newest-first cap on profile.removalFeedback — enough history for the AI
// summary prompt (it reads the top 10) without unbounded doc growth.
const REMOVAL_FEEDBACK_CAP = 20;
// Clients often clean their board in bursts (several removals within a
// minute). Each removal pushes its feedback entry immediately, but the
// summary rebuild is debounced per client so a burst produces ONE build
// containing ALL the new reasons — instead of N racing builds where a
// stale early build could finish last and win.
const REBUILD_DEBOUNCE_MS = 20_000;
const pendingRebuilds = new Map(); // email -> Timeout
const OPERATIONS_EMAIL_DOMAIN = 'operations@flashfirehq';
const USER_EMAIL_DOMAIN = 'user@flashfirehq';
const TIMEZONE = 'Asia/Kolkata';
const IMPORTANT_STATUSES = ['saved', 'applied', 'interviewing', 'offer', 'rejected', 'deleted'];

const getCurrentISTTime = () => new Date().toLocaleString('en-IN', { timeZone: TIMEZONE });

const isOperationsUser = (role) => role === 'operations';

const shouldAttributeStatus = (baseStatus) => {
  return baseStatus !== '' && !/\sby\s/i.test(baseStatus);
};

const formatStatusWithAttribution = (baseStatus, actorName) => {
  if (!shouldAttributeStatus(baseStatus)) return baseStatus;
  return `${baseStatus} by ${actorName}`;
};

const getActorName = (role, userDetails, body) => {
  if (isOperationsUser(role)) {
    return body?.operationsName || userDetails?.name || 'operations';
  }
  return 'user';
};

const normalizeAttachmentUrls = (body) => {
  const raw = body?.attachmentUrls ?? body?.attachmentUrl ?? body?.urls ?? [];
  return (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
};

const validateRequiredFields = (jobID, userEmail) => {
  if (!jobID || !userEmail) {
    throw { status: 400, message: "jobID and userDetails.email are required" };
  }
};

const validateAttachmentUrls = (urls) => {
  if (!urls.length) {
    throw { status: 400, message: "No attachment URLs provided" };
  }
};

const isRemovalStatus = (status) => {
  if (!status) return false;
  const s = String(status).toLowerCase().trim();
  return s.startsWith('deleted') || s.startsWith('removed');
};

const checkRemovalLimit = async (userEmail, status, role) => {
  if (isRemovalStatus(status) && !isOperationsUser(role)) {
    const user = await UserModel.findOne({ email: userEmail }).select('removedJobsCount extraRemovalLimit').lean();
    const effectiveLimit = REMOVAL_LIMIT + (user?.extraRemovalLimit || 0);
    if (user && user.removedJobsCount >= effectiveLimit) {
      throw {
        status: 400,
        message: "Removal limit exceeded",
        error: `You have reached the maximum limit of ${effectiveLimit} job removals. Please contact support if you need to remove more jobs.`
      };
    }
    return user;
  }
  return null;
};

/**
 * Only touch operatorEmail on status updates — do not overwrite operatorName.
 * operatorName + addedBy are set at job creation (e.g. extension code name) and must stay stable.
 */
const buildOperatorFields = (role, body, userDetails) => {
  const fields = {};

  if (isOperationsUser(role)) {
    fields.operatorEmail = body?.operationsEmail || OPERATIONS_EMAIL_DOMAIN;
  } else {
    fields.operatorEmail = USER_EMAIL_DOMAIN;
  }

  return fields;
};

// Stamp appliedDate on the first move into an applied column.
//
// This used to compare `currentStatus === "saved"` against the RAW stored value,
// which is wrong for every job an operator has ever touched. Every status write
// goes through formatStatusWithAttribution(), and shouldAttributeStatus()
// appends " by <name>" to anything not already containing " by ". So the moment
// an operator moves a card to Saved, currentStatus becomes "saved by Sathya" and
// the exact-equality test can never match again. appliedDate then stayed null
// forever, which silently broke everything keyed on it: the "Last applied by"
// column, "Since 1st Apply", the operator performance report, and the
// applied-on-date counts.
//
// Compare on the leading word instead, lower-cased, so both the attribution
// suffix and whatever casing the client sent are tolerated.
const shouldSetAppliedDate = (currentStatus, newStatus) => {
  const from = String(currentStatus || "").trim().toLowerCase();
  const to = String(newStatus || "").trim().toLowerCase();
  return from.startsWith("saved") && to.startsWith("applied");
};

const incrementRemovalCount = async (userEmail, status, role) => {
  if (isRemovalStatus(status) && !isOperationsUser(role)) {
    return UserModel.findOneAndUpdate(
      { email: userEmail },
      { $inc: { removedJobsCount: 1 } },
      { new: true }
    ).lean();
  }
  return Promise.resolve(null);
};

const buildDiscordMessage = (clientName, job, newStatus, oldStatus) => {
  return `📌 Job Update:
  Client: ${clientName}
  Company: ${job?.companyName || 'N/A'}
  Job Title: ${job?.jobTitle || 'N/A'}
  Status: ${newStatus}
  Previous: ${oldStatus}`;
};

const sendDiscordNotification = async (userDetails, job, newStatus, oldStatus, role, userEmail) => {
  try {
    // Don't send notification for deleted status
    if (isRemovalStatus(newStatus)) return;

    let clientName = userDetails.name;

    // For operations users, fetch the actual client name (with timeout)
    if (isOperationsUser(role)) {
      try {
        const clientUser = await Promise.race([
          UserModel.findOne({ email: userEmail }).select('name').lean(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 500))
        ]);
        clientName = clientUser?.name || userEmail;
      } catch (err) {
        // If fetch fails or times out, use email as fallback
        clientName = userEmail;
      }
    }

    const discordMessage = buildDiscordMessage(clientName, job, newStatus, oldStatus);
    await Promise.race([
      DiscordConnect(process.env.DISCORD_APPLICATION_TRACKING_CHANNEL, discordMessage),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Discord timeout')), 2000))
    ]);
  } catch (error) {
    // Silently fail - don't block the main request
    console.error('Discord notification failed (non-blocking):', error.message);
  }
};

// Fire-and-forget: persist the client's removal reason on their profile as
// "removal feedback" (newest first, capped) and rebuild the AI summary so
// the next scrape run stops picking jobs that match the complaint. Runs on
// setImmediate and swallows every error — the status update must succeed
// even when the profile is missing or OpenAI is down. Mirrors the
// triggerSummaryRebuild pattern in Add_Update_Profile.js.
const recordRemovalFeedbackAndRebuild = (userEmail, job, jobID, reason, removedBy) => {
  if (isPureLogisticalReason(reason)) {
    console.log(`[removal-feedback] skipped (logistical, no preference signal) email=${userEmail} reason="${String(reason).slice(0, 120)}"`);
    return;
  }
  setImmediate(async () => {
    try {
      const entry = {
        jobID: jobID || "",
        jobTitle: job?.jobTitle || "",
        companyName: job?.companyName || "",
        reason: String(reason).trim().slice(0, 1000),
        removedAt: new Date(),
        removedBy: removedBy || "user",
      };
      const feedbackUpdate = {
        $push: {
          removalFeedback: { $each: [entry], $position: 0, $slice: REMOVAL_FEEDBACK_CAP },
        },
        $set: { summaryStale: true },
      };
      // Same email matching as buildSummaryForEmail: exact lowercase first,
      // case-insensitive fallback for legacy mixed-case profile emails.
      let profile = await ProfileModel.findOneAndUpdate(
        { email: String(userEmail).toLowerCase() },
        feedbackUpdate,
        { new: true },
      ).lean();
      if (!profile) {
        const escaped = String(userEmail).replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
        profile = await ProfileModel.findOneAndUpdate(
          { email: { $regex: new RegExp(`^${escaped}$`, "i") } },
          feedbackUpdate,
          { new: true },
        ).lean();
      }
      if (!profile) {
        console.warn(`[removal-feedback] no profile for ${userEmail} — reason kept on the job only`);
        return;
      }
      scheduleDebouncedRebuild(userEmail);
    } catch (err) {
      console.error(`[removal-feedback] threw email=${userEmail}`, err);
    }
  });
};

// One rebuild per client per burst: every removal resets the client's timer;
// the build fires REBUILD_DEBOUNCE_MS after the LAST removal, so it always
// sees the complete set of new feedback entries. summaryStale stays true
// until the build succeeds, so the cron sweep is the backstop if the
// process dies inside the window.
const scheduleDebouncedRebuild = (userEmail) => {
  const key = String(userEmail).toLowerCase();
  const existing = pendingRebuilds.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    pendingRebuilds.delete(key);
    try {
      const result = await buildSummaryForEmail(userEmail, "job-removal");
      if (result?.success) {
        console.log(`[summary-rebuild:job-removal] ok email=${userEmail} words=${result.wordCount} source=${result.source}`);
      } else if (result?.skipped) {
        console.log(`[summary-rebuild:job-removal] skipped email=${userEmail} — a build is already running, profile left stale for the sweep`);
      } else {
        console.warn(`[summary-rebuild:job-removal] fail email=${userEmail} err=${result?.error} msg=${result?.message}`);
      }
    } catch (err) {
      console.error(`[summary-rebuild:job-removal] threw email=${userEmail}`, err);
    }
  }, REBUILD_DEBOUNCE_MS);
  timer.unref?.();
  pendingRebuilds.set(key, timer);
};

// Action Handlers
const handleUpdateStatus = async (req, res, jobID, userEmail, userDetails) => {
  const { status: baseStatus = '', role, removalReason } = req.body;
  const trimmedStatus = String(baseStatus).trim();

  // Parallelize validation and job fetch
  const [_, currentJob] = await Promise.all([
    checkRemovalLimit(userEmail, trimmedStatus, role),
    JobModel.findOne({ jobID, userID: userEmail })
      .select('currentStatus companyName jobTitle appliedDate')
      .lean()
  ]);

  if (!currentJob) {
    throw { status: 404, message: "Job not found for this user" };
  }

  const actorName = getActorName(role, userDetails, req.body);
  const statusToSet = formatStatusWithAttribution(trimmedStatus, actorName);

  // Build update fields
  const updateFields = {
    currentStatus: statusToSet,
    updatedAt: getCurrentISTTime(),
    ...buildOperatorFields(role, req.body, userDetails)
  };

  // Set appliedDate only on the first transition to applied (never overwrite once set)
  if (shouldSetAppliedDate(currentJob.currentStatus, statusToSet) && !currentJob.appliedDate) {
    updateFields.appliedDate = getCurrentISTTime();
  }

  // Save removal reason if job is being moved to deleted
  const isReasonedRemoval = isRemovalStatus(trimmedStatus) && !!removalReason;
  if (isReasonedRemoval) {
    const removedByName = isOperationsUser(role)
      ? (req.body?.operationsName  || 'operations')
      : 'user';
    updateFields.removalReason = removalReason;
    updateFields.removalDate = getCurrentISTTime();
    updateFields.removedBy = removedByName;
  }

  // Update job and increment removal count in parallel (if needed)
  const updatePromise = JobModel.findOneAndUpdate(
    { jobID, userID: userEmail },
    {
      $set: updateFields,
      $push: { timeline: statusToSet }
    },
    { new: true }
  ).lean();

  const incrementPromise = incrementRemovalCount(userEmail, trimmedStatus, role);

  await Promise.all([updatePromise, incrementPromise]);

  // Reasoned removal → store the feedback on the profile and auto-rebuild
  // the AI summary so the picker learns from it (non-blocking).
  if (isReasonedRemoval) {
    recordRemovalFeedbackAndRebuild(userEmail, currentJob, jobID, removalReason, updateFields.removedBy);
  }

  // Send Discord notification asynchronously (non-blocking)
  sendDiscordNotification(
    userDetails,
    currentJob,
    statusToSet,
    currentJob.currentStatus,
    role,
    userEmail
  ).catch(err => console.error('Discord notification error (non-blocking):', err));
};

const handleEdit = async (req, res, jobID, userEmail, userDetails) => {
  const { role, status } = req.body;
  const attachmentUrls = normalizeAttachmentUrls(req.body);

  // Validate inputs
  validateAttachmentUrls(attachmentUrls);

  // Parallelize removal check and job fetch
  const [_, existingJob] = await Promise.all([
    checkRemovalLimit(userEmail, status, role),
    JobModel.findOne({ jobID, userID: userEmail })
      .select('currentStatus companyName jobTitle appliedDate')
      .lean()
  ]);

  if (!existingJob) {
    throw { status: 404, message: "Job not found for this user" };
  }

  let nextStatus;
  
  if (status && status.trim() !== '') {
    const trimmedStatus = String(status).trim();
    const actorName = getActorName(role, userDetails, req.body);
    nextStatus = formatStatusWithAttribution(trimmedStatus, actorName);
  } else {
    nextStatus = existingJob.currentStatus;
  }

  // Build update fields
  const updateFields = {
    updatedAt: getCurrentISTTime(),
    currentStatus: nextStatus,
    ...buildOperatorFields(role, req.body, userDetails)
  };

  // Set appliedDate only on the first transition to applied (never overwrite once set)
  if (shouldSetAppliedDate(existingJob.currentStatus, nextStatus) && !existingJob.appliedDate) {
    updateFields.appliedDate = getCurrentISTTime();
  }

  // Update job and increment removal count in parallel (if needed)
  const updatePromise = JobModel.findOneAndUpdate(
    { jobID, userID: userEmail },
    {
      $set: updateFields,
      $addToSet: {
        attachments: { $each: attachmentUrls },
        timeline: nextStatus
      }
    },
    { new: true }
  ).lean();

  const incrementPromise = incrementRemovalCount(userEmail, status, role);

  const [updatedJob] = await Promise.all([updatePromise, incrementPromise]);

  if (!updatedJob) {
    throw { status: 404, message: "Job not found for this user" };
  }

  // Send Discord notification asynchronously (non-blocking)
  const isImportantChange = IMPORTANT_STATUSES.some(s =>
    String(nextStatus).toLowerCase().includes(s)
  );

  if (isImportantChange && existingJob.currentStatus !== nextStatus) {
    sendDiscordNotification(
      userDetails,
      updatedJob,
      nextStatus,
      existingJob.currentStatus,
      role,
      userEmail
    ).catch(err => console.error('Discord notification error (non-blocking):', err));
  }
};

const handleDelete = async (req, res, jobID, userEmail) => {
  await JobModel.findOneAndDelete({ jobID, userID: userEmail }).lean();
};

// Main Controller
export default async function UpdateChanges(req, res) {
  const { jobID, userDetails, action, returnUpdatedJobs = true } = req.body;
  const userEmail = userDetails?.email;

  try {
    // Validate required fields
    validateRequiredFields(jobID, userEmail);

    // Route to appropriate handler
    switch (action) {
      case "UpdateStatus":
        await handleUpdateStatus(req, res, jobID, userEmail, userDetails);
        break;

      case "edit":
        await handleEdit(req, res, jobID, userEmail, userDetails);
        break;

      case "delete":
        await handleDelete(req, res, jobID, userEmail);
        break;

      default:
        throw { status: 400, message: "Invalid action specified" };
    }

    // Only fetch updated jobs if requested (optional optimization)
    // Use selective projection to reduce data transfer
    // Sort by updatedAt DESC so most recently moved jobs appear first
    const updatedJobs = returnUpdatedJobs !== false
      ? await JobModel.find({ userID: userEmail })
        .select(
          'jobID jobTitle companyName currentStatus createdAt updatedAt joblink dateAdded appliedDate attachments optimizedResume.hasResume optimizedResumeSeen autoOptimization timeline addedBy createdByRole operatorName operatorEmail'
        )
        .sort({ updatedAt: -1 })
        .lean()
      : [];

    return res.status(200).json({
      message: "Jobs updated successfully",
      updatedJobs
    });

  } catch (error) {
    console.error("UpdateChanges error:", error);

    const status = error.status || 500;
    const message = error.message || "Server error";
    const errorDetail = error.error || String(error);

    return res.status(status).json({
      message,
      ...(error.error && { error: errorDetail })
    });
  }
}
