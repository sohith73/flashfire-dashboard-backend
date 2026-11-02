// SpeedyApply: the client's cover letter files, as uploaded on the dashboard.
//
// Cover letters are finished files (Executive plan clients get one written for
// them), so they are sent as stored. Nothing is rebuilt through the PDF server.
//
// Where they live:
//   users.coverLetters[]     Documents > Cover letters on the dashboard, and the
//                            operator onboarding upload. { url, name, companyName,
//                            jobRole, jobId, jobLink, createdAt }
//   profiles.coverLetterUrl  the onboarding form's optional cover letter link.
//
// The URL comes from the database, so it is never fetched blindly: only R2
// (read with the bucket credentials), the R2 public host, Cloudinary and
// Google Drive / Docs are allowed, every redirect hop is checked against the
// same list, and the body must really be a PDF or Word file.

import crypto from "node:crypto";
import { jobLinkKey } from "./jobLinkKey.js";

export const MAX_COVER_LETTER_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 4;

// Stable id for one stored file. The entries have no _id, and the URL itself
// never needs to leave the server.
export function coverLetterId(url) {
  return crypto.createHash("sha256").update(String(url)).digest("hex").slice(0, 16);
}

function validHttpUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

function toIso(d) {
  const t = d ? new Date(d) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toISOString() : null;
}

/**
 * Every cover letter the client has, newest first, one entry per file.
 * @returns {{id, url, name, companyName, jobRole, jobLink, createdAt, source}[]}
 */
export function collectCoverLetters(user, profile) {
  const out = [];
  const seen = new Set();
  const add = (entry) => {
    const u = validHttpUrl(entry.url);
    if (!u) return;
    const url = u.toString();
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ ...entry, url, id: coverLetterId(url) });
  };
  for (const c of Array.isArray(user?.coverLetters) ? user.coverLetters : []) {
    add({
      url: c?.url || c?.coverLetterLink,
      name: String(c?.name || "").trim() || "Cover letter",
      companyName: String(c?.companyName || "").trim(),
      jobRole: String(c?.jobRole || "").trim(),
      jobLink: String(c?.jobLink || "").trim(),
      createdAt: toIso(c?.createdAt),
      source: "dashboard",
    });
  }
  // Newest upload first. Rows without a date keep their stored order at the end.
  out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  if (profile?.coverLetterUrl) {
    add({
      url: profile.coverLetterUrl,
      name: "Cover letter from the onboarding form",
      companyName: "",
      jobRole: "",
      jobLink: "",
      createdAt: toIso(profile.updatedAt || profile.createdAt),
      source: "profile",
    });
  }
  return out;
}

/**
 * The cover letter to use on a page: one saved for this posting's link, else
 * the newest general one (no company on it), else the newest of all.
 * @param {ReturnType<typeof collectCoverLetters>} list
 * @param {string[]} pageKeys  applicationPageLinkKeys(page URL)
 */
export function chooseCoverLetter(list, pageKeys = []) {
  if (!list.length) return { choice: null, matched: false };
  if (pageKeys.length) {
    const hit = list.find((c) => c.jobLink && pageKeys.includes(jobLinkKey(c.jobLink)));
    if (hit) return { choice: hit, matched: true };
  }
  const general = list.find((c) => c.source === "dashboard" && !c.companyName && !c.jobLink);
  return { choice: general || list[0], matched: false };
}

/** What the extension sees: no URL. */
export function publicCoverLetter(c) {
  const { url, ...rest } = c;
  return rest;
}

// ── Where the bytes come from ───────────────────────────────────────────────

const STATIC_HOSTS = ["res.cloudinary.com", "drive.google.com", "docs.google.com", "drive.usercontent.google.com"];

export function hostAllowed(host, { r2PublicHost = "" } = {}) {
  const h = String(host || "").toLowerCase();
  if (!h) return false;
  if (STATIC_HOSTS.includes(h)) return true;
  if (h.endsWith(".r2.dev")) return true;
  if (h.endsWith(".googleusercontent.com")) return true; // Drive download redirects land here
  return !!r2PublicHost && h === r2PublicHost.toLowerCase();
}

/**
 * How to read one stored URL.
 *   { kind: "r2", key }          private bucket URL: read with the R2 credentials
 *   { kind: "https", urls: [] }  public file, tried in order
 *   null                         not a host this route will fetch
 */
export function fileSourceFor(rawUrl, { r2PublicHost = "" } = {}) {
  const u = validHttpUrl(rawUrl);
  if (!u) return null;
  const host = u.host.toLowerCase();

  if (host.endsWith(".r2.cloudflarestorage.com")) {
    // https://<bucket>.r2.cloudflarestorage.com/<key>, as uploadToR2 writes it
    // when R2_PUBLIC_URL is unset.
    const key = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    return key ? { kind: "r2", key } : null;
  }
  if (!hostAllowed(host, { r2PublicHost })) return null;

  if (host === "drive.google.com") {
    const id = u.pathname.match(/\/file\/d\/([\w-]{10,})/)?.[1] || u.searchParams.get("id");
    if (!id || !/^[\w-]{10,}$/.test(id)) return null;
    return { kind: "https", urls: [`https://drive.google.com/uc?export=download&id=${id}`] };
  }
  if (host === "docs.google.com") {
    const m = u.pathname.match(/\/document\/d\/([\w-]{10,})/);
    return m ? { kind: "https", urls: [`https://docs.google.com/document/d/${m[1]}/export?format=pdf`] } : null;
  }
  if (host === "res.cloudinary.com" && u.pathname.includes("/image/upload/")) {
    // PDFs uploaded as images are sometimes refused for delivery; the dashboard
    // reads them through /raw/upload/ for the same reason.
    const raw = new URL(u);
    raw.pathname = u.pathname.replace("/image/upload/", "/raw/upload/");
    return { kind: "https", urls: [u.toString(), raw.toString()] };
  }
  return { kind: "https", urls: [u.toString()] };
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** PDF, DOCX or DOC by their first bytes, else null. */
export function sniffDocument(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return { ext: "pdf", mimeType: "application/pdf" };
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf.includes(Buffer.from("word/"))) return { ext: "docx", mimeType: DOCX_MIME };
  if (buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return { ext: "doc", mimeType: "application/msword" };
  return null;
}

/** Jane_Doe_Cover_Letter.pdf */
export function coverLetterFilename(name, ext) {
  const base = String(name || "")
    .replace(/\.(pdf|docx?|txt)$/i, "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 80) || "Cover_Letter";
  return `${base}.${ext}`;
}

export class CoverLetterFetchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // "blocked" | "unreachable" | "not_a_document" | "too_large" | "storage"
  }
}

async function readCapped(resp) {
  const declared = Number(resp.headers.get("content-length") || 0);
  if (declared > MAX_COVER_LETTER_BYTES) throw new CoverLetterFetchError("too_large", "The cover letter file is larger than 10 MB.");
  const chunks = [];
  let size = 0;
  for await (const chunk of resp.body) {
    size += chunk.length;
    if (size > MAX_COVER_LETTER_BYTES) throw new CoverLetterFetchError("too_large", "The cover letter file is larger than 10 MB.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// GET with redirects followed by hand, so a redirect can never walk the
// request to a host outside the list (internal addresses included).
async function fetchAllowed(url, { fetchImpl, r2PublicHost }) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = validHttpUrl(current);
    if (!u || u.protocol !== "https:" || !hostAllowed(u.host, { r2PublicHost })) {
      throw new CoverLetterFetchError("blocked", "The cover letter is stored somewhere SpeedyApply does not read from.");
    }
    let resp;
    try {
      resp = await fetchImpl(u.toString(), { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      throw new CoverLetterFetchError("unreachable", `Could not download the cover letter (${err?.name === "TimeoutError" ? "timed out" : "network error"}).`);
    }
    if (resp.status >= 300 && resp.status < 400) {
      const next = resp.headers.get("location");
      if (!next) break;
      current = new URL(next, u).toString();
      continue;
    }
    if (!resp.ok) throw new CoverLetterFetchError("unreachable", `The file host answered HTTP ${resp.status}.`);
    return readCapped(resp);
  }
  throw new CoverLetterFetchError("unreachable", "The file host redirected too many times.");
}

/**
 * Download one stored cover letter.
 * @param {string} url  as stored on the client
 * @param {{ fetchImpl?, getR2Object?, r2PublicHost? }} deps
 * @returns {Promise<{ buffer: Buffer, ext: string, mimeType: string }>}
 */
export async function downloadCoverLetter(url, deps = {}) {
  const { fetchImpl = fetch, getR2Object, r2PublicHost = "" } = deps;
  const source = fileSourceFor(url, { r2PublicHost });
  if (!source) throw new CoverLetterFetchError("blocked", "The cover letter is stored somewhere SpeedyApply does not read from.");

  let lastError = null;
  const candidates = source.kind === "r2" ? [null] : source.urls;
  for (const candidate of candidates) {
    try {
      let buffer;
      if (source.kind === "r2") {
        if (!getR2Object) throw new CoverLetterFetchError("storage", "Storage is not configured.");
        const r = await getR2Object(source.key);
        if (!r?.success) throw new CoverLetterFetchError("storage", "Could not read the cover letter from storage.");
        buffer = r.buffer;
        if (buffer.length > MAX_COVER_LETTER_BYTES) throw new CoverLetterFetchError("too_large", "The cover letter file is larger than 10 MB.");
      } else {
        buffer = await fetchAllowed(candidate, { fetchImpl, r2PublicHost });
      }
      const kind = sniffDocument(buffer);
      if (!kind) throw new CoverLetterFetchError("not_a_document", "The stored cover letter is not a PDF or Word file.");
      return { buffer, ...kind };
    } catch (err) {
      lastError = err;
      if (err?.code === "blocked" || err?.code === "too_large") break;
    }
  }
  throw lastError || new CoverLetterFetchError("unreachable", "Could not download the cover letter.");
}
