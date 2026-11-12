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

import { UserModel } from "../../Schema_Models/UserModel.js";
import { ProfileModel } from "../../Schema_Models/ProfileModel.js";
import { SpeedyApplyProfile } from "../../Schema_Models/SpeedyApplyProfile.js";
import { JobModel } from "../../Schema_Models/JobModel.js";
import { recordAiUsage, AI_USAGE_SOURCES } from "../../Utils/aiUsage.js";
import { applicationPageLinkKeys } from "../../Utils/jobLinkKey.js";
import { loadOptimizedResumeData } from "../../Utils/optimizedResumeData.js";
import { createLoginLimiter } from "../../Utils/speedyApplyAccess.js";
import {
  assembleLetter,
  buildContact,
  buildCoverLetterCandidate,
  buildCoverLetterMessages,
  isExecutivePlan,
  parseCoverLetterInput,
  parseCoverLetterOutput,
} from "../../Utils/speedyApplyCoverLetterWriter.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const TEMPERATURE = 0.5;
const MAX_TOKENS = 1000;
const TIMEOUT_MS = 30000;
const ATTEMPTS = 2; // one retry, only for unusable output

// One letter per application; 20 in 10 minutes is far above a person applying
// and low enough that a stuck retry loop cannot run up the bill. In memory,
// per PM2 process, reset on restart.
const writes = createLoginLimiter({ max: 20, windowMs: 10 * 60 * 1000 });

const openAiKey = () => String(process.env.auto_fill_chatgpt_API || "").trim();
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const fail = (res, status, error, message) => res.status(status).json({ ok: false, error, message });

class UpstreamError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// The account as typed at signup can differ in case from the lowercased email
// in the SpeedyApply token, and jobs and profiles are filed under that one.
async function loadUser(email) {
  const fields = "name email planType";
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

async function callOpenAi(apiKey, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(OPENAI_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        response_format: { type: "json_object" },
      }),
    });
  } catch (err) {
    if (err?.name === "AbortError") throw new UpstreamError(504, "timeout", "The AI took too long to write the letter. Try again.");
    console.warn("[speedyapply-cl-writer] OpenAI request failed:", err?.message || err);
    throw new UpstreamError(502, "network", "Could not reach the AI service. Try again in a minute.");
  } finally {
    clearTimeout(timer);
  }
  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => "");
    console.warn(`[speedyapply-cl-writer] OpenAI ${upstream.status}:`, txt.slice(0, 300));
    throw new UpstreamError(502, `openai_${upstream.status}`, `The AI service returned an error (${upstream.status}). Try again in a minute.`);
  }
  const data = await upstream.json().catch(() => null);
  recordAiUsage({ source: AI_USAGE_SOURCES.SPEEDYAPPLY_COVER_LETTER, model: data?.model || MODEL, usage: data?.usage });
  return { content: data?.choices?.[0]?.message?.content, model: data?.model || MODEL };
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

    const apiKey = openAiKey();
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
    const [sa, dash, jobCard] = await Promise.all([
      SpeedyApplyProfile.findOne({ clientEmail: email }).select("profile").lean(),
      ProfileModel.findOne({ email: { $in: emails } })
        .select("firstName lastName email contactEmail contactNumber address yearsOfExperience preferredRoles bachelorsUniDegree mastersUniDegree aiSummary")
        .lean(),
      findOptimizedJob(emails, job.url),
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

    let model = MODEL;
    let result = null;
    let retryReason = "";
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const messages = buildCoverLetterMessages({ job, candidate, retryReason });
      const reply = await callOpenAi(apiKey, messages);
      model = reply.model;
      result = parseCoverLetterOutput(reply.content, { name: contact.name });
      if (result.ok) break;
      retryReason = result.reason;
      console.warn(`[speedyapply-cl-writer] unusable output on attempt ${attempt}: ${result.reason}`);
    }
    if (!result?.ok) return fail(res, 502, "bad_output", "The AI did not return a usable letter. Try again.");

    res.set("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      letter: assembleLetter(contact, result.paragraphs),
      company: job.company,
      jobTitle: job.title,
      model,
      durationMs: Date.now() - startedAt,
      source: candidate.source,
    });
  } catch (err) {
    if (err instanceof UpstreamError) return fail(res, err.status, err.code, err.message);
    console.error("[speedyapply-cl-writer] handler error:", err?.message || err);
    return fail(res, 500, "server_error", "Could not write the cover letter. Try again.");
  }
}
