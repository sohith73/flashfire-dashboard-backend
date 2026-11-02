// SpeedyApply attaches the client's uploaded cover letter as stored. These pin
// which entry is used, which hosts are read (and that redirects cannot leave
// them), and that only real PDF / Word bytes are passed on.

import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseCoverLetter,
  collectCoverLetters,
  coverLetterFilename,
  coverLetterId,
  downloadCoverLetter,
  fileSourceFor,
  publicCoverLetter,
  sniffDocument,
} from "../coverLetterFile.js";
import { applicationPageLinkKeys } from "../jobLinkKey.js";

const PDF = Buffer.from("%PDF-1.7\n1 0 obj <<>> endobj\n%%EOF\n");
const R2 = "pub-abc123.r2.dev";

const user = {
  coverLetters: [
    { url: `https://${R2}/flashfirejobs/x/resume/old.pdf`, name: "Priya_Raman_Cover_Letter", createdAt: new Date("2026-09-01") },
    { url: `https://${R2}/flashfirejobs/x/resume/acme.pdf`, name: "Acme cover", companyName: "Acme Robotics", jobLink: "https://jobs.lever.co/acme/1a2b", createdAt: new Date("2026-10-20") },
    { url: `https://${R2}/flashfirejobs/x/resume/new.pdf`, name: "Priya_Raman_Cover_Letter", createdAt: new Date("2026-10-10") },
    { url: `https://${R2}/flashfirejobs/x/resume/new.pdf`, name: "duplicate row" },
    { url: "javascript:alert(1)", name: "junk" },
    { coverLetterLink: "https://res.cloudinary.com/demo/image/upload/v1/legacy.pdf", name: "Legacy" },
  ],
};

test("all of a client's cover letters, newest first, each file once, junk dropped", () => {
  const list = collectCoverLetters(user, { coverLetterUrl: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view" });
  assert.deepEqual(list.map((c) => c.name), ["Acme cover", "Priya_Raman_Cover_Letter", "Priya_Raman_Cover_Letter", "Legacy", "Cover letter from the onboarding form"]);
  assert.equal(list[1].url, `https://${R2}/flashfirejobs/x/resume/new.pdf`);
  assert.equal(list.at(-1).source, "profile");
  assert.equal(new Set(list.map((c) => c.id)).size, list.length);
  assert.equal("url" in publicCoverLetter(list[0]), false, "the URL stays on the server");
});

test("ids are stable and opaque", () => {
  assert.match(coverLetterId("https://x/y.pdf"), /^[0-9a-f]{16}$/);
  assert.equal(coverLetterId("https://x/y.pdf"), coverLetterId("https://x/y.pdf"));
});

test("the one saved for this posting wins, else the newest general one", () => {
  const list = collectCoverLetters(user, null);
  const onAcme = chooseCoverLetter(list, applicationPageLinkKeys("https://jobs.lever.co/acme/1a2b/apply?lever-source=LinkedIn"));
  assert.equal(onAcme.choice.name, "Acme cover");
  assert.equal(onAcme.matched, true);
  const elsewhere = chooseCoverLetter(list, applicationPageLinkKeys("https://boards.greenhouse.io/other/jobs/9"));
  assert.equal(elsewhere.choice.url, `https://${R2}/flashfirejobs/x/resume/new.pdf`, "newest without a company");
  assert.equal(elsewhere.matched, false);
  assert.deepEqual(chooseCoverLetter([], []), { choice: null, matched: false });
});

test("only known storage hosts are read", () => {
  assert.deepEqual(fileSourceFor(`https://${R2}/a/b.pdf`), { kind: "https", urls: [`https://${R2}/a/b.pdf`] });
  assert.deepEqual(fileSourceFor("https://files.flashfire.example/a.pdf", { r2PublicHost: "files.flashfire.example" }).kind, "https");
  assert.deepEqual(fileSourceFor("https://flashfire-storage.r2.cloudflarestorage.com/flashfirejobs/a%20b.pdf"), { kind: "r2", key: "flashfirejobs/a b.pdf" });
  assert.equal(fileSourceFor("https://evil.example/a.pdf"), null);
  assert.equal(fileSourceFor("http://169.254.169.254/latest/meta-data"), null);
  assert.equal(fileSourceFor("https://localhost/x.pdf"), null);
  assert.equal(fileSourceFor("file:///etc/passwd"), null);
});

test("Drive, Docs and Cloudinary links are turned into downloads", () => {
  assert.deepEqual(fileSourceFor("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing").urls, ["https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOp"]);
  assert.deepEqual(fileSourceFor("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp").urls, ["https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOp"]);
  assert.deepEqual(fileSourceFor("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit").urls, ["https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/export?format=pdf"]);
  assert.equal(fileSourceFor("https://drive.google.com/drive/folders/abc"), null, "a folder is not a file");
  assert.deepEqual(fileSourceFor("https://res.cloudinary.com/demo/image/upload/v1/cl.pdf").urls, [
    "https://res.cloudinary.com/demo/image/upload/v1/cl.pdf",
    "https://res.cloudinary.com/demo/raw/upload/v1/cl.pdf",
  ]);
});

test("PDF and Word files are recognised by their bytes", () => {
  assert.deepEqual(sniffDocument(PDF), { ext: "pdf", mimeType: "application/pdf" });
  assert.equal(sniffDocument(Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from("....word/document.xml")])).ext, "docx");
  assert.equal(sniffDocument(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])).ext, "doc");
  assert.equal(sniffDocument(Buffer.from("<html>Access denied</html>")), null);
  assert.equal(sniffDocument(Buffer.from("PK\x03\x04 a zip of something else")), null);
});

test("filenames are clean", () => {
  assert.equal(coverLetterFilename("Priya_Raman_Cover_Letter", "pdf"), "Priya_Raman_Cover_Letter.pdf");
  assert.equal(coverLetterFilename('Zoë "X" cover.pdf', "pdf"), "Zoe_X_cover.pdf");
  assert.equal(coverLetterFilename("", "docx"), "Cover_Letter.docx");
});

const respond = (status, body = PDF, headers = {}) => new Response(status >= 300 && status < 400 ? null : body, { status, headers });

test("a public file is downloaded and checked", async () => {
  const asked = [];
  const r = await downloadCoverLetter(`https://${R2}/a.pdf`, { fetchImpl: async (u, o) => { asked.push([u, o.redirect]); return respond(200); } });
  assert.equal(r.ext, "pdf");
  assert.ok(r.buffer.equals(PDF));
  assert.deepEqual(asked, [[`https://${R2}/a.pdf`, "manual"]]);
});

test("a redirect to an allowed host is followed, one to anywhere else is refused", async () => {
  const drive = "https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOp";
  const ok = await downloadCoverLetter("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view", {
    fetchImpl: async (u) => (u === drive ? respond(303, null, { location: "https://drive.usercontent.google.com/download?id=1" }) : respond(200)),
  });
  assert.equal(ok.ext, "pdf");
  const asked = [];
  await assert.rejects(
    downloadCoverLetter(`https://${R2}/a.pdf`, { fetchImpl: async (u) => { asked.push(u); return respond(302, null, { location: "http://169.254.169.254/latest/meta-data" }); } }),
    (e) => e.code === "blocked",
  );
  assert.equal(asked.length, 1, "the internal address is never requested");
});

test("a host's error page is not passed on as a cover letter", async () => {
  await assert.rejects(
    downloadCoverLetter(`https://${R2}/a.pdf`, { fetchImpl: async () => respond(200, Buffer.from("<html>Sign in to Google</html>")) }),
    (e) => e.code === "not_a_document",
  );
  await assert.rejects(downloadCoverLetter(`https://${R2}/a.pdf`, { fetchImpl: async () => respond(404) }), (e) => e.code === "unreachable");
});

test("Cloudinary falls back to the raw delivery URL", async () => {
  const asked = [];
  const r = await downloadCoverLetter("https://res.cloudinary.com/demo/image/upload/v1/cl.pdf", {
    fetchImpl: async (u) => { asked.push(u); return /\/image\//.test(u) ? respond(401) : respond(200); },
  });
  assert.equal(r.ext, "pdf");
  assert.equal(asked.length, 2);
});

test("private bucket URLs are read with the R2 credentials", async () => {
  const keys = [];
  const r = await downloadCoverLetter("https://flashfire-storage.r2.cloudflarestorage.com/flashfirejobs/c.pdf", {
    getR2Object: async (k) => { keys.push(k); return { success: true, buffer: PDF }; },
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  assert.equal(r.ext, "pdf");
  assert.deepEqual(keys, ["flashfirejobs/c.pdf"]);
  await assert.rejects(
    downloadCoverLetter("https://flashfire-storage.r2.cloudflarestorage.com/flashfirejobs/c.pdf", { getR2Object: async () => ({ success: false }) }),
    (e) => e.code === "storage",
  );
});

test("a file over 10 MB is refused", async () => {
  await assert.rejects(
    downloadCoverLetter(`https://${R2}/a.pdf`, { fetchImpl: async () => respond(200, PDF, { "content-length": String(11 * 1024 * 1024) }) }),
    (e) => e.code === "too_large",
  );
  const big = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]);
  await assert.rejects(downloadCoverLetter(`https://${R2}/a.pdf`, { fetchImpl: async () => respond(200, big) }), (e) => e.code === "too_large");
});
