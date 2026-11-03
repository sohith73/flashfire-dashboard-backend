// Does a job description say the employer will NOT sponsor a visa?
//
// The US sponsor list (usVisaSponsor.js) answers "has this employer ever filed
// H-1Bs?". That is a company-level fact: Milliman and Susquehanna file
// hundreds a year, yet some of their postings say "we cannot sponsor for this
// role". Only the posting can tell, so the "US H-1B sponsors only" gate reads
// it too.
//
// Three kinds of refusal, each a reason the extension and clients-tracking show:
//   NO_SPONSORSHIP  "unable to sponsor", "without sponsorship", "no visa sponsorship"
//   CITIZENS_ONLY   "must be a U.S. citizen", "green card holders only"
//   CLEARANCE       "active Secret clearance required" (needs US citizenship)
//
// What is deliberately NOT a refusal:
//   - the application question "Will you now or in the future require
//     sponsorship?" (asked by employers who sponsor, too)
//   - "sponsorship available", "we sponsor H-1B", "open to sponsorship"
//   - "clearance preferred" / "ability to obtain a clearance" (most such
//     roles still hire green card holders, and some sponsor)
//
// Precision matters more than recall: a false hit throws away a good job
// without anyone seeing it. Measured on staging (see the test file) against
// jobs clients removed for sponsorship and a random sample of applied jobs.

const MAX_SCAN = 60000;

// "not", "unable to", "cannot", ... : every way a posting says no.
const NEG = String.raw`(?:no|not|never|unable\s+to|cannot|can\s*not|can['’]?t|won['’]?t|will\s+not|does\s+not|doesn['’]?t|do\s+not|don['’]?t|is\s+not\s+able\s+to|are\s+not\s+able\s+to|not\s+able\s+to|not\s+in\s+a\s+position\s+to)`;
// Words that may sit between the negation and "sponsor".
const FILLER = String.raw`(?:\s+(?:currently|presently|at\s+this\s+time|now|be\s+able\s+to|be|able\s+to|provide|offer|offering|support|supporting|consider|considering|accept|accepting|pursue|available\s+for|eligible\s+for|any|an?|the|for|or|future|current|and(?:\/or)?|employer|employment|work|immigration|visa|visas|h-?1-?b|h1b|opt|cpt|stem|candidates?|applicants?|individuals?|those|who|that|which|require|requires|requiring|need|needs|needing|us|u\.s\.|to|in|company|corporate|authorization|status|new|of))*`;

const RULES = [
  // "we are unable to sponsor", "does not offer visa sponsorship", "will not consider candidates who require sponsorship"
  ["NO_SPONSORSHIP", new RegExp(String.raw`\b${NEG}${FILLER}\s+sponsor(?:ship|ing|s|ed)?\b`, "i")],
  // "without (the need for) (current or future) (visa) sponsorship"
  ["NO_SPONSORSHIP", new RegExp(String.raw`\bwithout${FILLER}(?:\s+(?:the\s+)?need(?:\s+for)?)?${FILLER}\s+sponsorship\b`, "i")],
  // "sponsorship is not available", "sponsorship will not be provided"
  ["NO_SPONSORSHIP", /\b(?:visa\s+|h-?1-?b\s+|immigration\s+|employment\s+)?sponsorship\s+(?:is\s+|will\s+)?(?:not|un)\s*(?:be\s+)?(?:available|provided|offered|supported|possible|considered)\b/i],
  // "Visa sponsorship: No", "Sponsorship - not available", "Sponsorship: none"
  ["NO_SPONSORSHIP", /\bsponsorship\s*(?:available|offered)?\s*[:\-–]\s*(?:no\b|none\b|not\s+available|n\/a\b)/i],
  // "must be authorized to work for any employer in the U.S." is the standard
  // way to say no H-1B: an H-1B ties the worker to one employer.
  ["NO_SPONSORSHIP", /\bauthori[sz]ed\s+to\s+work\s+for\s+any\s+(?:u\.?\s?s\.?\s+)?employer\b/i],
  // "not eligible for sponsorship", "ineligible for visa sponsorship"
  ["NO_SPONSORSHIP", /\b(?:not\s+|in)eligible\s+for\s+(?:visa\s+|h-?1-?b\s+|employment\s+|immigration\s+)?sponsorship\b/i],
  // "candidates who require sponsorship cannot be considered"
  ["NO_SPONSORSHIP", /\brequir(?:e|es|ing)\b[^.?!]{0,60}\bsponsorship\b[^.?!]{0,60}\b(?:cannot|can\s*not|will\s+not|won['’]t)\s+be\s+considered\b/i],
  // "U.S. citizenship is required", "must be a US citizen", "US citizens only"
  ["CITIZENS_ONLY", /\b(?:u\.?\s?s\.?|united\s+states)\s+citizenship\s+(?:is\s+)?(?:required|mandatory|is\s+a\s+requirement)\b/i],
  ["CITIZENS_ONLY", /\bmust\s+(?:be|hold)\s+(?:a\s+)?(?:u\.?\s?s\.?|united\s+states)\s+(?:citizen|citizenship|national)\b/i],
  ["CITIZENS_ONLY", /\b(?:only\s+)?(?:u\.?\s?s\.?|united\s+states)\s+citizens\s+only\b|\bonly\s+(?:u\.?\s?s\.?|united\s+states)\s+citizens\b/i],
  ["CITIZENS_ONLY", /\b(?:u\.?\s?s\.?|united\s+states)\s+citizens?\s+(?:or|and\/or|\/)\s+(?:permanent\s+residents?|green\s+card\s+holders?|lawful\s+permanent\s+residents?)\s+only\b/i],
  ["CITIZENS_ONLY", /\bgreen\s+card\s+holders?\s+only\b/i],
  // "US Citizen or Green Card", "U.S. citizen or permanent resident required" (a requirement line, not EEO text)
  ["CITIZENS_ONLY", /\b(?:u\.?\s?s\.?|united\s+states)\s+citizen(?:ship)?\s+(?:or|\/)\s+(?:a\s+)?(?:green\s+card(?:\s+holder)?|(?:lawful\s+)?permanent\s+resident(?:cy)?)\b(?!\s+(?:status\s+)?(?:is\s+)?(?:preferred|a\s+plus))/i],
  // "US Citizenship and ability to obtain a clearance"
  ["CITIZENS_ONLY", /\b(?:u\.?\s?s\.?|united\s+states)\s+citizenship\s+and\s+(?:the\s+)?(?:must\s+be\s+)?(?:able|ability)\s+to\s+obtain\b/i],
  // export control: "candidate must be a U.S. Person" (citizen, permanent resident, asylee)
  ["CITIZENS_ONLY", /\bmust\s+be\s+(?:a\s+)?(?:u\.?\s?s\.?)\s+person\b/i],
  ["CITIZENS_ONLY", /\brequires?\s+(?:u\.?\s?s\.?|united\s+states)\s+citizenship\b/i],
  // "active Secret clearance required", "must possess a TS/SCI clearance"
  ["CLEARANCE", /\b(?:active|current|existing)\s+(?:dod\s+)?(?:secret|top\s+secret|ts\s*\/\s*sci|ts|public\s+trust)\s+(?:security\s+)?clearance\s+(?:is\s+)?(?:required|is\s+a\s+must|needed)\b/i],
  ["CLEARANCE", /\bmust\s+(?:have|possess|hold)\s+(?:an?\s+)?(?:valid\s*\/?\s*)?(?:current\s+)?(?:active|current)\b[^?!•]{0,50}?\bclearance\b/i],
];

// A hit inside one of these is not a refusal.
const NOT_A_REFUSAL = [
  // "Will you now, or in the future, require sponsorship?" and friends
  /\b(?:will|do|would)\s+you\s+(?:now\s+)?(?:or\s+in\s+the\s+future\s+)?(?:,\s*)?(?:now\s+or\s+in\s+the\s+future\s*,?\s+)?require\b[^?.]{0,120}\?/i,
  // "We do not discriminate ... ", "not limited to"
  /\bnot\s+limited\s+to\b/i,
];

const squash = (s) => String(s ?? "")
  .slice(0, MAX_SCAN)
  // Some boards send the HTML escaped ("&lt;span&gt;"): unescape, then strip.
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/\s+/g, " ");

// The sentence around a hit, so the "Will you require ...?" check sees the
// question mark and the message can quote what the posting said.
// Bullets ("•") end a sentence too: scraped descriptions often have no periods.
const STOPS = [".", "?", "!", "•"];
// The "." in "U.S." or "U.K." is not the end of a sentence.
const isStop = (text, i) => text[i] !== "." || !(/[A-Z]/.test(text[i - 1] || "") && /[.\s]/.test(text[i - 2] || " "));
const lastStop = (text, c, from) => { let i = text.lastIndexOf(c, from); while (i >= 0 && !isStop(text, i)) i = text.lastIndexOf(c, i - 1); return i; };
const nextStop = (text, c, from) => { let i = text.indexOf(c, from); while (i >= 0 && !isStop(text, i)) i = text.indexOf(c, i + 1); return i; };
function sentenceAround(text, index, length) {
  const start = Math.max(...STOPS.map((c) => lastStop(text, c, index)), index - 200) + 1;
  const ends = STOPS.map((c) => nextStop(text, c, index + length)).filter((i) => i >= 0);
  const end = Math.min(ends.length ? Math.min(...ends) + 1 : text.length, index + length + 200);
  return text.slice(Math.max(0, start), end).replace(/\s*•$/, "").trim();
}

/**
 * @param {string} description job description, plain text or HTML
 * @returns {{ refuses: boolean, kind: "NO_SPONSORSHIP"|"CITIZENS_ONLY"|"CLEARANCE"|null, quote: string|null }}
 */
export function detectNoSponsorship(description) {
  const text = squash(description);
  if (!text.trim()) return { refuses: false, kind: null, quote: null };
  for (const [kind, re] of RULES) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(g)) {
      const sentence = sentenceAround(text, m.index, m[0].length);
      if (NOT_A_REFUSAL.some((x) => x.test(sentence))) continue;
      return { refuses: true, kind, quote: sentence.slice(0, 240) };
    }
  }
  return { refuses: false, kind: null, quote: null };
}
