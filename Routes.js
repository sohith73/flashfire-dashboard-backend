import express from "express";
import { getWorkerStatus } from './src/services/autoOptimizationWorker.js';
import { JobModel as AutoOptJobModel } from './Schema_Models/JobModel.js';
import Login from "./Controllers/Login.js";
import Register from "./Controllers/Register.js";
import GoogleOAuth from "./Controllers/GoogleOAuth.js";
import { getAllClients } from './Controllers/ClientController.js';
import { getClientTrackingStatus } from './Controllers/ClientTrackingStatus.js';
import { listAutopilotCreds, getAutopilotCreds, putAutopilotCreds } from './Controllers/AutopilotCreds.js';
import { getDashboardManagers, getDashboardManagerByName, syncDashboardManagers } from './Controllers/DashboardManagerController.js';
import Add_Update_Profile from "./Controllers/Add_Update_Profile.js";
import AddJob from "./Controllers/AddJob.js";
import GetAllJobs from "./Controllers/GetAllJobs.js";
import Unsubscribe from "./Controllers/Unsubscribe.js";
import Get24HourJobs from "./Controllers/Get24HourJobs.js";
import StoreJobAndUserDetails, { saveToDashboard } from "./Controllers/StoreJobAndUserDetails.js";
import UpdateChanges from "./Controllers/UpdateChanges.js";
import GetRemovalReason from "./Controllers/GetRemovalReason.js";
import GetAiRemovedJobs from "./Controllers/GetAiRemovedJobs.js";
import ResolveSecondJudgeFlag from "./Controllers/ResolveSecondJudgeFlag.js";
import PlanSelect from "./Controllers/PlanSelect.js";
import { uploadProfileFile, upload } from "./Controllers/UploadProfileFile.js";
import { uploadSingleFile, uploadBase64File, uploadOnboardingAttachment, upload as uploadMiddleware } from "./Controllers/UploadFile.js";
import { uploadClientDocument, getClientDocuments, updateClientOptimizationStatus, upload as internalUpload } from "./Controllers/InternalClientUpload.js";
import { serveCachedImage, getCacheStats, clearCache } from "./Controllers/ImageProxy.js";
import { serveDocProxy } from "./Controllers/DocProxy.js";
import LocalTokenValidator from "./Middlewares/LocalTokenValidator.js";
import RegisterVerify from "./Middlewares/RegisterVerify.js";
import AdminKeyVerify from "./Middlewares/AdminKeyVerify.js";
import ProfileCheck from "./Middlewares/ProfileCheck.js";
import LoginVerify from "./Middlewares/LoginVerify.js";
import CheckForDuplicateJobs from "./Middlewares/CheckForDuplicateJobs.js";
import Tokenizer from "./Middlewares/Tokenizer.js";
import UpdateActionsVerifier from "./Middlewares/UpdateActionsVerifier.js";
import VerifyJobIDAndChanges from "./Middlewares/VerifyJobIDAndChanges.js";
import RefreshToken from "./Controllers/RefreshToken.js";
import { getJobById, getJobDescription, getJobDescriptionByUrl, saveChangedSession, testJobController, getOptimizedResume, getJobsWithOptimizedResumes, getOptimizedResumesForDocuments } from "./Controllers/Optimizer/jobController.js";
import { migrateResumeDataToR2, getMigrationStatus } from "./Controllers/Optimizer/migrateToR2.js";
import GetJobDescription, { GetJobDescriptionByUrl } from "./Controllers/GetJobDescription.js";
import { updateBaseResume } from "./Controllers/Admin/SetBaseResume.js";
import GetBaseResumeData from "./Controllers/GetBaseResumeData.js";
import { assignUserToOperations } from "./Controllers/Admin/AssignUserToOperatios.js";
import { listOperations, removeManagedUser, removeOperationUser, listAllUsers, listAllOperations, updateOperation } from "./Controllers/Admin/ListOperations.js";
import AssignResumeToUser from "./Controllers/Admin/AssignResumeToUser.js";
import { OperationsLogin, OperationsRegister } from "./Controllers/operations/Login.js";
import { requestDashboardOtp, verifyDashboardOtp, validateOtpTrust } from "./Controllers/operations/OtpController.js";
import OperationsHandeling from "./Middlewares/OperationsHandeling.js";
import GetUserDetails from "./Controllers/operations/GetUserDetails.js";
import GetUserResumes from "./Controllers/operations/GetUserResumes.js";
import GetAllJobsOPS from "./Controllers/operations/GetAllJobs.js";
import { getClientOperations, updateClientOperations, checkLockPeriod } from "./Controllers/operations/ClientOperations.js";
import { reconcileExclusionJobsHandler } from "./Controllers/operations/reconcileExclusionJobs.js";
import { queueAutoOptimizeSavedJobs } from "./Controllers/operations/QueueAutoOptimizeSavedJobs.js";
import requireOpsKey from "./Middlewares/RequireOpsKey.js";
import {
  getClientReminderConfig,
  updateClientReminderConfig,
  setClientReminderPaymentEmail,
  sendClientReminderNow,
  testClientReminderMattermost,
  previewClientReminder,
  getClientReminderHistory
} from "./Controllers/operations/ClientReminders.js";
import ForgotPassword from "./Controllers/ForgotPassword.js";
import ExtensionLogin from "./Controllers/Extensions/login.js";
import { GeminiJudge } from "./Controllers/Extensions/geminiJudge.js";
import { GeminiForScrapingTest } from "./Controllers/Extensions/geminiJudgeTest.js";
import { OpenAiJudge } from "./Controllers/Extensions/openaiJudge.js";
import { ReciveData } from "./Controllers/Extensions/reciveData.js";
import { extractJobData } from "./Controllers/Extensions/extractJobData.js";
import ClientLogin from "./Controllers/Extensions/clientLogin.js";
import { getSpeedyApplyProfile, saveSpeedyApplyProfile } from "./Controllers/Extensions/speedyApplyProfile.js";
import { onboardingTick } from "./src/services/onboardingMailWorker.js";
import { OnboardingMailStatus, SendOnboardingMailStep } from "./Controllers/OnboardingMailStatus.js";
import { getExtensionExclusionLists } from "./Controllers/Extensions/exclusionLists.js";
import { getExtensionSettings, updateExtensionSettings } from "./Controllers/Extensions/settings.js";
import { extGetProfile, extPatchProfile } from "./Controllers/Extensions/profileExt.js";
import ExtensionAuth from "./Middlewares/ExtensionAuth.js";
import { ProfileModel } from "./Schema_Models/ProfileModel.js";
import { UserModel } from "./Schema_Models/UserModel.js";
import CheckProfile from "./Controllers/CheckProfile.js";
import GetProfile from "./Controllers/GetProfile.js";
import UpdateAiSummary from "./Controllers/UpdateAiSummary.js";
import BuildAiSummary, { AiSummaryStatus } from "./Controllers/BuildAiSummary.js";
import {
  SaveSummaryOverlay,
  ClearSummaryOverlay,
  GetSummaryOverlay,
} from "./Controllers/SaveSummaryOverlay.js";
import { SaveAiNotes, GetAiNotes } from "./Controllers/SaveAiNotes.js";
import UpdateTargetJobs from "./Controllers/UpdateTargetJobs.js";
import UpdateScrapeSources from "./Controllers/UpdateScrapeSources.js";
import UpdateOpenaiKey from "./Controllers/UpdateOpenaiKey.js";
import { GetGlobalOpenaiKey, SetGlobalOpenaiKey } from "./Controllers/GlobalOpenaiKey.js";
import PushHistory from "./Controllers/PushHistory.js";
import SummariesOverview from "./Controllers/SummariesOverview.js";
import ExtensionSessionStatLog from "./Controllers/ExtensionSessionStatLog.js";
import OperatorActivity from "./Controllers/OperatorActivity.js";
import ExtensionTodayStats from "./Controllers/ExtensionTodayStats.js";
import ExtensionDailyHistory from "./Controllers/ExtensionDailyHistory.js";
import PricingInfo from "./Controllers/PricingInfo.js";
import AiCostReport from "./Controllers/AiCostReport.js";
import ScrapeCostHistory from "./Controllers/ScrapeCostHistory.js";
import { generateSessionKey, listSessionKeys, revokeSession, revokeUserSessions, listActiveSessions, verifySessionKey } from "./Controllers/operations/SessionKeys.js";
import gmailRouter from "./Controllers/GmailRouter.js";
import gmailInboxRouter from "./Controllers/GmailInboxRouter.js";
import { listGroups, createGroup, getGroup, updateGroup } from "./Controllers/RecruiterAutomation.js";
import { aiGenerateTemplateHandler } from "./Controllers/RecruiterAiTemplate.js";
import { getWhatsAppGroups, linkUserToGroup, getUserGroupMapping, sendCustomNotification, checkNotificationCooldown } from "./Controllers/whatsapp/WhatsAppController.js";
import { generateExtensionCode, verifyExtensionCode, listExtensionCodes } from "./Controllers/operations/ExtensionCodes.js";
import { fixAppliedDates } from "./Controllers/FixAppliedDates.js";



const app = express.Router();

// Auth routes
app.post("/login", Login);
app.post("/google-oauth", GoogleOAuth);

// Client management routes
// Account creation is admin-only: sign-in requires an account that already
// exists, so nothing about this endpoint may be self-service.
app.post("/api/clients/register", AdminKeyVerify, RegisterVerify, Register);
app.get("/api/clients/all", getAllClients);
app.get("/api/clients/tracking-status", getClientTrackingStatus);
// Autopilot credential store - shared-secret gated, see Controllers/AutopilotCreds.js
app.get("/autopilot/creds", requireOpsKey, listAutopilotCreds);
app.get("/autopilot/creds/:email", requireOpsKey, getAutopilotCreds);
app.put("/autopilot/creds/:email", requireOpsKey, putAutopilotCreds);
app.get("/api/dashboard-managers", getDashboardManagers);
app.get("/sync/managers", syncDashboardManagers);
app.post("/refresh-token", RefreshToken);
app.post('/get-updated-user', async (req, res) => {
  try {
    const email = req.body?.email;
    if (!email) {
      return res.status(400).json({ message: "email is required", code: "MISSING_EMAIL" });
    }

    const existanceOfUser = await UserModel.findOne({ email });

    // A miss used to fall through to the 200 below, which serialised every
    // field as undefined and shipped `{"portfolioLinks":[]}` with no email.
    // The dashboard trusted that and overwrote its stored session with it,
    // stranding the user in a half-authenticated state that survived reloads
    // and could only be escaped by clearing site data. Operators legitimately
    // miss here because they live in the Operations collection, so answer 404
    // and let the client keep the session it already has.
    if (!existanceOfUser) {
      return res.status(404).json({ message: "User not found", code: "ACCOUNT_NOT_FOUND" });
    }

    return res.status(200).json({
      name: existanceOfUser.name,
      email: existanceOfUser.email,
      planType: existanceOfUser.planType,
      userType: existanceOfUser.userType,
      planLimit: existanceOfUser.planLimit,
      resumeLink: existanceOfUser.resumeLink,
      coverLetters: existanceOfUser.coverLetters,
      optimizedResumes: existanceOfUser.optimizedResumes,
      transcript: existanceOfUser.transcript,
      portfolioLinks: existanceOfUser.portfolioLinks || [],
      dashboardManager: existanceOfUser.dashboardManager,
      currency: existanceOfUser.currency || "USD",
      addons: existanceOfUser.addons || [],
      amountPaid: existanceOfUser.amountPaid || "0",
    })
  } catch (error) {
    // This used to log and never respond, hanging the request until timeout.
    console.error('get-updated-user error:', error);
    return res.status(500).json({ message: "Internal server error" });
  }
})

// Return how many jobs a user has removed (UserModel.removedJobsCount)
app.post('/get-removed-jobs-count', async (req, res) => {
  try {
    const { email } = req.body || {};

    if (!email) {
      return res.status(400).json({
        success: false,
        error: "Email is required",
        message: "Please provide a user email to fetch removed jobs count"
      });
    }

    const user = await UserModel.findOne({ email }).select('name email removedJobsCount extraRemovalLimit');
    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
        message: "No user found with the provided email"
      });
    }

    const extraRemovalLimit = user.extraRemovalLimit ?? 0;
    return res.status(200).json({
      success: true,
      name: user.name,
      email: user.email,
      removedJobsCount: user.removedJobsCount ?? 0,
      extraRemovalLimit,
      // Effective cap = global base limit (100) + operator-granted bonus.
      removalLimit: 100 + extraRemovalLimit
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      success: false,
      error: "Server error",
      message: "Failed to fetch removed jobs count"
    });
  }
});

// Operator-only: grant a user extra job removals on top of the global limit (100).
// Body: { email, extraRemovalLimit }. extraRemovalLimit is the BONUS (not total cap).
app.post('/update-removal-limit', async (req, res) => {
  try {
    const { email, extraRemovalLimit } = req.body || {};

    if (!email) {
      return res.status(400).json({
        success: false,
        error: "Email is required",
        message: "Please provide a user email to update the removal limit"
      });
    }

    const bonus = Number(extraRemovalLimit);
    if (!Number.isFinite(bonus) || bonus < 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid value",
        message: "extraRemovalLimit must be a non-negative number"
      });
    }

    const user = await UserModel.findOneAndUpdate(
      { email },
      { $set: { extraRemovalLimit: Math.floor(bonus) } },
      { new: true }
    ).select('name email removedJobsCount extraRemovalLimit');

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
        message: "No user found with the provided email"
      });
    }

    const updatedExtra = user.extraRemovalLimit ?? 0;
    return res.status(200).json({
      success: true,
      name: user.name,
      email: user.email,
      removedJobsCount: user.removedJobsCount ?? 0,
      extraRemovalLimit: updatedExtra,
      removalLimit: 100 + updatedExtra
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      success: false,
      error: "Server error",
      message: "Failed to update removal limit"
    });
  }
});

// Get referral stats for a user
app.post('/get-referral-stats', async (req, res) => {
  try {
    const { email } = req.body || {};

    if (!email) {
      return res.status(400).json({
        success: false,
        error: "Email is required",
        message: "Please provide a user email to fetch referral stats"
      });
    }

    // Use case-insensitive email search
    const emailLower = email.toLowerCase().trim();
    const user = await UserModel.findOne({ 
      email: { $regex: new RegExp(`^${emailLower}$`, 'i') }
    }).select('email referralStatus referrals');
    
    if (!user) {
      console.log(`User not found for email: ${emailLower}`);
      return res.status(404).json({
        success: false,
        error: "User not found",
        message: "No user found with the provided email"
      });
    }

    console.log(`Found user: ${user.email}, referralStatus: ${user.referralStatus}`);

    // Calculate referral applications based on referrals or legacy referralStatus
    let referralApplicationsAdded = 0;
    const referralsArray = Array.isArray(user.referrals) ? user.referrals : [];

    if (referralsArray.length > 0) {
      referralsArray.forEach((ref) => {
        if (ref?.plan === 'Professional') {
          referralApplicationsAdded += 200;
        } else if (ref?.plan === 'Executive') {
          referralApplicationsAdded += 300;
        }
      });
    } else {
      if (user.referralStatus === 'Professional') {
        referralApplicationsAdded = 200;
      } else if (user.referralStatus === 'Executive') {
        referralApplicationsAdded = 300;
      }
    }

    console.log(`Calculated referralApplicationsAdded: ${referralApplicationsAdded} for status: ${user.referralStatus}`);

    return res.status(200).json({
      success: true,
      email: user.email,
      referralStatus: user.referralStatus || null,
      referrals: referralsArray,
      referralApplicationsAdded
    });
  } catch (error) {
    console.error('Error fetching referral stats:', error);
    return res.status(500).json({
      success: false,
      error: "Server error",
      message: "Failed to fetch referral stats"
    });
  }
});

// Plan usage — read-only view of the SAME numbers /addjob enforces, so the
// dashboard can show the limit and stop a job card being started once it is
// reached instead of only failing at submit. Deliberately reuses checkPlanCap
// (Utils/dailyCapGuard.js) rather than recomputing: one source of truth means
// the banner can never disagree with the gate. Removed/deleted jobs are already
// excluded by countTotalJobs, and referral + addon bonuses are already stacked.
app.post("/plan-usage", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return res.status(400).json({
        success: false,
        error: "BAD_INPUT",
        message: "email is required",
      });
    }

    const { checkPlanCap } = await import("./Utils/dailyCapGuard.js");
    const check = await checkPlanCap(email);

    return res.status(200).json({
      success: true,
      email,
      planType: check.planType || null,
      // cap === null means this client has no recognisable plan → uncapped.
      cap: check.cap,
      used: check.count,
      remaining: check.cap == null ? null : Math.max(0, check.cap - check.count),
      allowed: check.allowed,
      baseCap: check.baseCap,
      referralBonus: check.referralBonus,
      referralCount: check.referralCount,
      addonBonus: check.addonBonus,
      addonCount: check.addonCount,
      reason: check.reason || null,
      message: check.message || null,
    });
  } catch (error) {
    console.error("Error computing plan usage:", error.message);
    return res.status(500).json({
      success: false,
      error: "Server error",
      message: "Failed to compute plan usage",
    });
  }
});

// Profile routes
app.get("/get-profile", GetProfile);
app.post("/check-profile", CheckProfile);
app.post("/setprofile", LocalTokenValidator, ProfileCheck, Add_Update_Profile);
// AI candidate summary — written by JR-direct extension's "Build Summary"
// step. Persisted on the profile so every grading call reuses it.
app.post("/update-ai-summary", UpdateAiSummary);
// Server-side candidate brief builder. Consumers (JR-direct extension)
// just POST { email } — backend pulls profile + resume + calls OpenAI.
app.post("/build-ai-summary", BuildAiSummary);
// Poll target for the async build above — returns { status, builtAt,
// lastError, aiSummary, ... }. status: idle|building|done|error.
app.get("/ai-summary-status", AiSummaryStatus);
// Summary format overlay: operator-saved "format snapshot" so future rebuilds
// re-inject operator-added bullets. Save = enable + write snapshot.
// Clear = disable (snapshot retained). Get = read current state + stats.
app.post("/save-summary-overlay", SaveSummaryOverlay);
app.post("/clear-summary-overlay", ClearSummaryOverlay);
app.get("/summary-overlay", GetSummaryOverlay);
// Per-client "Notes to AI" — free-text operator guidance injected into every
// BuildAiSummary prompt as authoritative context.
app.post("/save-ai-notes", SaveAiNotes);
app.get("/ai-notes", GetAiNotes);
// Base resume structured JSON for the Documents → Base Resume preview.
// Proxies gemini-resume's /api/resume-by-email and reshapes into the
// same envelope ResumePreview already consumes for optimized resumes.
app.post("/get-base-resume-data", GetBaseResumeData);
// Per-client target job count — enforced by /addjob.
app.post("/update-target-jobs", UpdateTargetJobs);
app.post("/update-scrape-sources", UpdateScrapeSources);
app.post("/update-openai-key", UpdateOpenaiKey);
app.get("/admin/global-openai-key", GetGlobalOpenaiKey);
app.post("/admin/global-openai-key", SetGlobalOpenaiKey);
// Per-client daily push history — used by CT AI Summary tab "Push History" panel.
app.get("/push-history", PushHistory);
// One-shot aggregate for the admin AI Summaries page master list.
app.get("/summaries-overview", SummariesOverview);
app.post("/extension/session-stat", ExtensionSessionStatLog);
app.get("/admin/operator-activity", OperatorActivity);
app.get("/extension/today-stats", ExtensionTodayStats);
app.get("/extension/daily-history", ExtensionDailyHistory);
app.get("/admin/pricing-info", PricingInfo);
// Real AI spend for an IST day, by pipeline + model. Reconciles the Discord
// milestone embed against the OpenAI usage dashboard.
app.get("/admin/ai-cost", AiCostReport);
app.get("/admin/scrape-cost/history", ScrapeCostHistory);
app.post("/upload-profile-file", upload.single('file'), uploadProfileFile);

// Generic file upload routes (supports both Cloudinary and R2)
// No authentication required - trusted users only
app.post("/upload-file", uploadMiddleware.single('file'), uploadSingleFile);
app.post("/upload-base64", uploadBase64File);
app.post("/api/upload/onboarding-attachment", uploadMiddleware.single('file'), uploadOnboardingAttachment);

// Internal client upload routes (for clients-tracking service)
// These endpoints upload files and sync with ProfileModel/UserModel
app.post("/api/internal/upload-client-document", internalUpload.single('file'), uploadClientDocument);
app.get("/api/internal/client-documents/:email", getClientDocuments);
app.put("/api/internal/client-optimization/:email", updateClientOptimizationStatus);

// Image caching and proxy routes
app.get("/image-proxy", serveCachedImage);
// PDF proxy — serves documents with a friendly Content-Disposition filename so
// the inline PDF viewer's download button uses the client name, not the raw id.
app.get("/doc-proxy", serveDocProxy);
app.get("/cache-stats", getCacheStats);
app.post("/clear-cache", clearCache);


// Job routes (dashboard manual add + job board — same handler, duplicate + exclusion checks)
app.post("/addjob", CheckForDuplicateJobs, AddJob);
app.post("/api/jobs", CheckForDuplicateJobs, AddJob);
app.get("/getalljobs", LocalTokenValidator, GetAllJobs);
app.post("/getalljobs", GetAllJobs);
app.get("/get/prev24hourjobs", Get24HourJobs);
app.post("/storejobanduserdetails", StoreJobAndUserDetails);
app.put("/updatechanges", VerifyJobIDAndChanges, UpdateChanges);
app.post("/get-removal-reason", GetRemovalReason);
app.get("/ai-removed-jobs", GetAiRemovedJobs);
app.post("/second-judge-flag/resolve", ResolveSecondJudgeFlag);

// One-time data fix: reset appliedDate for Feb/March 2026 applied jobs to dateAdded + 1 day
app.post("/fix/applied", fixAppliedDates);

// Plan routes
app.post('/api/plans/select', PlanSelect);
app.post('/forgotpasswod', ForgotPassword)


app.post("/getJobDescription", GetJobDescription);
app.get("/getJobDescription/:id", GetJobDescriptionByUrl);
app.get("/testJobController/:id", testJobController);
app.post("/saveChangedSession", saveChangedSession);
app.post("/getJobById", getJobById);
app.get("/getOptimizedResume/:jobId", getOptimizedResume);
app.post("/getJobsWithOptimizedResumes", getJobsWithOptimizedResumes);
app.post("/getOptimizedResumesForDocuments", getOptimizedResumesForDocuments);

// Migration routes - for Postman use (no authentication required but should be secured in production)
app.post("/api/migrate-resume-data-to-r2", migrateResumeDataToR2);
app.get("/api/migration-status", getMigrationStatus);

// Auto-optimization monitoring
app.get("/api/auto-optimization/status", async (req, res) => {
  try {
    const worker = getWorkerStatus();
    const [pending, processing, completed, failed, skipped] = await Promise.all([
      AutoOptJobModel.countDocuments({ 'autoOptimization.status': 'pending' }),
      AutoOptJobModel.countDocuments({ 'autoOptimization.status': 'processing' }),
      AutoOptJobModel.countDocuments({ 'autoOptimization.status': 'completed' }),
      AutoOptJobModel.countDocuments({ 'autoOptimization.status': 'failed' }),
      AutoOptJobModel.countDocuments({ 'autoOptimization.status': 'skipped' }),
    ]);
    res.json({ worker, queue: { pending, processing, completed, failed, skipped } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark optimized resume as seen (operations clicks card)
app.patch("/api/jobs/:jobId/mark-resume-seen", async (req, res) => {
  try {
    const { jobId } = req.params;
    await AutoOptJobModel.findByIdAndUpdate(jobId, { $set: { optimizedResumeSeen: true } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// admin new dashboard routes
app.post("/admin/setBaseResume", updateBaseResume);
app.post("/admin/assignUserToOperations", assignUserToOperations);
app.get("/admin/operations", listOperations);
app.patch("/admin/operations/:opId", updateOperation);
app.delete("/admin/operations/:opId/managedUsers/:userId", removeManagedUser);
app.delete("/admin/operations/:opId", removeOperationUser);
app.get("/admin/list/users", listAllUsers);
app.get("/admin/list/operations", listAllOperations);
import UnassignResume from "./Controllers/Admin/UnassignResume.js";
import { resumeDownloaded } from "./Controllers/resumeController.js";


app.post("/admin/assign-resume-to-user", AssignResumeToUser); // keep existing
app.post("/admin/unassign-resume", UnassignResume); // add new

// operations routes
// app.post("/operations/getAllJobs", GetAllJobsOPS)
app.post("/operations/login", OperationsLogin);
app.post("/operations/register", OperationsRegister);
app.post("/operations/request-otp", requestDashboardOtp);
app.post("/operations/verify-otp", verifyDashboardOtp);
app.post("/operations/validate-otp-trust", validateOtpTrust);
app.post("/operations/verify-session-key", verifySessionKey);
app.post("/operations/getUserDetails", OperationsHandeling, GetUserDetails); // login does this for normal users
app.post("/operations/user-resumes", GetUserResumes);
app.post('/operations/alljobs', GetAllJobsOPS);

app.post("/operations/getalljobs", GetAllJobs);
app.post('/operations/jobs', AddJob);
app.put('/operations/jobs', VerifyJobIDAndChanges, UpdateChanges);
app.post('/operations/plans/select', PlanSelect);

// Client operations management routes
app.post('/operations/client-operations', getClientOperations);
app.put('/operations/client-operations', updateClientOperations);
app.post('/operations/reconcile-exclusion-jobs', reconcileExclusionJobsHandler);
app.post('/operations/check-lock-period', checkLockPeriod);
app.post('/operations/auto-optimize-saved', queueAutoOptimizeSavedJobs);

// Client Reminders — operator-configured recurring reports for one client.
//
// Operations picks which of the Utils/reminderItems.js catalogue items a client
// receives, on what IST schedule, and over which channels: the client's payment
// email (existing SMTP) and/or a client-specific Mattermost incoming webhook.
// src/services/clientReminderWorker.js does the actual delivery every five
// minutes; these routes only read and write the configuration, plus a preview
// and a manual "send now" that both run through that same worker code so what
// an operator approves is exactly what the schedule ships.
//
// Product rule enforced downstream in the worker: a period with zero jobs added
// AND zero applications submitted sends nothing at all. Silence beats an empty
// digest.
//
// Every route is gated by requireOpsKey (header `x-ops-key`), because they can
// email a paying client and post into their Mattermost channel.
// Unsubscribe. NO AUTH on purpose: the link has to work from an email client
// with no session, and the HMAC in it is the authorisation. GET serves a page
// for a human; POST is the one-click action Gmail and Yahoo perform on the
// user's behalf (RFC 8058). See Utils/unsubscribe.js.
app.get('/unsubscribe', Unsubscribe);
app.post('/unsubscribe', Unsubscribe);

app.post('/operations/reminders/get', requireOpsKey, getClientReminderConfig);
app.put('/operations/reminders', requireOpsKey, updateClientReminderConfig);
app.post('/operations/reminders/payment-email', requireOpsKey, setClientReminderPaymentEmail);
app.post('/operations/reminders/send-now', requireOpsKey, sendClientReminderNow);
app.post('/operations/reminders/test-mattermost', requireOpsKey, testClientReminderMattermost);
app.post('/operations/reminders/preview', requireOpsKey, previewClientReminder);
app.post('/operations/reminders/history', requireOpsKey, getClientReminderHistory);

//extensions
app.post('/extension/login', ExtensionLogin);
app.post('/extension/sendData', ReciveData);
app.post('/extension/extractJobData', extractJobData);
app.post('/extension/saveToDashboard', saveToDashboard);
app.post('/extension/exclusion-lists', getExtensionExclusionLists);
app.post('/extension/settings/get', getExtensionSettings);
app.post('/extension/settings/update', updateExtensionSettings);
app.post('/extension/clientLogin', ClientLogin);
app.get('/extension/profile', ExtensionAuth, extGetProfile);
app.patch('/extension/profile', ExtensionAuth, extPatchProfile);
// SpeedyApply autofill sync — save/load a client's profile so it restores on
// login from any machine. Auth is the clientLogin JWT (Bearer), verified inside.
app.get('/extension/speedyapply/profile', getSpeedyApplyProfile);
app.post('/extension/speedyapply/profile', saveSpeedyApplyProfile);
// Onboarding email sequence — manual trigger (runs backfill → detect → send-due).
// Safe to call: backfill guards against retro-emailing existing clients.
app.post('/admin/onboarding-mail/run-now', async (_req, res) => {
  try {
    const summary = await onboardingTick({ trigger: "manual" });
    res.json({ ok: !summary.error, ...summary });
  } catch (err) {
    res.status(500).json({ error: err?.message || "onboarding_run_failed" });
  }
});
// Per-client onboarding-mail state (résumé / cover letter / LinkedIn) + the
// manual send-now escape hatch. Read by the Onboarding Emails panel in
// clients-tracking → Client Onboarding → ticket modal.
app.get('/admin/onboarding-mail/status', OnboardingMailStatus);
app.post('/admin/onboarding-mail/send-step', SendOnboardingMailStep);
// Gemini (Vertex AI) judge slice — extension routes ~10-15% of judge
// batches here; OpenAI handles the rest in-worker.
app.post('/extension/gemini-judge', GeminiJudge);
// Backend-proxied gpt-4o-mini judge — extension fallback when Gemini fails.
// Keeps OPENAI_API_KEY out of the browser. Backend uses its own env key.
app.post('/extension/openai-judge', OpenAiJudge);
// Diagnostic: fire one canned judge batch through Vertex + report cred state.
// GET form for easy curl/browser use; POST also accepted for symmetry.
app.get('/test/gemini-for-scraping', GeminiForScrapingTest);
app.post('/test/gemini-for-scraping', GeminiForScrapingTest);

// Session management routes for admin dashboard
app.post('/api/sessions/generate-session-key', generateSessionKey);
app.get('/api/sessions/session-keys', listSessionKeys);
app.get('/api/sessions/active-sessions', listActiveSessions);
app.post('/api/sessions/revoke-session', revokeSession);
app.post('/api/sessions/revoke-user-sessions', revokeUserSessions);

// Extension code routes (operator tracking)
app.post('/api/extension-codes/generate', generateExtensionCode);
app.post('/api/extension-codes/verify', verifyExtensionCode);
app.get('/api/extension-codes', listExtensionCodes);

app.get("/admin/recruiter-groups", listGroups);
app.post("/admin/recruiter-groups", createGroup);
app.get("/admin/recruiter-groups/:id", getGroup);
app.put("/admin/recruiter-groups/:id", updateGroup);

// Activity Monitor — admin audit trail.
//   GET  /admin/activity         — cursor-paginated feed (Bearer + admin role)
//   GET  /admin/activity/facets  — filter dropdown values
//   POST /admin/activity/ingest  — cross-service ingestion (shared secret)
import { listActivity, listActivityFacets, ingestActivity } from "./Controllers/ActivityController.js";
// Read-only activity views — token gate removed per ops request. URL is
// only shared with trusted people; no auth middleware. Ingest stays gated.
app.get("/admin/activity", listActivity);
app.get("/admin/activity/facets", listActivityFacets);
app.post("/admin/activity/ingest", ingestActivity);

// IP → location administration. Everything the CLI scripts do, reachable from
// the deployed service (Render gives no shell). Unlike the read-only activity
// views above these MUTATE data and spend provider quota, so the admin token
// gate stays on.
//   GET    /admin/geo/status              resolver + cache health
//   GET    /admin/geo/top?limit=20        busiest IPs, flagged when shared
//   GET    /admin/geo/inspect/:ip         each provider's answer + the verdict
//   GET    /admin/geo/overrides           list pinned networks
//   POST   /admin/geo/overrides           pin / update one
//   DELETE /admin/geo/overrides/:cidr     unpin ("1.2.3.0-24" or "1.2.3.0/24")
//   POST   /admin/geo/backfill            start an async backfill job
//   GET    /admin/geo/backfill            job progress
//   DELETE /admin/geo/backfill            cancel the running job
import { verifyAdminForActivity } from "./Controllers/ActivityController.js";
import {
  geoStatus, geoTop, geoInspect,
  listOverrides, upsertOverride, deleteOverride,
  startBackfill, backfillStatus, cancelBackfill,
} from "./Controllers/GeoController.js";
app.get("/admin/geo/status", verifyAdminForActivity, geoStatus);
app.get("/admin/geo/top", verifyAdminForActivity, geoTop);
app.get("/admin/geo/inspect/:ip", verifyAdminForActivity, geoInspect);
app.get("/admin/geo/overrides", verifyAdminForActivity, listOverrides);
app.post("/admin/geo/overrides", verifyAdminForActivity, upsertOverride);
app.delete("/admin/geo/overrides/:cidr", verifyAdminForActivity, deleteOverride);
app.post("/admin/geo/backfill", verifyAdminForActivity, startBackfill);
app.get("/admin/geo/backfill", verifyAdminForActivity, backfillStatus);
app.delete("/admin/geo/backfill", verifyAdminForActivity, cancelBackfill);

app.use("/gmail", gmailRouter);
app.use("/gmail/inbox", gmailInboxRouter);
app.post("/gmail/automation/template/ai-generate", aiGenerateTemplateHandler);

app.get("/api/whatsapp/groups", getWhatsAppGroups);
app.post("/api/whatsapp/link-user", linkUserToGroup);
app.post("/api/whatsapp/user-mapping", getUserGroupMapping);
app.post("/api/whatsapp/send-notification", sendCustomNotification);
app.post("/api/whatsapp/check-cooldown", checkNotificationCooldown);

// Dashboard Manager routes
app.get('/dashboard-managers', getDashboardManagers);
app.get('/dashboard-managers/:name', getDashboardManagerByName);
app.get('/flash-fill', async (req, res) => {
  try {
    let profiles = await ProfileModel.find().lean();
    res.status(200).json(profiles);
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Internal server error" });
  }

})

app.post("/downloaded", resumeDownloaded);

//AI optimizer routes
// app.post("/saveChangedSession", saveChangedSession);

export default app;


