// A job card's optimized resume, as the PDF the client would download.
//
// The dashboard never stores optimized resumes as PDFs. Each job keeps the
// resume as JSON in R2 (Utils/optimizedResumeData.js reads it back), and the
// browser posts that JSON to the PDF server (DASH/pdf, POST /v1/generate-pdf)
// whenever someone downloads it. SpeedyApply needs the same PDF without a
// browser in the loop, so the rules the job card applies live here:
//
//   - which sections show, in which order, under which headings
//     (ResumePreview.tsx for a standard resume, ResumePreviewMedical.tsx for V=2)
//   - the page target: a standard resume is 1 page, a medical one is 2
//     (utils/medicalPdfPageRule.ts in the dashboard)
//   - the scale: the operator drags a 0.5 to 1.5 slider until the resume fills
//     its pages without spilling. findBestScale does the same search.
//
// Everything here is pure: no network, no database. The controller passes in
// the function that renders a PDF.

import zlib from "node:zlib";
import { sectionTitlesFrom } from "./sectionTitles.js";

export const STANDARD_PAGES = 1;
export const MEDICAL_PAGES = 2;

// The dashboard slider runs 0.5 to 1.5. The search walks a 0.02 grid of it,
// which is about 6 renders and lands within 2% of the best fill.
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 1.5;
export const SCALE_STEP = 0.02;

const DEFAULT_ORDER = [
  "personalInfo",
  "summary",
  "workExperience",
  "projects",
  "leadership",
  "skills",
  "education",
  "publications",
];

// V=2 is the medical template. The job card reads it from the resume JSON
// first and the job's optimizedResume.version second (JobModal.tsx).
export function isMedicalResume(optimizedResume, resumeData) {
  const v = resumeData?.V ?? optimizedResume?.version ?? 0;
  return Number(v) === 2;
}

export function targetPages(medical) {
  return medical ? MEDICAL_PAGES : STANDARD_PAGES;
}

const hasText = (s) => typeof s === "string" && s.trim() !== "";

// The body /v1/generate-pdf takes, built exactly as the job card's Download
// button builds it.
export function buildPdfPayload({ optimizedResume, resumeData, medical, scale }) {
  const o = optimizedResume || {};
  const d = resumeData || {};
  const showSummary = o.showSummary !== false;
  const showProjects = o.showProjects === true;
  const showLeadership = o.showLeadership !== false;
  let showPublications = o.showPublications === true;
  let showCertifications = false;
  let order = Array.isArray(o.sectionOrder) && o.sectionOrder.length ? [...o.sectionOrder] : [...DEFAULT_ORDER];

  if (medical) {
    // ResumePreviewMedical turns these on whenever they have content, and makes
    // sure the order has a slot for each.
    showPublications = showPublications || (d.publications || []).some((p) => hasText(p?.details));
    showCertifications = (d.certifications || []).some((c) => hasText(c?.title) || hasText(c?.issuer));
    for (const id of ["publications", "certifications", "therapeuticAreas"]) {
      if (!order.includes(id)) order.push(id);
    }
  } else {
    // ResumePreview on a job card: publications follow their flag, and
    // certifications show whenever the resume has any.
    if (showPublications && !order.includes("publications")) order.push("publications");
    if (!showPublications) order = order.filter((id) => id !== "publications");
    showCertifications = (d.certifications || []).some((c) => hasText(c?.title) || hasText(c?.issuer));
    if (showCertifications && !order.includes("certifications")) order.push("certifications");
    if (!showCertifications) order = order.filter((id) => id !== "certifications");
  }

  const payload = {
    personalInfo: d.personalInfo || {},
    summary: d.summary || "",
    workExperience: d.workExperience || [],
    projects: d.projects || [],
    leadership: d.leadership || [],
    skills: d.skills || [],
    education: d.education || [],
    publications: d.publications || [],
    certifications: d.certifications || [],
    customSections: d.customSections || [],
    checkboxStates: { showSummary, showProjects, showLeadership, showPublications, showCertifications },
    sectionTitles: sectionTitlesFrom({ sectionTitles: o.sectionTitles, resumeData: d }),
    sectionOrder: order,
    scale,
    overrideAutoScale: true,
  };
  if (medical) {
    payload.therapeuticAreas = d.therapeuticAreas || "";
    payload.checkboxStates.showTherapeuticAreas = o.showTherapeuticAreas === true;
  }
  return payload;
}

// Pages in a PDF, or null when they cannot be counted. The PDF server
// (WeasyPrint) packs its page objects into compressed object streams, so the
// Flate streams are inflated before counting /Type /Page entries. Checked
// against pdfinfo on the PDF server's own output.
export function countPdfPages(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  const s = buf.toString("latin1");
  if (!s.startsWith("%PDF-")) return null;
  const parts = [s];
  const re = />>\s*stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    const dict = s.slice(s.lastIndexOf("<<", m.index), m.index);
    if (/FlateDecode/.test(dict)) {
      try {
        parts.push(zlib.inflateSync(buf.subarray(start, end), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString("latin1"));
      } catch {
        // Font and image streams that are not page trees can fail to inflate on
        // a trailing EOL. They hold no page objects, so skipping them is safe.
      }
    }
    re.lastIndex = end + "endstream".length;
  }
  const pages = (parts.join("\n").match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
  return pages > 0 ? pages : null;
}

const gridSize = () => Math.round((SCALE_MAX - SCALE_MIN) / SCALE_STEP);
const scaleAt = (i) => Math.round((SCALE_MIN + i * SCALE_STEP) * 100) / 100;
const indexOf = (scale) => Math.round((scale - SCALE_MIN) / SCALE_STEP);

// The largest scale whose PDF still fits `target` pages: the biggest, fullest
// resume that does not spill. `render(scale)` resolves to { pdf, pages }.
// Pages grow with scale, so this is a binary search over the slider grid,
// starting at 1.0 because most resumes are tuned near it.
//
// Returns { pdf, pages, scale, fits }. `fits` is false when even the smallest
// scale spills; that PDF is still returned so the client is not left without a
// resume, and the caller says so. A PDF whose pages cannot be counted is
// returned as is (fits: null), the same "unknown fails open" rule the
// dashboard's medical gate uses.
export async function findBestScale(render, target) {
  const seen = new Map();
  const at = async (i) => {
    if (!seen.has(i)) seen.set(i, await render(scaleAt(i)));
    return seen.get(i);
  };
  const fits = (r) => r.pages !== null && r.pages <= target;
  const done = (i, r, ok = true) => ({ pdf: r.pdf, pages: r.pages, scale: scaleAt(i), fits: ok });

  const top = gridSize();
  const start = indexOf(1.0);
  const first = await at(start);
  if (first.pages === null) return done(start, first, null);

  let lo; // largest index known to fit
  let hi; // smallest index known to spill
  if (fits(first)) {
    lo = start;
    const max = await at(top);
    if (fits(max)) return done(top, max);
    hi = top;
  } else {
    hi = start;
    const min = await at(0);
    if (min.pages === null) return done(0, min, null);
    if (!fits(min)) return done(0, min, false);
    lo = 0;
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const r = await at(mid);
    if (r.pages === null) return done(mid, r, null);
    if (fits(r)) lo = mid;
    else hi = mid;
  }
  return done(lo, await at(lo));
}

// "Priya Raman" -> "Priya_Raman_Resume.pdf", the name the job card downloads.
export function resumePdfFilename(resumeData) {
  const name = String(resumeData?.personalInfo?.name || "").trim() || "Resume";
  const clean = name.replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "Resume";
  return `${clean}_Resume.pdf`;
}

// optimizedResume.createdAt is written as en-IN local time in IST,
// "30/10/2026, 3:15:22 pm". Returns an ISO string, or null when it is not in
// that shape.
export function parseOptimizedAt(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const m = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?$/i);
  if (!m) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  const [, dd, mm, yyyy, hRaw, min, sec = "0", ampm] = m;
  let h = Number(hRaw) % 12;
  if (!ampm) h = Number(hRaw);
  else if (ampm.toLowerCase() === "pm") h += 12;
  const utc = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), h, Number(min), Number(sec)) - 330 * 60 * 1000;
  return new Date(utc).toISOString();
}
