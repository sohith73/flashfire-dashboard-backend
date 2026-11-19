// SpeedyApply attaches a job card's optimized resume. These pin the job card's
// PDF rules (sections, medical template, page target, scale search), the R2
// lookup and the link match that suggests a job card for the page.

import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import {
  buildPdfPayload,
  countPdfPages,
  findBestScale,
  isMedicalResume,
  parseOptimizedAt,
  resumePdfFilename,
  targetPages,
} from "../optimizedResumePdf.js";
import { loadOptimizedResumeData } from "../optimizedResumeData.js";
import { applicationPageLinkKeys } from "../jobLinkKey.js";

const resume = {
  personalInfo: { name: "Priya  Raman" },
  summary: "Data engineer.",
  workExperience: [{ id: "1", position: "Data Engineer", responsibilities: ["Built pipelines"] }],
  publications: [{ id: "1", details: "Raman, P. (2024). Streaming joins." }],
  certifications: [{ id: "1", title: "AWS Data Engineer", issuer: "Amazon" }],
  therapeuticAreas: "Oncology, Cardiology",
  sectionTitles: { leadership: "ADDITIONAL INFORMATION" },
};

test("V=2 in the resume JSON, or version 2 on the job, is the medical template", () => {
  assert.equal(isMedicalResume({ version: 0 }, { V: 2 }), true);
  assert.equal(isMedicalResume({ version: 2 }, {}), true);
  assert.equal(isMedicalResume({ version: 2 }, null), true);
  assert.equal(isMedicalResume({ version: 0 }, { V: 0 }), false);
  assert.equal(isMedicalResume({}, {}), false);
  assert.equal(targetPages(true), 2);
  assert.equal(targetPages(false), 1);
});

test("a standard resume is built the way the job card's Download builds it", () => {
  const p = buildPdfPayload({
    optimizedResume: { showProjects: true, showPublications: false, sectionOrder: ["personalInfo", "summary", "workExperience", "publications", "certifications"] },
    resumeData: resume,
    medical: false,
    scale: 0.9,
  });
  assert.deepEqual(p.checkboxStates, { showSummary: true, showProjects: true, showLeadership: true, showPublications: false, showCertifications: true });
  assert.deepEqual(p.sectionOrder, ["personalInfo", "summary", "workExperience", "certifications"]);
  assert.equal(p.scale, 0.9);
  assert.equal(p.overrideAutoScale, true);
  assert.equal("therapeuticAreas" in p, false);
  assert.deepEqual(p.sectionTitles, { leadership: "ADDITIONAL INFORMATION" });
});

test("a standard resume with publications on gets a publications slot", () => {
  const p = buildPdfPayload({ optimizedResume: { showPublications: true, sectionOrder: ["personalInfo", "summary"] }, resumeData: resume, medical: false, scale: 1 });
  assert.deepEqual(p.sectionOrder, ["personalInfo", "summary", "publications", "certifications"]);
  assert.equal(p.checkboxStates.showPublications, true);
});

test("a standard resume without certification content leaves the section off", () => {
  const p = buildPdfPayload({
    optimizedResume: { sectionOrder: ["personalInfo", "summary", "certifications"] },
    resumeData: { ...resume, certifications: [{ title: "", issuer: " " }] },
    medical: false,
    scale: 1,
  });
  assert.equal(p.checkboxStates.showCertifications, false);
  assert.equal(p.sectionOrder.includes("certifications"), false);
});

test("a medical resume shows sections that have content and keeps therapeutic areas", () => {
  const p = buildPdfPayload({
    optimizedResume: { showTherapeuticAreas: true, showPublications: false, sectionTitles: { summary: "PROFILE" } },
    resumeData: resume,
    medical: true,
    scale: 1,
  });
  assert.equal(p.checkboxStates.showPublications, true, "publications have content");
  assert.equal(p.checkboxStates.showCertifications, true, "certifications have content");
  assert.equal(p.checkboxStates.showTherapeuticAreas, true);
  assert.equal(p.therapeuticAreas, "Oncology, Cardiology");
  for (const id of ["publications", "certifications", "therapeuticAreas"]) assert.ok(p.sectionOrder.includes(id), id);
  assert.deepEqual(p.sectionTitles, { summary: "PROFILE" }, "the job's own titles win over the JSON's");
});

test("a medical resume with empty publications and certifications leaves them off", () => {
  const p = buildPdfPayload({
    optimizedResume: {},
    resumeData: { ...resume, publications: [{ details: "  " }], certifications: [{ title: "", issuer: "" }] },
    medical: true,
    scale: 1,
  });
  assert.equal(p.checkboxStates.showPublications, false);
  assert.equal(p.checkboxStates.showCertifications, false);
  assert.equal(p.checkboxStates.showTherapeuticAreas, false);
});

// A PDF shaped like the PDF server's: page objects inside a compressed object stream.
function fakePdf(pages) {
  const objs = Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R >>").join("\n") + `\n<< /Type /Pages /Count ${pages} >>`;
  const z = zlib.deflateSync(Buffer.from(objs, "latin1"));
  return Buffer.concat([
    Buffer.from(`%PDF-1.7\n1 0 obj\n<</Type /ObjStm/Filter /FlateDecode/Length ${z.length}>>\nstream\n`, "latin1"),
    z,
    Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
  ]);
}

test("pages are counted inside compressed object streams", () => {
  assert.equal(countPdfPages(fakePdf(1)), 1);
  assert.equal(countPdfPages(fakePdf(2)), 2);
  assert.equal(countPdfPages(fakePdf(3)), 3);
  assert.equal(countPdfPages(Buffer.from("not a pdf")), null);
  assert.equal(countPdfPages(Buffer.from("%PDF-1.7\nno pages here\n")), null);
});

// Pages grow with scale: content that is `height` pages tall at scale 1.0.
const renderer = (height, calls = []) => async (scale) => {
  calls.push(scale);
  return { pdf: Buffer.from(String(scale)), pages: Math.max(1, Math.ceil(height * scale * scale - 1e-9)) };
};

test("the scale is the largest that still fits the page target", async () => {
  const calls = [];
  const r = await findBestScale(renderer(1.3, calls), 1);
  assert.equal(r.fits, true);
  assert.equal(r.pages, 1);
  assert.ok(Math.ceil(1.3 * (r.scale + 0.02) ** 2) > 1, `the next step up (${r.scale + 0.02}) must spill`);
  assert.ok(calls.length <= 8, `${calls.length} renders`);
  assert.equal(calls[0], 1, "starts at 1.0");
});

test("a short resume grows to fill its pages", async () => {
  const r = await findBestScale(renderer(0.7), 1);
  assert.equal(r.pages, 1);
  assert.ok(r.scale > 1.15 && r.scale <= 1.2, `scale ${r.scale}`);
});

test("a medical resume targets two pages", async () => {
  const r = await findBestScale(renderer(2.6), 2);
  assert.equal(r.pages, 2);
  assert.ok(r.scale < 1 && r.scale >= 0.86, `scale ${r.scale}`);
});

test("a resume too long for any scale comes back at the smallest, marked as not fitting", async () => {
  const r = await findBestScale(renderer(9), 1);
  assert.equal(r.scale, 0.5);
  assert.equal(r.fits, false);
  assert.ok(r.pdf);
});

test("a PDF whose pages cannot be counted is used as is", async () => {
  const r = await findBestScale(async (scale) => ({ pdf: Buffer.from("x"), pages: null, scale }), 1);
  assert.equal(r.fits, null);
  assert.equal(r.scale, 1);
});

test("the filename matches the job card download", () => {
  assert.equal(resumePdfFilename(resume), "Priya_Raman_Resume.pdf");
  assert.equal(resumePdfFilename({ personalInfo: { name: 'Zoë "X" O\'Neil' } }), "Zo_X_ONeil_Resume.pdf");
  assert.equal(resumePdfFilename({}), "Resume_Resume.pdf");
});

test("optimize dates written in IST text become ISO", () => {
  assert.equal(parseOptimizedAt("30/10/2026, 3:15:22 pm"), "2026-10-30T09:45:22.000Z");
  assert.equal(parseOptimizedAt("1/2/2026, 12:05:00 am"), "2026-01-31T18:35:00.000Z");
  assert.equal(parseOptimizedAt("2026-10-30T09:45:22.000Z"), "2026-10-30T09:45:22.000Z");
  assert.equal(parseOptimizedAt("someday"), null);
  assert.equal(parseOptimizedAt(""), null);
});

test("an application page matches the posting link it was saved under", () => {
  assert.deepEqual(applicationPageLinkKeys("https://jobs.lever.co/acme/1a2b/apply?lever-source=LinkedIn"), [
    "jobs.lever.co/acme/1a2b/apply",
    "jobs.lever.co/acme/1a2b",
  ]);
  assert.deepEqual(applicationPageLinkKeys("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Austin/Data-Engineer_R123/apply/applyManually"), [
    "acme.wd5.myworkdayjobs.com/en-US/Careers/job/Austin/Data-Engineer_R123/apply/applyManually",
    "acme.wd5.myworkdayjobs.com/en-US/Careers/job/Austin/Data-Engineer_R123",
  ]);
  assert.deepEqual(applicationPageLinkKeys("https://job-boards.greenhouse.io/acme/jobs/123?gh_src=x"), ["job-boards.greenhouse.io/acme/jobs/123"]);
  assert.deepEqual(applicationPageLinkKeys(""), []);
});

test("resume JSON comes from R2 by key, falling back to the legacy prefixes", async () => {
  const asked = [];
  const getJSON = async (key) => {
    asked.push(key);
    return key === "test/Legacy/a@b.com/job1.json" ? { success: true, data: { summary: "from R2" } } : { success: false };
  };
  const r = await loadOptimizedResumeData({ storageType: "r2", resumeDataKey: "Legacy/a@b.com/job1.json" }, { getJSON });
  assert.deepEqual(r, { ok: true, data: { summary: "from R2" } });
  assert.deepEqual(asked, ["Legacy/a@b.com/job1.json", "test/Legacy/a@b.com/job1.json"]);
});

test("resume JSON on old rows is read inline, and nothing saved is 'missing'", async () => {
  assert.deepEqual(await loadOptimizedResumeData({ storageType: "legacy", resumeData: { summary: "inline" } }), { ok: true, data: { summary: "inline" } });
  assert.deepEqual(await loadOptimizedResumeData({ storageType: "legacy" }), { ok: false, reason: "missing" });
  assert.deepEqual(await loadOptimizedResumeData({ storageType: "r2" }), { ok: false, reason: "missing" });
  const r = await loadOptimizedResumeData({ storageType: "r2", resumeDataR2Key: "/test/flashfirejobs/x.json" }, { getJSON: async () => ({ success: false }) });
  assert.deepEqual(r, { ok: false, reason: "storage" });
});
