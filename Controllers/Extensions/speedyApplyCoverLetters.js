// SpeedyApply: attach the client's cover letter to the cover letter slot.
//
//   GET /extension/speedyapply/cover-letters?url=
//       { ok, plan, coverLetters: [{ id, name, companyName, jobRole, jobLink,
//         createdAt, source }], suggested }
//       `suggested` is the id to use on `url`: the one saved for that posting,
//       else the newest general one. Newest first. URLs never leave the server.
//   GET /extension/speedyapply/cover-letters/:id/file
//       That file exactly as uploaded (PDF, or Word for old uploads). It is not
//       rebuilt through the PDF server: a cover letter is a finished document.
//
// Both run behind SpeedyApplyAuth. The owner is req.speedyApplyEmail, and the
// id is looked up inside that client's own list, so another client's id is a
// plain 404. See Utils/coverLetterFile.js for where the files live and which
// hosts are read.

import { UserModel } from "../../Schema_Models/UserModel.js";
import { ProfileModel } from "../../Schema_Models/ProfileModel.js";
import { applicationPageLinkKeys } from "../../Utils/jobLinkKey.js";
import {
  chooseCoverLetter,
  collectCoverLetters,
  coverLetterFilename,
  CoverLetterFetchError,
  downloadCoverLetter,
  publicCoverLetter,
} from "../../Utils/coverLetterFile.js";
import { getObjectFromR2 } from "../../Utils/r2Storage.js";
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
  const fields = "email planType coverLetters";
  const user =
    (await UserModel.findOne({ email }).select(fields).lean()) ||
    (await UserModel.findOne({ email: { $regex: new RegExp(`^${escapeRegex(email)}$`, "i") } }).select(fields).lean());
  const emails = [...new Set([email, user?.email].filter(Boolean))];
  const profile = await ProfileModel.findOne({ email: { $in: emails } }).select("coverLetterUrl updatedAt createdAt").lean();
  return { user, list: collectCoverLetters(user, profile) };
}

// GET /extension/speedyapply/cover-letters
export async function listSpeedyApplyCoverLetters(req, res) {
  const email = req.speedyApplyEmail;
  if (!email) return res.status(401).json({ error: "unauthorized" });
  const pageUrl = String(req.query.url || "").slice(0, 2000);
  try {
    const { user, list } = await loadClient(email);
    const { choice, matched } = chooseCoverLetter(list, pageUrl ? applicationPageLinkKeys(pageUrl) : []);
    res.set("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      plan: user?.planType || null,
      coverLetters: list.map(publicCoverLetter),
      suggested: choice ? { id: choice.id, matched } : null,
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
