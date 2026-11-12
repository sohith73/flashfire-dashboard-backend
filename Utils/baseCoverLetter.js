// The client's base cover letter: pasted by an operator in the dashboard
// Operations tab, stored in R2, tailored per job card by the auto-optimization
// queue (Utils/coverLetterAutoWriter.js) and by the on-demand SpeedyApply
// writer.
//
// R2 layout (same client sanitizer as uploadJSONToR2):
//   flashfirejobs/<client>/cover-letter/base.json            { text, updatedAt, updatedBy }
//   flashfirejobs/<client>/cover-letter-data/<jobCardId>.json { paragraphs, jobTitle, companyName, model, baseHash, createdAt }
//
// UserModel.baseCoverLetter keeps only the pointer: { key, updatedAt, updatedBy, words, hash }.
// `hash` is the first 16 hex chars of sha256(normalized text); a job card whose
// optimizedCoverLetter.baseHash differs was written from an older base letter.
//
// Text rules: plain text, paragraphs separated by blank lines. Operators paste
// the body only, but a pasted greeting, sign-off, name or contact block is
// stripped here. Empty text deletes the letter. Max 8000 chars as pasted, min
// 300 chars after cleaning.

import crypto from "node:crypto";
import { getJSONFromR2, putJSONToR2, deleteFromR2 } from "./r2Storage.js";
import {
  CONTACT_RX,
  SALUTATION_RX,
  SIGN_OFF_RX,
  assembleLetter,
  cleanParagraph,
  countWords,
  isExecutivePlan,
} from "./speedyApplyCoverLetterWriter.js";

export const BASE_LETTER_MAX_CHARS = 8000;
export const BASE_LETTER_MIN_CHARS = 300;
const R2_FOLDER = "flashfirejobs";

const str = (v) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** Same sanitizer uploadJSONToR2 applies to the client name. */
export const sanitizeClientForKey = (email) => str(email).replace(/[^a-zA-Z0-9._-]/g, "_");

export function baseLetterKey(clientEmail) {
  const c = sanitizeClientForKey(clientEmail);
  if (!c) throw new Error("client email is required for the base letter key");
  return `${R2_FOLDER}/${c}/cover-letter/base.json`;
}

export function jobLetterKey(clientEmail, jobCardId) {
  const c = sanitizeClientForKey(clientEmail);
  const id = str(jobCardId).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!c || !id) throw new Error("client email and job card id are required for the cover letter key");
  return `${R2_FOLDER}/${c}/cover-letter-data/${id}.json`;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const normName = (s) => str(s).toLowerCase().replace(/[^a-z]+/g, " ").trim();

// A short line that is only a date ("November 12, 2026", "12/11/2026").
const DATE_LINE_RX = /^(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+\d{4}|\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4})$/i;

function isHeaderLine(line, name) {
  const t = line.trim();
  if (!t) return true;
  if (CONTACT_RX.test(t) || DATE_LINE_RX.test(t)) return true;
  if (/https?:\/\/|linkedin\.com|github\.com/i.test(t) && t.split(/\s+/).length <= 4) return true;
  const n = normName(name);
  if (n && normName(t) === n) return true;
  // "Durham, NC | +1 919 ... | jane@x.com" style contact rows.
  if (/[|•·]/.test(t) && /@|\d{3}/.test(t) && t.length <= 160) return true;
  return false;
}

/**
 * Clean pasted text into the stored body: paragraphs separated by one blank
 * line, greeting / header / sign-off / signature removed, dashes replaced
 * (house style). Returns "" for empty input.
 */
export function normalizeBaseLetterText(raw, { name = "" } = {}) {
  let lines = str(raw)
    .replace(/\r\n?/g, "\n")
    .replace(/[   ]/g, " ")
    .replace(/[​-‍﻿]/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""));

  // Header and greeting: when a salutation line sits near the top, everything
  // above it is the contact block or a date, and it goes with the greeting.
  const salIdx = lines.findIndex((l, i) => i < 15 && SALUTATION_RX.test(l.trim()) && l.trim().length <= 80);
  if (salIdx >= 0) {
    const rest = lines[salIdx].trim().replace(SALUTATION_RX, "").trim();
    lines = [rest, ...lines.slice(salIdx + 1)];
  } else {
    while (lines.length && isHeaderLine(lines[0], name)) lines.shift();
  }

  // Sign-off: a "Sincerely," line in the last few lines ends the body; the
  // name and contact lines under it go too.
  const lastText = lines.length - 1;
  for (let i = lastText; i >= 0 && i >= lastText - 8; i--) {
    if (SIGN_OFF_RX.test(lines[i].trim())) {
      lines = lines.slice(0, i);
      break;
    }
  }

  const paragraphs = lines
    .join("\n")
    .split(/\n\s*\n/)
    .map((p) => cleanParagraph(p, name))
    .filter(Boolean);
  return paragraphs.join("\n\n");
}

export const baseLetterHash = (text) => crypto.createHash("sha256").update(str(text), "utf8").digest("hex").slice(0, 16);

export const baseLetterParagraphs = (text) => str(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

/**
 * Validate an operator's PUT body text.
 *   { ok: true, empty: true }                       delete the base letter
 *   { ok: true, empty: false, text, words, hash }   save it
 *   { ok: false, error, message }                   400
 */
export function validateBaseLetterInput(raw, { name = "" } = {}) {
  if (raw !== undefined && raw !== null && typeof raw !== "string") {
    return { ok: false, error: "text_required", message: "The cover letter must be plain text." };
  }
  const trimmed = str(raw).trim();
  if (!trimmed) return { ok: true, empty: true };
  if (trimmed.length > BASE_LETTER_MAX_CHARS) {
    return {
      ok: false,
      error: "base_letter_too_long",
      message: `The cover letter is ${trimmed.length} characters. Keep it under ${BASE_LETTER_MAX_CHARS}.`,
    };
  }
  const text = normalizeBaseLetterText(trimmed, { name });
  if (text.length < BASE_LETTER_MIN_CHARS) {
    return {
      ok: false,
      error: "base_letter_too_short",
      message: `Paste the full letter body. After removing the greeting and sign-off it is ${text.length} characters; it needs at least ${BASE_LETTER_MIN_CHARS}.`,
    };
  }
  return { ok: true, empty: false, text, words: countWords(text), hash: baseLetterHash(text) };
}

/** True when a client should get letters from the queue right now. */
export function queueEligible(user) {
  return isExecutivePlan(user?.planType) && !!user?.baseCoverLetter?.key;
}

// ---------------------------------------------------------------------------
// R2 IO (deps injectable for tests)
// ---------------------------------------------------------------------------

const CACHE_MAX = 200;
const cache = new Map();

export function clearBaseLetterCache() {
  cache.clear();
}

const cacheKeyOf = (pointer) => {
  const at = pointer?.updatedAt ? new Date(pointer.updatedAt).getTime() : 0;
  return `${pointer?.key || ""}|${at}`;
};

/**
 * The base letter text for a UserModel.baseCoverLetter pointer.
 * Cached in memory by key + updatedAt, so a new save is read fresh.
 * Resolves to { ok: true, text } or { ok: false, reason: "missing" | "storage" }.
 */
export async function loadBaseLetterText(pointer, deps = {}) {
  const getJSON = deps.getJSON || getJSONFromR2;
  if (!pointer?.key) return { ok: false, reason: "missing" };
  const ck = cacheKeyOf(pointer);
  if (cache.has(ck)) return { ok: true, text: cache.get(ck) };
  const r = await getJSON(pointer.key);
  if (!r?.success) return { ok: false, reason: "storage" };
  const text = str(r.data?.text).trim();
  if (!text) return { ok: false, reason: "missing" };
  cache.set(ck, text);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return { ok: true, text };
}

/** Write base.json. Resolves to { ok: true, key } or { ok: false, error }. */
export async function saveBaseLetter({ clientEmail, text, updatedAt, updatedBy }, deps = {}) {
  const putJSON = deps.putJSON || putJSONToR2;
  const key = baseLetterKey(clientEmail);
  const r = await putJSON(key, { text, updatedAt: new Date(updatedAt).toISOString(), updatedBy: str(updatedBy) }, { clientName: clientEmail });
  if (!r?.success) return { ok: false, error: r?.error || "upload failed" };
  return { ok: true, key };
}

/** Delete base.json. A failed delete is logged by the caller, not fatal. */
export async function deleteBaseLetter(key, deps = {}) {
  const del = deps.deleteObject || deleteFromR2;
  if (!key) return { ok: true };
  const r = await del(key);
  return r?.success ? { ok: true } : { ok: false, error: r?.error || "delete failed" };
}

// ---------------------------------------------------------------------------
// Serving a job card's letter to the extension
// ---------------------------------------------------------------------------

/** Is this job card filed under one of the client's account emails (any case)? */
export function jobOwnedBy(job, emails) {
  const owner = str(job?.userID).trim().toLowerCase();
  if (!owner) return false;
  return (Array.isArray(emails) ? emails : []).some((e) => str(e).trim().toLowerCase() === owner);
}

/** The `optimized` field of GET /extension/speedyapply/cover-letters. */
export function optimizedLetterItem(job) {
  if (!job?._id || !job.optimizedCoverLetter?.hasLetter) return null;
  const at = job.optimizedCoverLetter.createdAt;
  return {
    id: `job:${String(job._id)}`,
    jobId: String(job._id),
    companyName: str(job.companyName),
    jobRole: str(job.jobTitle),
    createdAt: at ? new Date(at).toISOString() : null,
  };
}

/**
 * 200 body of GET /extension/speedyapply/cover-letters/job/:jobId, from the
 * R2 JSON the queue stored and the contact block built from the database.
 * Returns null when the stored JSON has no usable paragraphs.
 */
export function servedLetterBody({ stored, job, contact }) {
  const paragraphs = Array.isArray(stored?.paragraphs)
    ? stored.paragraphs.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim())
    : [];
  if (!paragraphs.length) return null;
  const at = job?.optimizedCoverLetter?.createdAt || stored?.createdAt;
  return {
    ok: true,
    letter: assembleLetter(contact, paragraphs),
    company: str(stored?.companyName) || str(job?.companyName),
    jobTitle: str(stored?.jobTitle) || str(job?.jobTitle),
    createdAt: at ? new Date(at).toISOString() : null,
  };
}
