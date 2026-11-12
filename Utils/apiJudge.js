// The judge for API-sourced jobs.
//
// A job from the Adzuna API must be judged by exactly the same standard as one
// the extension scraped, or a client would get different work depending on
// where it came from. The rules below are the extension's own judge prompt
// (jr-direct-extension/background.js SYSTEM_PROMPT), copied here on
// 2026-09-29 with one section changed: scraped cards carry the site's own
// match score and API results do not, so the paragraph about that score is
// replaced by an explicit statement that there is none.
//
// The extension remains the source of truth for these rules. They live in a
// different repository, so this is a copy and copies drift - if you change
// the judging rules there, change them here in the same breath.
//
// TITLE-LEVEL, ON PURPOSE. The judge is given the title, employer, location
// and category, and no job description. That is not an omission: sending the
// description made the model read an employer's wish list as entry conditions
// and skip good candidates. Adzuna's description is truncated to 500
// characters anyway.

export const API_JUDGE_PROMPT = `You are a recruiter deciding which jobs to put in front of one candidate.

You judge on the JOB TITLE. That is deliberate. There is no job description in
this prompt and none is coming. Never skip a job because you cannot see its
requirements, and never invent requirements you were not given.

You get three things, and they are everything you need:
  1. "## Candidate hard signals" - fields from the client's own profile.
  2. "## Candidate brief" - a written summary of who they are and what they
     want. This is the main description of the candidate; read it properly.
  3. "## Jobs to judge" - the batch, each with its title, employer,
     location and category.

Nothing downstream will correct you, so a wrong skip means the candidate never
sees that job.

Return STRICT JSON only - no prose, no markdown:
{"decisions":[{"id":"<jobId>","pick":<true|false>,"score":<0-100>,"reason":"<one sentence, 90-160 chars>","matchedRole":"<the preferredRole this maps to, or '' for a skip>","skipKind":"<see below, '' for picks>"}]}

skipKind - required on every skip, empty string on every pick:
  "role-mismatch"     a different line of work from what this candidate does
  "intern"            an internship/co-op and the brief does not ask for one
  "excluded"          the title matches an entry in excludedRoles
  "company-blocked"   the employer is in excludedCompanies or operatorExclusions
  "auth-mismatch"     the TITLE itself demands citizenship or a clearance they lack
  "threshold"         scored below the operator's threshold

THE DECISION

First: is the title, translated to English if needed, one of the
candidate's preferredRoles or plainly the same work? Then it is a PICK. The
candidate asked for that role by name. Score it by fit (sector, seniority,
how close the past jobs are), but do not skip it for experience, sector,
"focus", or because it differs from their past jobs. Only an exclusion list,
an internship they do not want, or a title that demands an authorisation
they lack can skip a preferredRole.

Otherwise ask one question: would a recruiter send this candidate's CV for
this title and not be embarrassed?

  Yes, even at a stretch  -> pick it, with a score that reflects how good it is.
  No                      -> skip it.

That is the whole test. Be fair, not strict. Be generous at the edges: a
near-miss the candidate can decline costs them one click, a wrong skip costs
them the opportunity. When you genuinely cannot tell,
PICK IT with a lower score.

WHAT IS AND IS NOT A ROLE MISMATCH

role-mismatch means a DIFFERENT LINE OF WORK - the day-to-day job is not the
job this person does. Selling a technical product is not building it.
Supporting software is not writing it. Analysing data is not engineering the
pipeline. Managing a project is not doing the discipline being managed.

It is NOT a role mismatch when:
  - The title is in another language. Judge the "titleEnglish" given with
    it when there is one, otherwise translate it yourself: "Acheteur" is Buyer, "Analyste" is Analyst, "Ingenieur" is
    Engineer, "Einkaeufer" is Buyer, "Inkoper" is Buyer, "Comprador" is Buyer.
    Ignore gender tags such as "(H/F)", "F/H" or "(m/w/d)".
  - The title is one of the candidate's preferredRoles, in any language or
    wording. Every preferredRole is work they asked for, even when it differs
    from their past jobs or from the main thread of the brief.
  - The title is worded differently for the same work - synonyms,
    abbreviations, re-orderings, or a qualifier bolted on the front.
  - It is a neighbouring speciality within the same line of work.
  - The industry, employer size, or tools differ.

Use the brief to judge this, not a keyword overlap with preferredRoles. Two
titles sharing a word can be different jobs; two titles sharing no words can
be the same job. You know what these roles actually involve - apply that.

NEVER A REASON TO SKIP

  - SENIORITY. Junior, entry, mid, senior, staff, lead, principal, director,
    VP, and unlabelled titles are all acceptable whatever the candidate's own
    level. Never write "too senior", "too junior", "is a junior role", "levels
    above", "over-qualified", or "requires N years". If level is your only
    objection it is a PICK with a lower score. Writing that reasoning under
    another skipKind is the same mistake with a different label.
  - LOCATION. Remote, hybrid, onsite, any city, any country, any relocation.
    Where the job is never rejects it. Work authorisation is separate and does
    still count - but only when the TITLE says so, since you cannot see a
    posting's clauses.
  - SKILLS. You are not shown what the employer asks for. Do not guess it, do
    not assume a tool or a certification is required, and never skip on one. A
    skill you suspect is missing LOWERS THE SCORE at most. It never skips.
  - INDUSTRY OR SECTOR. "Prioritise aerospace", "focus on fintech", "prefers
    healthcare" in the brief RAISE the score of jobs in that sector. They do
    not narrow the search: a preferredRole at an employer outside that sector
    is still a PICK, with a lower score. Never write "focuses on <sector>" as
    the reason for a skip. Only an explicit "only <sector>" or "skip
    non-<sector>" in the brief makes the sector a requirement.

EXCLUSIONS ARE DATA - NEVER INFERRED

"## Candidate hard signals" carries excludedRoles, excludedCompanies,
operatorExclusions and wantsInternships. Those lists are the complete and only
grounds for an exclusion skip.

If a list is empty, that rule does not exist for this candidate - emit no skip
of that kind for any reason. You must be able to point at the exact entry you
matched, and quote it in the reason. If you cannot, it is a pick.

An employer's name is not an excluded role. A recruitment agency, consultancy
or staffing firm is not blocked unless it is named in one of those lists. A
common word in a title is not an exclusion unless it is literally listed.

EMPLOYMENT TYPE: FTC IS A FIXED-TERM CONTRACT

"FTC" in a title means Fixed-Term Contract - a contract role with an end date.
So are "Fixed Term", "Fixed-Term", "FTC - 12 Months", "12 Month FTC",
"Maternity Cover" and "Mat Cover". Read every one of them as the Contract
employment type, whatever line of work the title describes.

The candidate brief states which employment types this client accepts. Honour it:
  - The brief accepts contract -> an FTC title is fine; judge it on the work
    like any other title.
  - The brief says to skip contract / fixed-term / FTC roles -> skip the FTC
    title with skipKind "excluded", and quote that brief line in your reason.

Most clients are full-time only, so their brief will say to skip contract
roles. An FTC title is NOT a role-mismatch - the work can fit perfectly. It is
the fixed contract term the client is declining, so label it as above, never
"role-mismatch".

THERE IS NO SITE MATCH SCORE

These jobs came from a job-board API, not from a site that scores candidates.
Nothing here has been pre-judged for fit, so every decision is yours alone.
Judge the title against the brief exactly as described above.

SCORE

Score every job 0-100 on how well the title suits this candidate: how close
the work is to what they do. The operator's threshold decides the
borderline cases, so score honestly - a weak but legitimate job should get a
low score, not a skip.

matchedRole is a claim the operator sees on the card. Name the preferredRole
this job genuinely is. If you cannot name one, you have a role-mismatch, not a
pick with a vague matchedRole.

REASONS

One sentence, 90-160 characters, plain English, concrete. Say what the job is
and why it does or does not suit this person. Never "good fit", "not a match",
"strong alignment" or "see JD".

  PICK   "Pick - '<title>' suits '<preferredRole>'; <what makes it fit>."
  SKIP   "Skip - '<title>' is <what it actually is>; this candidate does <what
          they do>."

For an exclusion skip, quote the list entry you matched verbatim.`;

import "dotenv/config";
import { recordAiUsage, AI_USAGE_SOURCES } from "./aiUsage.js";
import { getAppSettings } from "../Schema_Models/AppSettings.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.OPENAI_JUDGE_MODEL || "gpt-4o-mini";
const TIMEOUT_MS = Number(process.env.OPENAI_JUDGE_TIMEOUT_MS) || 25000;

// Same batch size the extension uses, for the same reason: one batch is one
// API call, and a batch big enough to blow the context window judges nothing.
const BATCH = 20;

// Inside one list entry, several roles are often typed together:
// ["CAMO Engineer/ Technical Services Engineer/ Buyer"]. Sent as one string,
// the model read it as a single CAMO-led role and skipped every Buyer job.
// Only a slash with a space beside it separates roles, so "AI/ML Engineer"
// and "Acheteur/Acheteuse" stay whole; "|" and ";" always separate.
const ENTRY_SPLIT = /\s*[|;]\s*|\s+\/\s*|\s*\/\s+/;

const asList = (v) => {
  if (Array.isArray(v)) {
    return v.filter(Boolean).flatMap((s) => String(s).split(ENTRY_SPLIT)).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof v === "string") return v.split(/\s*[/|,]\s*/).map((s) => s.trim()).filter(Boolean);
  return [];
};

// Clients sometimes type negatives into preferredRoles ("Do not add Technician
// roles"). Split them out so the model gets an explicit excluded list instead
// of a "preferred role" it should avoid. Mirrors the extension's splitRoles.
const NEG_LEAD = /^\s*(?:do\s*not|don'?t|no(?:t|pe)?|avoid|exclude|skip|never|reject|remove|drop)\s*(?:add|include|consider|show|pick|push|send|want)?\b\s*/i;
const ROLE_NOUNS = /\b(?:roles?|positions?|jobs?|titles?)\b/gi;

export function splitRoles(raw) {
  const preferred = [];
  const excluded = [];
  for (const piece of asList(raw)) {
    if (NEG_LEAD.test(piece)) {
      const cleaned = piece.replace(NEG_LEAD, "").replace(ROLE_NOUNS, "").trim();
      if (cleaned) excluded.push(cleaned);
    } else {
      preferred.push(piece);
    }
  }
  return { preferred, excluded };
}

// European job titles, word for word in English. gpt-4o-mini picked "Buyer" at
// 80 and skipped "Acheteur projets (H/F)" while writing "is a Buyer role" in
// its own reason (2026-10-23), so the translation is handed over rather than
// left to the model. Only the common job words: anything not listed stays as
// typed, and a title with nothing to translate gets no gloss.
// Word boundaries are Unicode-aware: JavaScript's \b treats "é" as a
// non-letter, so "Confirmé" never matched with it.
const word = (src) => new RegExp(`(?<!\\p{L})(?:${src})(?!\\p{L})`, "giu");
const TITLE_GLOSSARY = [
  [word("acheteur|acheteuse|eink[aä]ufer(?:in)?|inkoper|comprador(?:a)?"), "Buyer"],
  [word("responsable (?:des )?achats?"), "Purchasing Manager"],
  [word("achats?|einkauf|inkoop|compras|acquisti"), "Purchasing"],
  [word("approvisionneur|approvisionneuse"), "Procurement Planner"],
  [word("analyste|analytiker(?:in)?|analista"), "Analyst"],
  [word("ing[ée]nieur(?:e)?|ingenieur(?:in)?|ingeniero|ingegnere"), "Engineer"],
  [word("chef de projets?"), "Project Manager"],
  [word("responsable|leiter(?:in)?|jefe|responsabile"), "Manager"],
  [word("technicien(?:ne)?|techniker(?:in)?|t[ée]cnico"), "Technician"],
  [word("stagiaire|stage|praktikum|tirocinio|pr[aá]cticas"), "Internship"],
  [word("apprenti(?:e)?|alternance|alternant(?:e)?|ausbildung"), "Apprenticeship"],
  [word("navigabilit[ée]"), "Airworthiness"],
  [word("a[ée]ronautique"), "Aerospace"],
  [word("confirm[ée]e?"), "Experienced"],
  [word("strat[ée]gique"), "Strategic"],
  [word("industriel(?:le)?"), "Industrial"],
  [word("projets?"), "Projects"],
  // Gender tags: (H/F), F/H, (m/w/d), F/H/D.
  [/\s*[(\[]?(?<!\p{L})(?:h\s*\/\s*f|f\s*\/\s*h(?:\s*\/\s*d)?|m\s*\/\s*[wf]\s*\/\s*d)(?!\p{L})[)\]]?/giu, ""],
];

export function englishGloss(title) {
  const original = String(title || "");
  let out = original;
  for (const [re, en] of TITLE_GLOSSARY) out = out.replace(re, en);
  out = out.replace(/\s{2,}/g, " ").replace(/\s+([,)])/g, "$1").trim();
  return out && out.toLowerCase() !== original.trim().toLowerCase() ? out : "";
}

/**
 * The user half of the prompt: who the candidate is, then the batch.
 *
 * Mirrors the extension's buildUserPrompt - hard signals quoted verbatim from
 * the profile so the model can cite the exact strings the operator edits, then
 * the brief, then the jobs stripped to what a title-level decision needs.
 */
export function buildUserPrompt({ profile = {}, aiSummary = "", jobs = [], threshold = 50 }) {
  const { preferred, excluded } = splitRoles(profile.preferredRoles);
  const locations = asList(profile.preferredLocations);
  const hardSignals = {
    preferredRoles: preferred.length ? preferred : "(not specified - fall back to the brief)",
    excludedRoles: excluded,
    experienceLevel: profile.experienceLevel || "(not specified)",
    preferredLocations: locations.length ? locations : "(not specified)",
    workAuth: profile.usWorkEligibility || profile.visaStatus || "(not specified)",
    excludedCompanies: profile.excludedCompanies || profile.removedCompanies || [],
    wantsInternships: false,
  };
  const slim = jobs.map((j) => ({
    id: j.jobId,
    title: j.title,
    ...(englishGloss(j.title) ? { titleEnglish: englishGloss(j.title) } : {}),
    company: j.company,
    location: j.location,
    category: j.category || "",
  }));
  const brief = aiSummary
    ? `## Candidate brief (use for nuance - but hard signals above win on conflict):\n${aiSummary}\n`
    : `## Candidate raw profile (no AI summary built yet):\n${JSON.stringify({ targetCompanies: profile.targetCompanies || "" }, null, 2)}\n`;

  return `Threshold: ${threshold}

## Candidate hard signals (AUTHORITATIVE - quote these exact role strings in your reason)
${JSON.stringify(hardSignals, null, 2)}

${brief}
## Jobs to judge (one decision per id below):
${JSON.stringify(slim, null, 2)}`;
}

const VALID_SKIP_KINDS = new Set([
  "role-mismatch", "intern", "excluded", "company-blocked", "auth-mismatch", "threshold",
]);

/** Normalise one model verdict; never trust its shape. */
function normalise(d, threshold) {
  const pick = d?.pick === true;
  const score = Number.isInteger(d?.score) ? d.score : 0;
  const out = {
    id: String(d?.id || ""),
    pick,
    score,
    reason: typeof d?.reason === "string" ? d.reason : "",
    matchedRole: typeof d?.matchedRole === "string" ? d.matchedRole : "",
    skipKind: pick ? "" : (VALID_SKIP_KINDS.has(String(d?.skipKind || "").trim()) ? d.skipKind.trim() : "threshold"),
  };
  // The operator's threshold is the one number the model does not get the
  // last word on: a job it rates below the bar is not a job to send.
  if (out.pick && score < threshold) {
    return { ...out, pick: false, skipKind: "threshold", matchedRole: "",
             reason: `Skip - the AI scored this ${score}, under the operator's ${threshold} threshold.` };
  }
  return out;
}

/**
 * Judge a batch of mapped jobs. Returns { ok, decisions } and never throws.
 *
 * `callOpenAi` is injectable so the tests exercise the real batching,
 * normalising and threshold logic without spending money or needing a key.
 */
export async function judgeJobs(
  { profile, aiSummary, jobs, threshold = 50 },
  callOpenAi = defaultCallOpenAi,
) {
  if (!Array.isArray(jobs) || jobs.length === 0) return { ok: true, decisions: [] };

  const decisions = [];
  for (let i = 0; i < jobs.length; i += BATCH) {
    const batch = jobs.slice(i, i + BATCH);
    const user = buildUserPrompt({ profile, aiSummary, jobs: batch, threshold });
    let raw;
    try {
      raw = await callOpenAi({ system: API_JUDGE_PROMPT, user });
    } catch (e) {
      return { ok: false, error: "JUDGE_THREW", message: String(e?.message || e), decisions };
    }
    if (!raw?.ok) return { ok: false, error: raw?.error || "JUDGE_FAILED", message: raw?.message, decisions };

    let parsed = null;
    try {
      parsed = JSON.parse(raw.content || "{}");
    } catch { /* handled below */ }
    if (!parsed || !Array.isArray(parsed.decisions)) {
      return { ok: false, error: "BAD_AI_JSON", message: String(raw.content || "").slice(0, 300), decisions };
    }
    // A job the model simply left out must not silently become a pick.
    const byId = new Map(parsed.decisions.map((d) => [String(d?.id || ""), d]));
    for (const job of batch) {
      const d = byId.get(job.jobId);
      decisions.push(d
        ? normalise(d, threshold)
        : { id: job.jobId, pick: false, score: 0, matchedRole: "", skipKind: "threshold",
            reason: "Skip - the judge returned no verdict for this job." });
    }
  }
  return { ok: true, decisions };
}

/**
 * The key, resolved the way every other AI path in this backend resolves it:
 * the environment first, then the global key operators set from the admin
 * page. This judge originally read process.env alone, which made it the one
 * AI feature that could not use the global key - so rotating that key fixed
 * the summaries, the templates and the extension while API-mode runs kept
 * failing on their own.
 */
async function resolveOpenAIKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  try {
    const settings = await getAppSettings();
    if (settings?.globalOpenaiKey) return String(settings.globalOpenaiKey).trim();
  } catch (_) {
    /* the global key is a fallback; a settings read that fails is not fatal */
  }
  return "";
}

async function defaultCallOpenAi({ system, user }) {
  const apiKey = await resolveOpenAIKey();
  if (!apiKey) return { ok: false, error: "NO_OPENAI_KEY" };
  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_object" },
        temperature: 0,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, error: "NETWORK", message: String(e?.message || e) };
  }
  if (!res.ok) return { ok: false, error: `OPENAI_${res.status}`, message: (await res.text()).slice(0, 300) };
  const body = await res.json();
  try {
    await recordAiUsage({
      source: AI_USAGE_SOURCES?.EXTENSION_JUDGE || "extension-judge",
      model: MODEL,
      inputTokens: body?.usage?.prompt_tokens || 0,
      outputTokens: body?.usage?.completion_tokens || 0,
    });
  } catch { /* usage accounting must never fail a judge */ }
  return { ok: true, content: body?.choices?.[0]?.message?.content || "{}", usage: body?.usage || {} };
}

export const JUDGE_BATCH_SIZE = BATCH;
