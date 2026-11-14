// Does a European job posting say it will NOT take a candidate who needs a
// visa? The European sibling of noSponsorshipText.js (US) and
// auNoSponsorshipText.js, used by "Europe visa sponsors only" (euVisaSponsor.js).
//
//   WORK_RIGHTS    "you must have the right to work in the EU / Netherlands",
//                  "a valid EU work permit is required", "Stamp 4 required" (Ireland)
//   CITIZENS_ONLY  "EU citizens only", "only candidates with an EU passport"
//   NO_SPONSORSHIP the plain "no visa sponsorship" wording, from the shared
//                  rules in noSponsorshipText.js
//
// Not refusals: "right to work preferred", "please confirm your right to work",
// "we sponsor work permits". Precision beats recall: a false hit throws away a
// good job unseen.

import { detectNoSponsorship } from "./noSponsorshipText.js";

const MAX_SCAN = 60000;

const PLACE = String.raw`(?:the\s+)?(?:eu|e\.u\.|eea|european\s+union|european\s+economic\s+area|europe|schengen(?:\s+area)?|netherlands|ireland|germany|france|finland|switzerland|slovenia|spain|italy|portugal|belgium|austria|sweden|denmark|norway|poland|luxembourg)`;

// A requirement, not a nice-to-have, somewhere in the same sentence.
const MUST = /\b(?:must|required|requires?|requirement|essential|mandatory|only|need(?:s|ed)?\s+to|will\s+need|eligible|eligibility|necessary|prerequisite|without\s+(?:the\s+)?need)\b/i;
const SOFT = /\b(?:preferred|desirable|advantageous|an?\s+advantage|a\s+plus|nice\s+to\s+have|bonus|ideally)\b/i;

const RULES = [
  // "the right to work in the EU", "existing right to work in the Netherlands"
  ["WORK_RIGHTS", new RegExp(String.raw`\b(?:right|authori[sz]ation|eligib(?:le|ility)|permission|authori[sz]ed)\s+to\s+work\s+(?:in|within|across|throughout)\s+${PLACE}\b`, "i")],
  // "valid EU work permit", "EU/EEA work authorisation"
  ["WORK_RIGHTS", new RegExp(String.raw`\b(?:valid\s+)?(?:eu|eea|eu\s*\/\s*eea|european)\s+(?:work|working)\s+(?:permit|authori[sz]ation|visa|rights)\b`, "i")],
  // Ireland: Stamp 4 is permission to work without an employment permit.
  ["WORK_RIGHTS", /\bstamp\s*4\b/i],
  // "EU citizens only", "EU nationals only", "EU/EEA citizenship is required"
  ["CITIZENS_ONLY", new RegExp(String.raw`\b${PLACE}\s+(?:citizens?(?:hip)?|nationals?|nationality|passport(?:\s+holders?)?)\b`, "i")],
];

const squash = (s) => String(s ?? "")
  .slice(0, MAX_SCAN)
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/\s+/g, " ");

// The sentence around a hit; bullets end a sentence too.
function sentenceAround(text, index, length) {
  const before = text.slice(0, index);
  const start = Math.max(before.lastIndexOf(". "), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("•"), index - 200) + 1;
  const after = text.slice(index + length);
  const ends = [". ", "!", "?", "•"].map((c) => after.indexOf(c)).filter((i) => i >= 0);
  const end = index + length + Math.min(ends.length ? Math.min(...ends) + 1 : after.length, 200);
  return text.slice(Math.max(0, start), end).replace(/\s*•$/, "").trim();
}

/**
 * @param {string} description job description, plain text or HTML
 * @returns {{ refuses: boolean, kind: "NO_SPONSORSHIP"|"WORK_RIGHTS"|"CITIZENS_ONLY"|null, quote: string|null }}
 */
export function detectEuNoSponsorship(description) {
  const text = squash(description);
  if (!text.trim()) return { refuses: false, kind: null, quote: null };

  // The shared "we cannot sponsor" wording. Its US citizenship and clearance
  // rules do not describe a European job, so only NO_SPONSORSHIP counts.
  const shared = detectNoSponsorship(text);
  if (shared.refuses && shared.kind === "NO_SPONSORSHIP") return shared;

  for (const [kind, re] of RULES) {
    const g = new RegExp(re.source, `${re.flags.replace("g", "")}g`);
    for (const m of text.matchAll(g)) {
      const sentence = sentenceAround(text, m.index, m[0].length);
      if (SOFT.test(sentence) || !MUST.test(sentence)) continue;
      // "We welcome EU and non-EU nationals" / "regardless of nationality".
      if (/\bnon[-\s]?eu\b|regardless\s+of|irrespective\s+of|we\s+(?:can\s+|will\s+)?sponsor/i.test(sentence)) continue;
      return { refuses: true, kind, quote: sentence.slice(0, 240) };
    }
  }
  return { refuses: false, kind: null, quote: null };
}
