// Does an Australian job posting say it will NOT take a candidate who needs a
// visa? The Australian sibling of noSponsorshipText.js, used by the
// "Australia visa sponsors only" gate (auVisaSponsor.js).
//
// Australian postings rarely say "we cannot sponsor". They say who may apply:
//   WORK_RIGHTS    "You must have full Australian working rights",
//                  "unrestricted work rights are essential"
//   CITIZENS_ONLY  "Australian citizens or permanent residents only",
//                  "must be an Australian citizen"
//   CLEARANCE      "must hold a Baseline / NV1 / NV2 clearance", which only
//                  Australian citizens can get
//   NO_SPONSORSHIP the plain "no visa sponsorship" wording, from the shared
//                  rules in noSponsorshipText.js
//
// Not refusals: "working rights preferred", "please state your working
// rights", "ability to obtain a Baseline clearance is desirable". Precision
// matters more than recall: a false hit throws away a good job unseen.

import { detectNoSponsorship } from "./noSponsorshipText.js";

const MAX_SCAN = 60000;

// A requirement, not a nice-to-have, somewhere in the same sentence.
const MUST = /\b(?:must|required|requires?|requirement|essential|mandatory|only|need(?:s|ed)?\s+to|will\s+need|eligible|eligibility|necessary|prerequisite)\b/i;
const SOFT = /\b(?:preferred|desirable|advantageous|an?\s+advantage|a\s+plus|highly\s+regarded|bonus|ideally)\b/i;

const RULES = [
  // "full working rights", "unrestricted work rights in Australia", "permanent working rights"
  ["WORK_RIGHTS", /\b(?:full|unrestricted|permanent|unlimited)\s+(?:australian\s+)?(?:working|work)\s+rights\b/i],
  // "Australian citizens or permanent residents only", "Australian Citizens and PRs only"
  ["CITIZENS_ONLY", /\baustralian\s+citizens?(?:hip)?\s*(?:,|or|and|\/|and\/or)\s*(?:an?\s+)?(?:australian\s+)?(?:permanent\s+residen(?:ts?|cy)|prs?)\b/i],
  // "must be an Australian citizen", "Australian citizenship is required"
  ["CITIZENS_ONLY", /\bmust\s+(?:be|hold)\s+(?:an?\s+)?australian\s+(?:citizen|citizenship)\b/i],
  ["CITIZENS_ONLY", /\baustralian\s+citizenship\s+(?:is\s+)?(?:required|mandatory|essential|is\s+a\s+requirement)\b/i],
  ["CITIZENS_ONLY", /\baustralian\s+citizens\s+only\b|\bonly\s+australian\s+citizens\b/i],
  // "Baseline clearance" (a bare "baseline" is just a word), "NV1", "Negative Vetting 1", "TSPV"
  ["CLEARANCE", /\bbaseline\s+(?:security\s+)?(?:clearance|vetting)\b|\b(?:nv\s?[12]|negative\s+vetting(?:\s+(?:level\s+)?[12])?|tspv|positive\s+vetting)\b/i],
];

const squash = (s) => String(s ?? "")
  .slice(0, MAX_SCAN)
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/\s+/g, " ");

// The sentence around a hit: bullets end a sentence too.
function sentenceAround(text, index, length) {
  const before = text.slice(0, index);
  const start = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("•"), index - 200) + 1;
  const after = text.slice(index + length);
  const ends = [".", "!", "?", "•"].map((c) => after.indexOf(c)).filter((i) => i >= 0);
  const end = index + length + Math.min(ends.length ? Math.min(...ends) + 1 : after.length, 200);
  return text.slice(Math.max(0, start), end).replace(/\s*•$/, "").trim();
}

/**
 * @param {string} description job description, plain text or HTML
 * @returns {{ refuses: boolean, kind: "NO_SPONSORSHIP"|"WORK_RIGHTS"|"CITIZENS_ONLY"|"CLEARANCE"|null, quote: string|null }}
 */
export function detectAuNoSponsorship(description) {
  const text = squash(description);
  if (!text.trim()) return { refuses: false, kind: null, quote: null };

  // The shared "we cannot sponsor" wording. Its US citizenship and clearance
  // rules do not describe an Australian job, so only NO_SPONSORSHIP counts.
  const shared = detectNoSponsorship(text);
  if (shared.refuses && shared.kind === "NO_SPONSORSHIP") return shared;

  for (const [kind, re] of RULES) {
    const g = new RegExp(re.source, `${re.flags.replace("g", "")}g`);
    for (const m of text.matchAll(g)) {
      const sentence = sentenceAround(text, m.index, m[0].length);
      if (SOFT.test(sentence) || !MUST.test(sentence)) continue;
      return { refuses: true, kind, quote: sentence.slice(0, 240) };
    }
  }
  return { refuses: false, kind: null, quote: null };
}
