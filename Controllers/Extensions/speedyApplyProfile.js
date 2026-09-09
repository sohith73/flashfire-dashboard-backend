// SpeedyApply profile sync — save + load a client's autofill data, keyed by the
// client identified in the JWT that /extension/clientLogin issued.
//
// Auth: the extension sends the login token as `Authorization: Bearer <jwt>`.
// The JWT payload is { email }, signed with JWT_SECRET (see clientLogin.js). We
// verify it and use that email as the owner — a client can only ever read/write
// their own SpeedyApply data, regardless of any email in the body.
//
// Synced payloads: profile, settings, resume, tracker, learned, apiKey. Every
// one of them is optional on write; only the keys actually present in the body
// are touched, so a settings-only save never wipes the stored profile.

import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { SpeedyApplyProfile } from "../../Schema_Models/SpeedyApplyProfile.js";
import { ProfileModel } from "../../Schema_Models/ProfileModel.js";
import { UserModel } from "../../Schema_Models/UserModel.js";
import { uploadFile } from "../../Utils/storageService.js";
import { getPresignedUrl } from "../../Utils/r2Storage.js";
import { encrypt, decrypt } from "../../Utils/CryptoHelper.js";
import { buildSeedProfile, mergeSeed } from "../../Utils/speedyApplySeed.js";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

// Hard cap on the stored tracker so one client can never grow the document
// toward Mongo's 16 MB ceiling. Entries arrive newest-first from the extension.
const TRACKER_MAX = 2000;
// Same idea for learned aliases — the extension caps at 250, this is the backstop.
const LEARNED_MAX = 1000;

const sanitize = (s) => String(s || "").replace(/[^a-z0-9._-]/gi, "_");

// ---- Gemini key at rest -----------------------------------------------------
// The key is a real credential, so it is AES-encrypted before it touches the DB.
// If the crypto env is misconfigured we fall back to plaintext rather than
// losing the client's key — the failure is logged loudly instead.

function encryptApiKey(plain) {
  const key = String(plain || "");
  if (!key) return { apiKeyEnc: "", apiKey: "" };
  try {
    return { apiKeyEnc: encrypt(key), apiKey: "" };
  } catch (e) {
    console.error("[speedyapply] apiKey encryption failed, storing plaintext:", e?.message || e);
    return { apiKeyEnc: "", apiKey: key };
  }
}

function decryptApiKey(doc) {
  if (doc?.apiKeyEnc) {
    try {
      return decrypt(doc.apiKeyEnc);
    } catch (e) {
      console.error("[speedyapply] apiKey decryption failed:", e?.message || e);
      return "";
    }
  }
  return doc?.apiKey || ""; // legacy plaintext row
}

// storeResume: given the resume payload the extension sends, upload its bytes to
// R2 and return the LIGHT metadata to persist (name, size, mimeType, r2Key) —
// never the base64. If R2 fails, fall back to keeping the base64 inline so the
// client never loses their resume. A metadata-only payload (already has r2Key,
// no base64) is stored unchanged.
async function storeResume(resume, email) {
  if (!resume || typeof resume !== "object") return resume;
  const base64 = typeof resume.base64 === "string" ? resume.base64 : "";
  if (!base64) return resume; // nothing new to upload (metadata-only re-save)

  try {
    const buffer = Buffer.from(base64, "base64");
    const result = await uploadFile(buffer, {
      folder: "speedyapply/resumes",
      filename: resume.name || "resume.pdf",
      contentType: resume.mimeType || "application/pdf",
      clientName: sanitize(email),
      fileType: "resume"
    });
    if (result?.key) {
      return { name: resume.name || "resume.pdf", size: resume.size || buffer.length, mimeType: resume.mimeType || "application/pdf", r2Key: result.key };
    }
    console.warn("[speedyapply] R2 upload returned no key; keeping base64 inline");
    return resume;
  } catch (e) {
    console.error("[speedyapply] R2 resume upload failed, keeping base64 inline:", e?.message || e);
    return resume; // resilient fallback
  }
}

// withResumeUrl: attach a fresh presigned download URL when the resume lives in
// R2. getPresignedUrl returns { success, url } (not a bare string), so extract
// the string; tolerate a plain string too in case that ever changes.
async function withResumeUrl(resume) {
  if (!resume || !resume.r2Key) return resume || null;
  try {
    const result = await getPresignedUrl(resume.r2Key, 3600);
    const url = typeof result === "string" ? result : result?.url;
    return url ? { ...resume, url } : resume;
  } catch (e) {
    console.warn("[speedyapply] presign failed:", e?.message || e);
    return resume;
  }
}

// clientEmailFromReq: pull + verify the Bearer token, return the lowercased
// email, or null when the token is missing/invalid/expired.
function clientEmailFromReq(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const email = String(payload?.email || "").toLowerCase().trim();
    return email || null;
  } catch {
    return null;
  }
}

// Trim the learned-alias map to the most recently seen LEARNED_MAX entries.
// shared/learning.js writes `lastSeen` as a numeric epoch-ms timestamp; the ISO
// fallbacks are only there in case that shape ever changes.
function capLearned(learned) {
  if (!learned || typeof learned !== "object") return learned;
  const keys = Object.keys(learned);
  if (keys.length <= LEARNED_MAX) return learned;
  const stamp = (v) => {
    const raw = v?.lastSeen ?? v?.lastUsed ?? v?.updatedAt;
    if (typeof raw === "number") return raw;
    return Date.parse(raw || 0) || 0;
  };
  const ranked = keys.sort((a, b) => stamp(learned[b]) - stamp(learned[a]));
  const out = {};
  for (const k of ranked.slice(0, LEARNED_MAX)) out[k] = learned[k];
  return out;
}

// seedFromDashboard: fill the gaps in the client's stored extension profile
// from their FlashFire dashboard profile.
//
// Without this, a client who has already given FlashFire their address, phone,
// visa status and degrees signs into the extension and is asked to type all of
// it again — and autofill leaves required fields like "Address Line 1" and
// "School" blank on real applications because the extension has no value for
// them. Only keys the stored extension profile leaves EMPTY are filled, so a
// client's own edits are never overwritten. See Utils/speedyApplySeed.js.
//
// Never throws: a seeding failure must not take down profile loading.
async function seedFromDashboard(email, storedProfile) {
  try {
    const [dash, user] = await Promise.all([
      ProfileModel.findOne({ email }).lean(),
      UserModel.findOne({ email }).select("name email").lean(),
    ]);
    if (!dash) return { profile: storedProfile || null, seededFields: [] };
    const seed = buildSeedProfile(dash, user);
    return mergeSeed(storedProfile, seed);
  } catch (e) {
    console.warn("[speedyapply] dashboard seed skipped:", e?.message || e);
    return { profile: storedProfile || null, seededFields: [] };
  }
}

// GET /extension/speedyapply/profile
// Returns the saved blobs (or nulls when the client has never saved).
export async function getSpeedyApplyProfile(req, res) {
  const email = clientEmailFromReq(req);
  if (!email) return res.status(401).json({ error: "unauthorized" });

  try {
    const doc = await SpeedyApplyProfile.findOne({ clientEmail: email }).lean();
    const { profile, seededFields } = await seedFromDashboard(email, doc?.profile || null);
    return res.status(200).json({
      ok: true,
      email,
      exists: !!doc,
      profile: profile || null,
      // Which keys came from the dashboard profile rather than from the
      // client's own extension edits. The extension merges these locally
      // instead of treating the response as authoritative.
      seededFields,
      settings: doc?.settings || null,
      resume: await withResumeUrl(doc?.resume || null),
      tracker: Array.isArray(doc?.tracker) ? doc.tracker : null,
      learned: doc?.learned || null,
      apiKey: decryptApiKey(doc),
      updatedAt: doc?.updatedAt || null
    });
  } catch (err) {
    console.error("[speedyapply] load error:", err?.message || err);
    return res.status(500).json({ error: "load_failed" });
  }
}

// POST /extension/speedyapply/profile
// Body: { profile?, settings?, resume?, tracker?, learned?, apiKey? } — any
// subset. Only the provided keys are written, so a settings-only save never
// wipes the stored profile/resume.
export async function saveSpeedyApplyProfile(req, res) {
  const email = clientEmailFromReq(req);
  if (!email) return res.status(401).json({ error: "unauthorized" });

  const { profile, settings, resume, tracker, learned, apiKey } = req.body || {};
  const provided = [profile, settings, resume, tracker, learned, apiKey].some((v) => v !== undefined);
  if (!provided) return res.status(400).json({ error: "nothing_to_save" });

  const set = { clientEmail: email, updatedAt: new Date() };
  if (profile !== undefined) set.profile = profile;
  if (settings !== undefined) set.settings = settings;
  if (resume !== undefined) set.resume = resume === null ? null : await storeResume(resume, email);
  if (tracker !== undefined) set.tracker = Array.isArray(tracker) ? tracker.slice(0, TRACKER_MAX) : [];
  if (learned !== undefined) set.learned = capLearned(learned);
  if (apiKey !== undefined) Object.assign(set, encryptApiKey(apiKey));

  try {
    const doc = await SpeedyApplyProfile.findOneAndUpdate(
      { clientEmail: email },
      { $set: set },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    return res.status(200).json({ ok: true, email, updatedAt: doc?.updatedAt || null });
  } catch (err) {
    console.error("[speedyapply] save error:", err?.message || err);
    return res.status(500).json({ error: "save_failed" });
  }
}
