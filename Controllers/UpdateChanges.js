
import { JobModel } from "../Schema_Models/JobModel.js";
import { UserModel } from "../Schema_Models/UserModel.js";
import { ProfileModel } from "../Schema_Models/ProfileModel.js";
import { DiscordConnect } from "../Utils/DiscordConnect.js";
import { validateOperatorRemovalReason } from "../Utils/operatorRemovalReason.js";
import { shouldSetAppliedDate, isBlankAppliedDate } from "../Utils/appliedDate.js";
import { checkPlanCap } from "../Utils/dailyCapGuard.js";
import { buildSummaryForEmail, isPureLogisticalReason } from "./BuildAiSummary.js";

export const REMOVAL_LIMIT = 100;
const REMOVAL_FEEDBACK_CAP = 20;
const REBUILD_DEBOUNCE_MS = 20_000;
const pendingRebuilds = new Map();
const OPERATIONS_EMAIL_DOMAIN = 'operations@flashfirehq';
const USER_EMAIL_DOMAIN = 'user@flashfirehq';
const TIMEZONE = 'Asia/Kolkata';
const IMPORTANT_STATUSES = ['saved', 'applied', 'interviewing', 'offer', 'rejected', 'deleted'];

const getCurrentISTTime = () =>
  new Date().toLocaleString('en-IN', { timeZone: TIMEZONE });

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
    throw {
      status: 400,
      message: "jobID and userDetails.email are required"
    };
  }
};

const validateAttachmentUrls = (urls) => {
  if (!urls.length) {
    throw { status: 400, message: "No attachment URLs provided" };
  }
};

// Role verification using caller email from the database.
const getVerifiedUserRole = async (callerEmail) => {
  const dbUser = await UserModel.findOne({ email: callerEmail })
    .select('role')
    .lean();

  if (!dbUser) {
    throw {
      status: 401,
      message: "User not found or unauthorized"
    };
  }

  return dbUser.role || 'user';
};

const isRemovalStatus = (status) => {
  if (!status) return false;
  const s = String(status).toLowerCase().trim();
  return s.startsWith('deleted') || s.startsWith('removed');
};

const checkRemovalLimit = async (userEmail, status, role) => {
  if (isRemovalStatus(status) && !isOperationsUser(role)) {
    const user = await UserModel.findOne({ email: userEmail })
      .select('removedJobsCount extraRemovalLimit')
      .lean();

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
 * Only touch operatorEmail on status updates.
 * Do not overwrite operatorName or addedBy.
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

const sendDiscordNotification = async (
  userDetails,
  job,
  newStatus,
  oldStatus,
  role,
  userEmail
) => {
  try {
    if (isRemovalStatus(newStatus)) return;

    let clientName = userDetails.name;

    if (isOperationsUser(role)) {
      try {
        const clientUser = await Promise.race([
          UserModel.findOne({ email: userEmail })
            .select('name')
            .lean(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), 500)
          )
        ]);

        clientName = clientUser?.name || userEmail;
      } catch (err) {
        clientName = userEmail;
      }
    }

    const discordMessage = buildDiscordMessage(
      clientName,
      job,
      newStatus,
      oldStatus
    );

    await Promise.race([
      DiscordConnect(
        process.env.DISCORD_APPLICATION_TRACKING_CHANNEL,
        discordMessage
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Discord timeout')), 2000)
      )
    ]);
  } catch (error) {
    console.error(
      'Discord notification failed (non-blocking):',
      error.message
    );
  }
};

// Store removal feedback and rebuild AI summary.
const recordRemovalFeedbackAndRebuild = (
  userEmail,
  job,
  jobID,
  reason,
  removedBy
) => {
  if (isPureLogisticalReason(reason)) {
    console.log(
      `[removal-feedback] skipped (logistical, no preference signal) email=${userEmail} reason="${String(reason).slice(0, 120)}"`
    );
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
          removalFeedback: {
            $each: [entry],
            $position: 0,
            $slice: REMOVAL_FEEDBACK_CAP,
          },
        },
        $set: { summaryStale: true },
      };

      let profile = await ProfileModel.findOneAndUpdate(
        { email: String(userEmail).toLowerCase() },
        feedbackUpdate,
        { new: true }
      ).lean();

      if (!profile) {
        const escaped = String(userEmail).replace(
          /[-/\\^$*+?.()|[\]{}]/g,
          "\\$&"
        );

        profile = await ProfileModel.findOneAndUpdate(
          { email: { $regex: new RegExp(`^${escaped}$`, "i") } },
          feedbackUpdate,
          { new: true }
        ).lean();
      }

      if (!profile) {
        console.warn(
          `[removal-feedback] no profile for ${userEmail} — reason kept on the job only`
        );
        return;
      }

      scheduleDebouncedRebuild(userEmail);
    } catch (err) {
      console.error(
        `[removal-feedback] threw email=${userEmail}`,
        err
      );
    }
  });
};

const scheduleDebouncedRebuild = (userEmail) => {
  const key = String(userEmail).toLowerCase();
  const existing = pendingRebuilds.get(key);

  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    pendingRebuilds.delete(key);

    try {
      const result = await buildSummaryForEmail(userEmail, "job-removal");

      if (result?.success) {
        console.log(
          `[summary-rebuild:job-removal] ok email=${userEmail} words=${result.wordCount} source=${result.source}`
        );
      } else if (result?.skipped) {
        console.log(
          `[summary-rebuild:job-removal] skipped email=${userEmail} — a build is already running, profile left stale for the sweep`
        );
      } else {
        console.warn(
          `[summary-rebuild:job-removal] fail email=${userEmail} err=${result?.error} msg=${result?.message}`
        );
      }
    } catch (err) {
      console.error(
        `[summary-rebuild:job-removal] threw email=${userEmail}`,
        err
      );
    }
  }, REBUILD_DEBOUNCE_MS);

  timer.unref?.();
  pendingRebuilds.set(key, timer);
};

// Prevent restoring a removed card beyond the plan cap.
const assertRestoreWithinPlan = async (
  userEmail,
  fromStatus,
  toStatus
) => {
  if (
    !toStatus ||
    !isRemovalStatus(fromStatus) ||
    isRemovalStatus(toStatus)
  ) return;

  let plan;

  try {
    plan = await checkPlanCap(userEmail);
  } catch (e) {
    throw {
      status: 503,
      message: "Could not verify plan limit. Try again shortly.",
      error: "PLAN_CAP_CHECK_FAILED"
    };
  }

  if (!plan.allowed) {
    throw {
      status: 403,
      message: `${plan.message} Restoring this card would take the client past their plan.`,
      error: "PLAN_LIMIT_REACHED"
    };
  }
};

// Action Handlers
const handleUpdateStatus = async (
  req,
  res,
  jobID,
  userEmail,
  userDetails
) => {
  const { status: baseStatus = '', removalReason } = req.body;
  const role = req.verifiedRole;

  const trimmedStatus = String(baseStatus).trim();

  const isOperatorRemoval =
    isRemovalStatus(trimmedStatus) && isOperationsUser(role);

  let operatorReason = null;

  if (isOperatorRemoval) {
    const check = validateOperatorRemovalReason(removalReason);

    if (!check.ok) {
      throw {
        status: 422,
        message: check.message,
        error: "REMOVAL_REASON_REQUIRED"
      };
    }

    operatorReason = check.reason;
  }

  const [_, currentJob] = await Promise.all([
    checkRemovalLimit(userEmail, trimmedStatus, role),
    JobModel.findOne({ jobID, userID: userEmail })
      .select('currentStatus companyName jobTitle appliedDate')
      .lean()
  ]);

  if (!currentJob) {
    throw { status: 404, message: "Job not found for this user" };
  }

  await assertRestoreWithinPlan(
    userEmail,
    currentJob.currentStatus,
    trimmedStatus
  );

  const actorName = getActorName(role, userDetails, req.body);
  const statusToSet = formatStatusWithAttribution(
    trimmedStatus,
    actorName
  );

  const updateFields = {
    currentStatus: statusToSet,
    updatedAt: getCurrentISTTime(),
    ...buildOperatorFields(role, req.body, userDetails)
  };

  if (
    shouldSetAppliedDate(currentJob.currentStatus, statusToSet) &&
    isBlankAppliedDate(currentJob.appliedDate)
  ) {
    updateFields.appliedDate = getCurrentISTTime();
  }

  if (isOperatorRemoval) {
    updateFields.operatorRemoval = {
      reason: operatorReason,
      by: req.body?.operationsName || 'operations',
      byEmail: req.body?.operationsEmail || '',
      at: new Date(),
    };
  }

  const isReasonedRemoval =
    isRemovalStatus(trimmedStatus) &&
    !!removalReason &&
    !isOperatorRemoval;

  if (isReasonedRemoval) {
    const removedByName = isOperationsUser(role)
      ? (req.body?.operationsName || 'operations')
      : 'user';

    updateFields.removalReason = removalReason;
    updateFields.removalDate = getCurrentISTTime();
    updateFields.removedBy = removedByName;
  }

  const updatePromise = JobModel.findOneAndUpdate(
    { jobID, userID: userEmail },
    {
      $set: updateFields,
      $push: { timeline: statusToSet }
    },
    { new: true }
  ).lean();

  const incrementPromise = incrementRemovalCount(
    userEmail,
    trimmedStatus,
    role
  );

  await Promise.all([updatePromise, incrementPromise]);

  if (isReasonedRemoval) {
    recordRemovalFeedbackAndRebuild(
      userEmail,
      currentJob,
      jobID,
      removalReason,
      updateFields.removedBy
    );
  }

  sendDiscordNotification(
    userDetails,
    currentJob,
    statusToSet,
    currentJob.currentStatus,
    role,
    userEmail
  ).catch(err =>
    console.error(
      'Discord notification error (non-blocking):',
      err
    )
  );
};

const handleEdit = async (
  req,
  res,
  jobID,
  userEmail,
  userDetails
) => {
  const { status } = req.body;
  const role = req.verifiedRole;

  const attachmentUrls = normalizeAttachmentUrls(req.body);

  validateAttachmentUrls(attachmentUrls);

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
    nextStatus = formatStatusWithAttribution(
      trimmedStatus,
      actorName
    );
  } else {
    nextStatus = existingJob.currentStatus;
  }

  await assertRestoreWithinPlan(
    userEmail,
    existingJob.currentStatus,
    nextStatus
  );

  const updateFields = {
    updatedAt: getCurrentISTTime(),
    currentStatus: nextStatus,
    ...buildOperatorFields(role, req.body, userDetails)
  };

  if (
    isOperationsUser(role) &&
    isRemovalStatus(status) &&
    !isRemovalStatus(existingJob.currentStatus)
  ) {
    const check = validateOperatorRemovalReason(
      req.body?.removalReason
    );

    if (!check.ok) {
      throw {
        status: 422,
        message: check.message,
        error: "REMOVAL_REASON_REQUIRED"
      };
    }

    updateFields.operatorRemoval = {
      reason: check.reason,
      by: req.body?.operationsName || 'operations',
      byEmail: req.body?.operationsEmail || '',
      at: new Date(),
    };
  }

  if (
    shouldSetAppliedDate(existingJob.currentStatus, nextStatus) &&
    isBlankAppliedDate(existingJob.appliedDate)
  ) {
    updateFields.appliedDate = getCurrentISTTime();
  }

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

  const incrementPromise = incrementRemovalCount(
    userEmail,
    status,
    role
  );

  const [updatedJob] = await Promise.all([
    updatePromise,
    incrementPromise
  ]);

  if (!updatedJob) {
    throw { status: 404, message: "Job not found for this user" };
  }

  const isImportantChange = IMPORTANT_STATUSES.some(s =>
    String(nextStatus).toLowerCase().includes(s)
  );

  if (
    isImportantChange &&
    existingJob.currentStatus !== nextStatus
  ) {
    sendDiscordNotification(
      userDetails,
      updatedJob,
      nextStatus,
      existingJob.currentStatus,
      role,
      userEmail
    ).catch(err =>
      console.error(
        'Discord notification error (non-blocking):',
        err
      )
    );
  }
};

const handleDelete = async (req, res, jobID, userEmail) => {
  await JobModel.findOneAndDelete({
    jobID,
    userID: userEmail
  }).lean();
};

// Main Controller
export default async function UpdateChanges(req, res) {
  const {
    jobID,
    userDetails,
    action,
    returnUpdatedJobs = true
  } = req.body;

  const userEmail = userDetails?.email;

  try {
    validateRequiredFields(jobID, userEmail);

    // Verify caller role using operations email when supplied.
    const callerEmail = req.body?.operationsEmail || userEmail;
    const verifiedRole = await getVerifiedUserRole(callerEmail);

    req.verifiedRole = verifiedRole;

    switch (action) {
      case "UpdateStatus":
        await handleUpdateStatus(
          req,
          res,
          jobID,
          userEmail,
          userDetails
        );
        break;

      case "edit":
        await handleEdit(
          req,
          res,
          jobID,
          userEmail,
          userDetails
        );
        break;

      case "delete":
        await handleDelete(
          req,
          res,
          jobID,
          userEmail
        );
        break;

      default:
        throw {
          status: 400,
          message: "Invalid action specified"
        };
    }

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
