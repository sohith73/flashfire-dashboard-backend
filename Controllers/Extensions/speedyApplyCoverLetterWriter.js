// SpeedyApply: write a one-page cover letter for the job on the page.
//
//   POST /extension/speedyapply/cover-letters/generate   (SpeedyApplyAuth)
//        body { job: { title, company, description, url } }
//        200 { ok, letter: { name, phone, email, location, salutation,
//              paragraphs[], closing, signature }, company, jobTitle, model,
//              durationMs, source: "optimized_resume" | "base_profile" }
//        400 job_required · 403 not_executive · 429 rate_limited
//        503 no_openai_key · 504 timeout · 502 openai_<status> / network /
//        bad_output · 500 server_error. Errors are { ok:false, error, message }.
//
// Executive plan only. gpt-4o-mini writes the body paragraphs; the header,
// salutation, closing and signature come from the database, so the model never
// touches the client's name or contact details. The extension renders the PDF.
//
// Candidate data: when the page URL matches one of this client's job cards
// that has an optimized resume, that resume is used (it is already tailored
// to the posting). Otherwise the SpeedyApply profile plus the dashboard
// aiSummary. The OpenAI key is the backend env var `auto_fill_chatgpt_API`.
//
// Voice reference: the base letter an operator saved in the Operations tab
// (R2, Utils/baseCoverLetter.js) wins, and switches the prompt to the "tailor
// the approved base letter" mode. Without one (or when R2 cannot be read) the
// SpeedyApply profile's defaultCoverLetter is the reference, as before.

import { UserModel } from "../../Schema_Models/UserModel.js";
import { ProfileModel } from "../../Schema_Models/ProfileModel.js";
import { SpeedyApplyProfile } from "../../Schema_Models/SpeedyApplyProfile.js";
import { JobModel } from "../../Schema_Models/JobModel.js";
import { AI_USAGE_SOURCES } from "../../Utils/aiUsage.js";
import { applicationPageLinkKeys } from "../../Utils/jobLinkKey.js";
import { loadOptimizedResumeData } from "../../Utils/optimizedResumeData.js";
import { createLoginLimiter } from "../../Utils/speedyApplyAccess.js";
import {
  assembleLetter,
  buildContact,
  buildCoverLetterCandidate,
  buildCoverLetterMessages,
  buildTailorMessages,
  isExecutivePlan,
  parseCoverLetterInput,
} from "../../Utils/speedyApplyCoverLetterWriter.js";
import {
  CoverLetterUpstreamError,
  coverLetterOpenAiKey,
  writeCoverLetterParagraphs,
} from "../../Utils/coverLetterOpenAi.js";
import { loadBaseLetterText } from "../../Utils/baseCoverLetter.js";

// One letter per application; 20 in 10 minutes is far above a person applying
// and low enough that a stuck retry loop cannot run up the bill. In memory,
// per PM2 process, reset on restart.
const writes = createLoginLimiter({ max: 20, windowMs: 10 * 60 * 1000 });

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const fail = (res, status, error, message) => res.status(status).json({ ok: false, error, message });

// The account as typed at signup can differ in case from the lowercased email
// in the SpeedyApply token, and jobs and profiles are filed under that one.
async function loadUser(email) {
  const fields = "name email planType baseCoverLetter";
  return (
    (await UserModel.findOne({ email }).select(fields).lean()) ||
    (await UserModel.findOne({ email: { $regex: new RegExp(`^${escapeRegex(email)}$`, "i") } }).select(fields).lean())
  );
}

// The job card saved for this page, when it has an optimized resume.
async function findOptimizedJob(emails, pageUrl) {
  const keys = pageUrl ? applicationPageLinkKeys(pageUrl) : [];
  if (!keys.length) return null;
  return JobModel.findOne({ userID: { $in: emails }, "optimizedResume.hasResume": true, joblinkKey: { $in: keys } })
    .select("jobTitle companyName optimizedResume")
    .sort({ _id: -1 })
    .lean();
}

async function loadOptimizedResume(job) {
  if (!job) return null;
  try {
    const loaded = await loadOptimizedResumeData(job.optimizedResume);
    if (loaded.ok) return loaded.data;
    console.warn(`[speedyapply-cl-writer] optimized resume ${loaded.reason} for job ${job._id}, using the base profile`);
  } catch (err) {
    console.warn(`[speedyapply-cl-writer] optimized resume load failed for job ${job._id}, using the base profile:`, err?.message || err);
  }
  return null;
}

// The operator-approved base letter from R2, or "" (none saved, or storage
// down: the writer then falls back to the profile's defaultCoverLetter).
async function loadApprovedBaseLetter(user) {
  if (!user?.baseCoverLetter?.key) return "";
  try {
    const loaded = await loadBaseLetterText(user.baseCoverLetter);
    if (loaded.ok) return loaded.text;
    console.warn(`[speedyapply-cl-writer] base letter ${loaded.reason} for ${user.email}, using the profile letter`);
  } catch (err) {
    console.warn(`[speedyapply-cl-writer] base letter load failed for ${user.email}, using the profile letter:`, err?.message || err);
  }
  return "";
}

// POST /extension/speedyapply/cover-letters/generate
export async function generateSpeedyApplyCoverLetter(req, res) {
  const startedAt = Date.now();
  const email = req.speedyApplyEmail;
  if (!email) return fail(res, 401, "unauthorized", "Sign in to SpeedyApply again.");
  try {
    const input = parseCoverLetterInput(req.body);
    if (!input.ok) return fail(res, 400, input.error, "Open the job posting first, so the letter can be written for that job.");
    const job = { ...input.value.job };

    const user = await loadUser(email);
    if (!isExecutivePlan(user?.planType)) {
      return fail(res, 403, "not_executive", "AI cover letters are part of the Executive plan.");
    }

    const apiKey = coverLetterOpenAiKey();
    if (!apiKey) return fail(res, 503, "no_openai_key", "Cover letter writing is not set up on the server yet.");

    const wait = writes.check(email);
    if (wait) {
      res.set("Retry-After", String(wait));
      return res.status(429).json({
        ok: false,
        error: "rate_limited",
        retryAfter: wait,
        message: `Too many cover letters in a short time. Try again in ${Math.ceil(wait / 60)} min.`,
      });
    }
    writes.fail(email); // records the request; the limiter counts any event

    const emails = [...new Set([email, user?.email].filter(Boolean))];
    const [sa, dash, jobCard, approvedBase] = await Promise.all([
      SpeedyApplyProfile.findOne({ clientEmail: email }).select("profile").lean(),
      ProfileModel.findOne({ email: { $in: emails } })
        .select("firstName lastName email contactEmail contactNumber address yearsOfExperience preferredRoles bachelorsUniDegree mastersUniDegree aiSummary")
        .lean(),
      findOptimizedJob(emails, job.url),
      loadApprovedBaseLetter(user),
    ]);
    const saProfile = sa?.profile && typeof sa.profile === "object" ? sa.profile : null;
    const optimizedResumeData = await loadOptimizedResume(jobCard);

    // The job card knows the title and company when the page did not show them.
    if (jobCard) {
      if (!job.title) job.title = String(jobCard.jobTitle || "").slice(0, 200);
      if (!job.company) job.company = String(jobCard.companyName || "").slice(0, 200);
    }

    const contact = buildContact({ saProfile, dash, user });
    const candidate = buildCoverLetterCandidate({ optimizedResumeData, saProfile, dash });

    const result = await writeCoverLetterParagraphs({
      apiKey,
      name: contact.name,
      source: AI_USAGE_SOURCES.SPEEDYAPPLY_COVER_LETTER,
      logTag: "[speedyapply-cl-writer]",
      buildMessages: (retryReason) =>
        approvedBase
          ? buildTailorMessages({ job, candidate, baseLetter: approvedBase, retryReason })
          : buildCoverLetterMessages({ job, candidate, retryReason }),
    });
    if (!result.ok) return fail(res, 502, "bad_output", "The AI did not return a usable letter. Try again.");

    res.set("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      letter: assembleLetter(contact, result.paragraphs),
      company: job.company,
      jobTitle: job.title,
      model: result.model,
      durationMs: Date.now() - startedAt,
      source: candidate.source,
    });
  } catch (err) {
    if (err instanceof CoverLetterUpstreamError) return fail(res, err.status, err.code, err.message);
    console.error("[speedyapply-cl-writer] handler error:", err?.message || err);
    return fail(res, 500, "server_error", "Could not write the cover letter. Try again.");
  }
}
