// SpeedyApply: attach the client's cover letter to the cover letter slot.
//
//   GET /extension/speedyapply/cover-letters?url=
//       { ok, plan, coverLetters: [{ id, name, companyName, jobRole, jobLink,
//         createdAt, source }], suggested }
//       `suggested` is the id to use on `url`: the one saved for that posting,
//       else the newest general one. Newest first. URLs never leave the server.
//       Also `optimized`: { id: "job:<jobCardId>", jobId, companyName, jobRole,
//       createdAt } | null, the job card saved for `url` that has a cover letter
//       written by the queue (Utils/coverLetterAutoWriter.js), and `baseLetter`:
//       whether the client has a base letter in the Operations tab.
//   GET /extension/speedyapply/cover-letters/:id/file
//       That file exactly as uploaded (PDF, or Word for old uploads). It is not
//       rebuilt through the PDF server: a cover letter is a finished document.
//   GET /extension/speedyapply/cover-letters/job/:jobId
//       That job card's written letter as text: { ok, letter: { name, phone,
//       email, location, salutation, paragraphs[], closing, signature },
//       company, jobTitle, createdAt }. The extension builds the PDF.
//       404 not_found (not this client's card, or no letter) · 502 storage.
//
// Both run behind SpeedyApplyAuth. The owner is req.speedyApplyEmail, and the
// id is looked up inside that client's own list, so another client's id is a
// plain 404. See Utils/coverLetterFile.js for where the files live and which
// hosts are read.

import { UserModel } from "../../Schema_Models/UserModel.js";
import { ProfileModel } from "../../Schema_Models/ProfileModel.js";
import { JobModel } from "../../Schema_Models/JobModel.js";
import { SpeedyApplyProfile } from "../../Schema_Models/SpeedyApplyProfile.js";
import { applicationPageLinkKeys } from "../../Utils/jobLinkKey.js";
import {
  chooseCoverLetter,
  collectCoverLetters,
  coverLetterFilename,
  CoverLetterFetchError,
  downloadCoverLetter,
  publicCoverLetter,
} from "../../Utils/coverLetterFile.js";
import { getJSONFromR2, getObjectFromR2 } from "../../Utils/r2Storage.js";
import { jobOwnedBy, optimizedLetterItem, servedLetterBody } from "../../Utils/baseCoverLetter.js";
import { buildContact } from "../../Utils/speedyApplyCoverLetterWriter.js";
import { createLoginLimiter } from "../../Utils/speedyApplyAccess.js";

// Every Autofill on a form with a cover letter slot downloads the file once,
// so this sits well above a person applying and well below a scraper.
const downloads = createLoginLimiter({ max: 120, windowMs: 10 * 60 * 1000 });

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function r2PublicHost() {
  try {
    return process.env.R2_PUBLIC_URL ? new URL(process.env.R2_PUBLIC_URL).host : "";
  } catch {
    return "";
  }
}

// The account as typed at signup can differ in case from the lowercased email
// in the SpeedyApply token.
async function loadClient(email) {
  const fields = "email planType coverLetters baseCoverLetter";
  const user =
    (await UserModel.findOne({ email }).select(fields).lean()) ||
    (await UserModel.findOne({ email: { $regex: new RegExp(`^${escapeRegex(email)}$`, "i") } }).select(fields).lean());
  const emails = [...new Set([email, user?.email].filter(Boolean))];
  const profile = await ProfileModel.findOne({ email: { $in: emails } }).select("coverLetterUrl updatedAt createdAt").lean();
  return { user, emails, list: collectCoverLetters(user, profile) };
}

// The newest job card saved for this page that has a queue-written letter.
async function findOptimizedLetter(emails, pageKeys) {
  if (!pageKeys.length) return null;
  const job = await JobModel.findOne({
    userID: { $in: emails },
    "optimizedCoverLetter.hasLetter": true,
    joblinkKey: { $in: pageKeys },
  })
    .select("jobTitle companyName optimizedCoverLetter")
    .sort({ _id: -1 })
    .lean();
  return optimizedLetterItem(job);
}

// GET /extension/speedyapply/cover-letters
export async function listSpeedyApplyCoverLetters(req, res) {
  const email = req.speedyApplyEmail;
  if (!email) return res.status(401).json({ error: "unauthorized" });
  const pageUrl = String(req.query.url || "").slice(0, 2000);
  try {
    const { user, emails, list } = await loadClient(email);
    const pageKeys = pageUrl ? applicationPageLinkKeys(pageUrl) : [];
    const { choice, matched } = chooseCoverLetter(list, pageKeys);
    const optimized = await findOptimizedLetter(emails, pageKeys);
    res.set("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      plan: user?.planType || null,
      coverLetters: list.map(publicCoverLetter),
      suggested: choice ? { id: choice.id, matched } : null,
      optimized,
      baseLetter: !!user?.baseCoverLetter?.key,
    });
  } catch (err) {
    console.error("[speedyapply-cover] list failed:", err?.message || err);
    return res.status(500).json({ error: "list_failed", message: "Could not load the cover letters. Try again." });
  }
}

const FETCH_STATUS = { blocked: 422, not_a_document: 422, too_large: 413, unreachable: 502, storage: 502 };

// GET /extension/speedyapply/cover-letters/:id/file
export async function getSpeedyApplyCoverLetterFile(req, res) {
  const email = req.speedyApplyEmail;
  if (!email) return res.status(401).json({ error: "unauthorized" });
  const id = String(req.params.id || "");
  if (!/^[0-9a-f]{16}$/.test(id)) {
    return res.status(400).json({ error: "bad_id", message: "That is not a cover letter id." });
  }
  try {
    const { list } = await loadClient(email);
    const entry = list.find((c) => c.id === id);
    if (!entry) {
      return res.status(404).json({ error: "not_found", message: "That cover letter is no longer on the dashboard." });
    }
    const wait = downloads.check(email);
    if (wait) {
      res.set("Retry-After", String(wait));
      return res.status(429).json({ error: "rate_limited", retryAfter: wait, message: `Too many downloads. Try again in ${Math.ceil(wait / 60)} min.` });
    }
    downloads.fail(email); // records the download; the limiter counts any event

    const file = await downloadCoverLetter(entry.url, { getR2Object: getObjectFromR2, r2PublicHost: r2PublicHost() });
    res.set({
      "Content-Type": file.mimeType,
      "Content-Disposition": `attachment; filename="${coverLetterFilename(entry.name, file.ext)}"`,
      "Cache-Control": "private, no-store",
    });
    return res.status(200).send(file.buffer);
  } catch (err) {
    if (err instanceof CoverLetterFetchError) {
      console.error(`[speedyapply-cover] ${err.code} for ${id}: ${err.message}`);
      return res.status(FETCH_STATUS[err.code] || 502).json({ error: err.code, message: err.message });
    }
    console.error(`[speedyapply-cover] file ${id} failed:`, err?.message || err);
    return res.status(500).json({ error: "download_failed", message: "Could not load the cover letter." });
  }
}

const notFound = (res) =>
  res.status(404).json({ ok: false, error: "not_found", message: "This job card has no cover letter yet." });

// GET /extension/speedyapply/cover-letters/job/:jobId
export async function getSpeedyApplyJobCoverLetter(req, res) {
  const email = req.speedyApplyEmail;
  if (!email) return res.status(401).json({ ok: false, error: "unauthorized", message: "Sign in to SpeedyApply again." });
  const jobId = String(req.params.jobId || "");
  // Not an id at all is the same answer as someone else's id.
  if (!/^[0-9a-f]{24}$/i.test(jobId)) return notFound(res);
  try {
    const job = await JobModel.findOne({ _id: jobId })
      .select("userID jobTitle companyName optimizedCoverLetter")
      .lean();
    if (!job || !job.optimizedCoverLetter?.hasLetter || !job.optimizedCoverLetter?.dataKey) return notFound(res);

    const fields = "name email planType";
    const user =
      (await UserModel.findOne({ email }).select(fields).lean()) ||
      (await UserModel.findOne({ email: { $regex: new RegExp(`^${escapeRegex(email)}$`, "i") } }).select(fields).lean());
    const emails = [...new Set([email, user?.email].filter(Boolean))];
    if (!jobOwnedBy(job, emails)) return notFound(res);

    const [stored, sa, dash] = await Promise.all([
      getJSONFromR2(job.optimizedCoverLetter.dataKey),
      SpeedyApplyProfile.findOne({ clientEmail: email }).select("profile").lean(),
      ProfileModel.findOne({ email: { $in: emails } })
        .select("firstName lastName email contactEmail contactNumber address")
        .lean(),
    ]);
    if (!stored?.success) {
      console.error(`[speedyapply-cover] letter JSON for job ${jobId} not readable: ${stored?.error || "unknown"}`);
      return res.status(502).json({ ok: false, error: "storage", message: "Could not read the cover letter from storage. Try again." });
    }
    const saProfile = sa?.profile && typeof sa.profile === "object" ? sa.profile : null;
    const body = servedLetterBody({ stored: stored.data, job, contact: buildContact({ saProfile, dash, user }) });
    if (!body) {
      console.error(`[speedyapply-cover] letter JSON for job ${jobId} has no paragraphs`);
      return res.status(502).json({ ok: false, error: "storage", message: "The saved cover letter could not be read. Use the writer for this job instead." });
    }
    res.set("Cache-Control", "no-store");
    return res.status(200).json(body);
  } catch (err) {
    console.error(`[speedyapply-cover] job letter ${jobId} failed:`, err?.message || err);
    return res.status(500).json({ ok: false, error: "server_error", message: "Could not load the cover letter." });
  }
}
