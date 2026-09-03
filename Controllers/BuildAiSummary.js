// BuildAiSummary: server-side candidate brief builder.
//
// Input  : POST /build-ai-summary  { email }
// Output : { success, aiSummary, wordCount, source, model, builtAt }
//
// Flow:
//   1. Validate env (OPENAI_API_KEY, RESUME_API_URL).
//   2. Load client profile from Mongo.
//   3. Fetch parsed resume from gemini-resume backend (best-effort —
//      profile-only fallback if missing).
//   4. Call OpenAI chat.completions (gpt-4o-mini) with the structured
//      "candidate brief" prompt below.
//   5. Persist aiSummary + aiSummaryMeta on the profile document.
//   6. Return the new summary.
//
// All network IO uses axios. Failures return the precise step + status
// + body snippet so the JR-direct extension can show meaningful errors
// instead of a generic "no detail".

import axios from "axios";
import { recordAiUsage, AI_USAGE_SOURCES } from "../Utils/aiUsage.js";
import { ProfileModel } from "../Schema_Models/ProfileModel.js";
import { getAppSettings } from "../Schema_Models/AppSettings.js";
import { mergeOverlay, mergeWithLocks, countOverlayBullets, parseSections, extractProvenance, provenanceForText } from "../Utils/summaryOverlay.js";

const RESUME_API_URL = process.env.RESUME_API_URL || "http://localhost:5000";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
// Per-call timeout for the OpenAI chat.completions requests. The structured
// brief is a large prompt and on a small Render instance a single call can
// legitimately run past 60s — which surfaced as OPENAI_NETWORK "timeout of
// 60000ms exceeded" and a failed build. Now that the build is fully async
// (POST /build-ai-summary returns 202, no proxy in the path) the only ceiling
// is this value, so give it real headroom. Override with OPENAI_TIMEOUT_MS.
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS) || 180_000;

// Wall-clock ceiling for ONE whole build (resume fetch + every OpenAI call).
// Without it the pieces multiply: 3 round-1 attempts x (180s + a 180s network
// retry) + a 180s notes pass is ~24 min, far past the window the status
// endpoint and the clients-tracking poller are willing to wait. Every OpenAI
// call is clamped to the time left in this budget, and the round-1 reroll loop
// stops once there isn't room for another full attempt.
const BUILD_BUDGET_MS = Number(process.env.SUMMARY_BUILD_BUDGET_MS) || 8 * 60 * 1000;
// Don't start an OpenAI call with less than this left — it would only abort.
const MIN_CALL_MS = 15_000;
// A build still flagged "building" this long after it started is treated as
// dead (process restarted mid-build) so a fresh trigger can claim it. MUST
// stay above BUILD_BUDGET_MS: while a build is legitimately running, the
// status endpoint would otherwise report a stale "done"/"error" and the
// clients-tracking poller would show the PREVIOUS build's word count as if it
// were the new one.
const BUILD_STALE_MS = BUILD_BUDGET_MS + 90_000;

// msLeft — milliseconds remaining before `deadlineAt` (epoch ms). Returns
// Infinity when no deadline was threaded through (direct/legacy callers).
function msLeft(deadlineAt) {
  if (!deadlineAt) return Infinity;
  return deadlineAt - Date.now();
}

// postOpenAI — axios POST to chat.completions with one retry on a timeout /
// transient network abort (ECONNABORTED / ECONNRESET / no response). A real
// HTTP error (4xx/5xx with a body) is NOT retried — it re-throws immediately.
// `deadlineAt` clamps both the per-call timeout and whether the retry is even
// attempted, so a build can never outrun BUILD_BUDGET_MS.
async function postOpenAI(body, apiKey, deadlineAt = 0) {
  const budget = () => Math.min(OPENAI_TIMEOUT_MS, msLeft(deadlineAt));
  const first = budget();
  if (first < MIN_CALL_MS) {
    const err = new Error(`build budget exhausted (${Math.round(first / 1000)}s left)`);
    err.code = "EBUDGET";
    throw err;
  }
  const cfg = {
    timeout: first,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey || OPENAI_API_KEY}`,
    },
  };
  try {
    return await axios.post("https://api.openai.com/v1/chat/completions", body, cfg);
  } catch (err) {
    const transient = !err.response
      && (err.code === "ECONNABORTED" || err.code === "ECONNRESET" || err.code === "ETIMEDOUT");
    if (!transient) throw err;
    const retryTimeout = budget();
    if (retryTimeout < MIN_CALL_MS) {
      console.warn(`[BuildAiSummary] OpenAI call ${err.code} — no budget left to retry`);
      throw err;
    }
    console.warn(`[BuildAiSummary] OpenAI call ${err.code} — retrying once (${Math.round(retryTimeout / 1000)}s budget)`);
    return await axios.post("https://api.openai.com/v1/chat/completions", body, { ...cfg, timeout: retryTimeout });
  }
}

// resolveProfileByEmail — the lookup ladder every summary consumer uses:
// exact lowercase first, then a case-insensitive match for legacy mixed-case
// profile rows. GetProfile.resolveProfile documents why this matters — the
// profiles the auto-rebuild triggers WRITE to are exactly the ones an
// exact-match-only lookup 404s on.
async function resolveProfileByEmail(email, projection = null) {
  const lower = String(email).toLowerCase();
  const q = (filter) => (projection
    ? ProfileModel.findOne(filter).select(projection).lean()
    : ProfileModel.findOne(filter).lean());
  const hit = await q({ email: lower });
  if (hit) return hit;
  return q({ email: { $regex: new RegExp(`^${escapeRegex(email)}$`, "i") } });
}
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
// Summary builds use gpt-4o-mini exclusively. Gemini path removed after it
// repeatedly miscategorised operator-notes directives. To restore Gemini,
// revert this commit — do not add an env switch back; the routing rules
// in the prompt are tuned for gpt-4o-mini's instruction-following.
const MAX_SUMMARY_CHARS = 8000;

const SYSTEM_PROMPT = `You write a single candidate brief that an automated job-fit grader reads
on every job. The grader trusts this brief verbatim — every claim you make
will be cited back as a pick or skip reason.

This brief has TWO consumers, so precision matters:
  (a) an LLM grader that reads the whole brief for nuance, and
  (b) a DETERMINISTIC text matcher that scans the # Hard Disqualifiers
      bullets and force-skips any job whose TITLE or COMPANY contains a
      skipped word. Because of (b), every disqualifier you write must name
      the LITERAL role word or company name to skip (e.g. "Skip sales
      roles.", "Skip JP Morgan Chase jobs.") — never a vague paraphrase.
      A clean, literal "Skip <X>." bullet is enforced automatically; a
      fuzzy one is not.

# Core rules (apply to every section)
1. Ground every line in the onboarding profile or parsed resume. If a fact
   is missing from BOTH, write "not specified" — never guess, never infer.
2. Quote profile strings VERBATIM where the section instructs. The grader
   pattern-matches on these literals; paraphrasing breaks pick reasons.
3. No marketing language. No filler adjectives ("strong communicator",
   "fast learner", "passionate"). Every sentence carries a fact.
4. Total length: 380–500 words. Plain text. Markdown limited to # headers
   and - bullets. No bold, italics, tables, or code fences.
5. Use these EXACT section headers in this EXACT order. Do not rename, do
   not skip, do not add new sections.
6. PROVENANCE MARKERS — at the END of every bullet line AND every prose
   sentence under # Candidate Summary, append exactly ONE of these tags:
     [R]  — fact comes from the parsed resume
     [P]  — fact comes from the onboarding profile
     [RP] — both sources confirm
     [I]  — inferred from the inputs (no single source cites it directly)
   Example: "- Python — 5 years building data pipelines [R]"
   Example: "- Locations accepted: NYC, Remote [P]"
   Example: "- Seniority band: senior [RP]"
   The 48-hour age bullet under Hard Disqualifiers + every Employment-type
   bullet from the rules block get [P] (those come from operator config).
   If a resume was NOT provided (the input section is "(no resume found...)"),
   every line must be [P] or [I] — never [R] or [RP].
   These markers are stripped by the server before the brief is persisted.
   Their only job is to drive the UI's per-bullet color coding so the
   operator can see at a glance which facts came from where.
7. TERMINOLOGY: the verb "scrap" in operator notes or profile fields means
   SCRAPE = APPLY TO = TARGET a job. It is POSITIVE. It does NOT mean discard
   or exclude. Only a negation ("do not scrap", "don't scrap", "never scrap")
   turns it into an exclusion. A role the operator says to "scrap" is WANTED
   and must never be placed in Hard Disqualifiers as excluded.
8. CO-OP = INTERNSHIP: a job TITLE containing "co-op", "co op", "coop", or
   "cooperative education" is an INTERNSHIP. Treat co-op roles EXACTLY as the
   Internship employment type — apply the candidate's Internship ACCEPT/REJECT
   decision to them (skip them when internships are rejected; allow them when
   internships are accepted). The "Employment type rules" block in the user
   prompt tells you which way this candidate goes and the exact bullets to emit.

# Candidate Summary
2–3 sentences. State: current title, total years of experience, primary
discipline (e.g. "back-end distributed-systems engineer", "pediatric
oncology nurse", "commercial real-estate paralegal"). Cite specifics from
the resume (last role + company + duration if available).

# Target Roles
Line 1 (always present): "Preferred roles (verbatim from profile): " followed
by every POSITIVE entry from profile.preferredRoles, comma-separated, copied
character-for-character. Do not rename "BE" to "Backend Engineer". Do not
collapse duplicates. Do not reorder.

Line 2 (only if profile.preferredRoles contains negative clauses like
"Do not add Technician roles", "no QA", "exclude manager positions"):
"Excluded roles (verbatim from profile, do NOT pick these): " followed by
the cleaned excluded role names verbatim, comma-separated. Omit this line
entirely when no negative clauses exist.

Then a bullet list grouping same-family roles on one line
(e.g. "Software Engineer / Backend Engineer / Platform Engineer"). One
bullet per family.

Final bullet: seniority band — one of intern | entry | mid | senior | lead | exec.
Derive from experienceLevel + resume YOE.

# Hard Constraints
- Locations: list cities + remote/hybrid policy. If profile says remote-only,
  say so. If onsite-only in specific cities, list them.
- Work authorisation: one short clause (e.g. "US Citizen", "H1B — on F1
  OPT until 2027", "Green Card holder", "Needs sponsorship now").
- Salary floor: USD figure if the profile states one. Else "not specified".
- Excluded industries / company stages: only if profile names them.
- Employment types: copy the EXACT wording supplied in the "Employment type
  rules" block in the user prompt. That block enumerates Full-time /
  Part-time / Contract / Internship as ACCEPT or REJECT and gives the exact
  sentence to use for each. Do NOT add a skip bullet for any type marked
  ACCEPT. Do NOT omit the skip bullet for any type marked REJECT.

# Strong Signals (auto-PICK if matched)
Bullets of keywords, role titles, technologies, certifications, or
industries that, when seen on a job posting, indicate a strong fit. Pull
from the resume (skills, recent titles, projects) and from profile
preferences. Each bullet is one short phrase, not a sentence.
Operator-notes items routed here (per the OPERATOR NOTES block) carry the
"— operator priority" or "— operator allows" suffix; resume/profile-derived
signals must NOT carry that suffix.

# Hard Disqualifiers (auto-SKIP if matched)
ABSOLUTE RULE: every bullet here MUST trace to an EXPLICIT signal in the
inputs (Excluded roles line, profile field that names an industry to skip,
profile-stated lack of clearance, employment-type marked REJECT, etc.).
Never infer a disqualifier. Never add "candidate explicitly opted out" for
any role that appears in the Preferred (positive) line — that would
contradict the candidate.

Permitted bullet sources (in priority order):
1. The "Excluded (negative)" line in the role classifier — emit ONE bullet
   per excluded role using the exact candidate wording. Example:
   "Technician roles — candidate explicitly opted out". If the Excluded
   line is "(none)", emit ZERO role-level disqualifier bullets. Do not
   invent any.
2. Employment-type REJECT bullets from the Employment type rules block —
   use the supplied wording verbatim.
3. Work-authorisation gaps the profile names (e.g. profile says "needs
   sponsorship" → "US citizen only — candidate needs sponsorship";
   profile says "no clearance" → "Active US security clearance required").
4. Industries or companies the profile explicitly tells us to exclude.
5. The candidate's OWN current/previous employers. The user prompt supplies an
   AUTHORITATIVE "Candidate's own employers" block listing the companies from
   the resume work history. Emit ONE bullet per company, exactly
   "Skip <Company> jobs." with NO attribution suffix — the candidate must NEVER
   be shown a job at a company they already work(ed) at. If that block says
   "(none)", emit zero employer bullets. Never merge companies into one bullet.
6. Operator-notes directives routed here per the OPERATOR NOTES block:
   explicit "do not scrap"/exclusion bullets, AND the whitelist catch-all
   bullet ("Skip all roles other than X.") when the operator said to
   "scrap only X". Write these as plain "Skip <X>." bullets with NO
   "excluded per operator note" or other attribution suffix. Never place a
   whitelisted/targeted role X itself here.
7. Operator-notes GEOGRAPHIC / REGION / LANGUAGE skip directives (routed
   here per R9 in the OPERATOR NOTES block). When the operator says to skip
   roles whose title signals a country, region, or foreign-language market
   outside the client's home country (US or Canada), emit the SINGLE
   consolidated conditional bullet exactly as R9 dictates — it MUST name the
   operator's example tokens verbatim AND keep the "unless the posting clearly
   confirms a <home-country> location" exception clause. Never drop the
   conditional clause and never split it into many bullets.
8. ALWAYS include this exact bullet verbatim, for every candidate, no
   exceptions: "Job posting age — skip any job posted more than 48 hours
   ago. Only postings from the last 48 hours are in scope."

FORMAT (so the deterministic matcher can enforce each bullet):
- One exclusion per bullet — never merge two roles/companies into one line.
- Phrase each as a clean, self-contained "Skip <X>." that names the literal
  role word or company ("Skip QA roles.", "Skip Deloitte jobs."). The <X>
  must be a word that would actually appear in a job title or company name.
- No attribution suffix on these bullets ("excluded per operator note",
  "candidate opted out" on note-derived items, etc.) — keep them clean.
- Keep the conditional geographic bullet (source 7) as ONE line WITH its
  "unless ... US location" clause; the matcher handles that clause specially.

Do NOT add: seniority-mismatch bullets, role variants the profile didn't
exclude, industries the profile didn't call out, or any speculative skip
reason. If there is no signal, there is no bullet.

# Notes for Grader
2–4 sentences of nuance on how to WEIGH conflicts (not a restatement of the
disqualifiers above). Examples: "Role family trumps title cosmetics — pick
'Software Developer' even when preferred says 'Software Engineer'." /
"Location flexibility: candidate prefers NYC but will take remote anywhere
in US." / "Seniority cap: open to APM and PM but not Director — too senior."
If the operator gave a geographic/region/language directive (R9), include the
one sentence it requires: treat an unconfirmed or out-of-home-country location
on a country/region/language-keyed title as a skip; keep it only when the
posting confirms a home-country (US or Canada, per the profile) location. Be
specific to THIS candidate — no generic guidance.
ALWAYS include this exact sentence, for every candidate, no exceptions:
"Co-op (also written 'co op', 'coop', or 'cooperative education') in a job
title means an internship — apply the candidate's internship rule to co-op
roles."`;

// Fields that materially affect the summary's grader-facing content. We
// snapshot only these (not the entire mongo doc) so the diff is small,
// readable, and stable across schema additions.
const SNAPSHOT_FIELDS = [
  "preferredRoles",
  "preferredLocations",
  "experienceLevel",
  "visaStatus",
  "usWorkEligibility",
  "employmentTypes",
  "targetCompanies",
  "excludedCompanies",
  "removedCompanies",
  "salaryExpectation",
  "currentTitle",
  "yearsOfExperience",
  "industriesOfInterest",
  "willingToRelocate",
  "workAuthorization",
];

// splitPreferredRoles: clients sometimes type negative clauses INTO the
// preferredRoles field ("Do not add Technician roles", "no QA", "exclude
// manager positions"). Treat them as exclusions, not preferences. Splits
// each entry on common comma boundaries first so a single mixed string
// like "Backend Engineer, no QA" still partitions cleanly.
const NEG_LEAD_RE = /^\s*(?:do\s*not|don'?t|no(?:t|pe)?|avoid|exclude|skip|never|reject|hate|dislike|remove|drop|filter\s*out)\s*(?:add|include|consider|show|pick|push|send|want)?\b\s*/i;
const ROLE_NOUN_RE = /\b(?:roles?|positions?|jobs?|titles?)\b/gi;
function splitPreferredRoles(input) {
  const preferred = [];
  const excluded = [];
  const raw = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/\s*[/|,]\s*|\s{2,}/)
      : [];
  // Second pass: each array entry can itself contain a comma (e.g.
  // "Backend Engineer, no QA"). Re-split when a negative marker shows
  // up after a comma so we don't lose the positive prefix.
  const exploded = [];
  for (const r of raw) {
    const s = String(r || "").trim();
    if (!s) continue;
    if (s.includes(",") && NEG_LEAD_RE.test(s.split(",").slice(-1)[0].trim())) {
      for (const piece of s.split(/\s*,\s*/)) exploded.push(piece);
    } else {
      exploded.push(s);
    }
  }
  for (const piece of exploded) {
    const s = String(piece || "").trim();
    if (!s) continue;
    const m = s.match(NEG_LEAD_RE);
    if (m) {
      const cleaned = s.replace(NEG_LEAD_RE, "").replace(ROLE_NOUN_RE, "").trim();
      if (cleaned) excluded.push(cleaned);
    } else {
      preferred.push(s);
    }
  }
  return { preferred, excluded };
}

// extractResumeEmployers: pull the companies the candidate currently/previously
// worked at out of the parsed resume workExperience. These become MANDATORY
// Hard Disqualifiers — we never surface a candidate a job at their own
// (current or past) employer. Done server-side + deterministically so the
// model never has to infer which JSON entries are employers; we hand it the
// exact list. Returns display-cased unique names (first spelling wins), deduped
// case-insensitively. Tolerates the field-name variants seen across resume
// schemas. Never throws.
function extractResumeEmployers(resume) {
  if (!resume || typeof resume !== "object") return [];
  const buckets = [
    resume.workExperience,
    resume.work_experience,
    resume.experience,
    resume.employment,
  ];
  const seen = new Set();
  const out = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      if (!entry || typeof entry !== "object") continue;
      const name = String(
        entry.company ||
          entry.companyName ||
          entry.employer ||
          entry.organization ||
          entry.organisation ||
          "",
      )
        .replace(/\s+/g, " ")
        .trim();
      // Drop 1-char noise; keep short real names like "HP", "GE", "3M".
      if (name.length < 2) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

function snapshotProfile(profile) {
  if (!profile) return {};
  const snap = {};
  for (const k of SNAPSHOT_FIELDS) {
    if (profile[k] !== undefined) snap[k] = profile[k];
  }
  return snap;
}

// normaliseFieldValue: turns scalars + slash/comma/pipe-separated strings +
// arrays into a sorted unique list of strings. Lets the diff compare
// "Backend Engineer / Platform Engineer" (string from older profile) with
// ["Backend Engineer","Platform Engineer"] (array from newer UI) and report
// no change instead of false-positive churn.
function normaliseFieldValue(v) {
  if (v == null || v === "") return [];
  if (Array.isArray(v)) return [...new Set(v.map(String).map((s) => s.trim()).filter(Boolean))].sort();
  if (typeof v === "object") return [JSON.stringify(v)];
  const s = String(v);
  if (/[/|,]/.test(s) || /\s{2,}/.test(s)) {
    return [...new Set(s.split(/\s*[/|,]\s*|\s{2,}/).map((p) => p.trim()).filter(Boolean))].sort();
  }
  return [s.trim()];
}

// computeProfileDiff: returns a structured human-readable diff between the
// snapshot stored at last summary build and the current profile state. Empty
// arrays for unchanged fields. The downstream prompt block converts this
// into explicit ADD/REMOVE bullets so the model can't gloss over edits.
function computeProfileDiff(prevSnapshot, current) {
  const prev = prevSnapshot || {};
  const cur = current || {};
  const changes = [];
  for (const field of SNAPSHOT_FIELDS) {
    const before = normaliseFieldValue(prev[field]);
    const after = normaliseFieldValue(cur[field]);
    if (before.length === 0 && after.length === 0) continue;
    const added = after.filter((v) => !before.includes(v));
    const removed = before.filter((v) => !after.includes(v));
    if (added.length === 0 && removed.length === 0) continue;
    changes.push({ field, before, after, added, removed });
  }
  return changes;
}

function renderDiffBlock(changes) {
  if (!changes.length) return "(no field-level changes detected — refresh wording only if the existing summary is internally inconsistent)";
  return changes
    .map((c) => {
      const lines = [`### ${c.field}`];
      if (c.removed.length) lines.push(`  REMOVED: ${c.removed.map((v) => `"${v}"`).join(", ")}`);
      if (c.added.length)   lines.push(`  ADDED:   ${c.added.map((v) => `"${v}"`).join(", ")}`);
      lines.push(`  Before: ${c.before.length ? c.before.map((v) => `"${v}"`).join(", ") : "(empty)"}`);
      lines.push(`  After:  ${c.after.length ? c.after.map((v) => `"${v}"`).join(", ") : "(empty)"}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

// renderLockedSectionsBlock: extract the operator-locked sections from the
// saved overlay text + emit a "DO NOT REGENERATE" block. The merge layer
// will overwrite these sections post-output regardless, but telling the
// model up-front keeps surrounding sections consistent (avoids the model
// claiming "Senior" elsewhere when the locked Target Roles says "Mid").
function renderLockedSectionsBlock(overlay) {
    if (!overlay?.enabled || !overlay.savedText || !Array.isArray(overlay.lockedSections) || !overlay.lockedSections.length) {
        return "";
    }
    const parsed = parseSections(overlay.savedText);
    const blocks = [];
    for (const header of overlay.lockedSections) {
        const sec = parsed.sections[header];
        if (!sec) continue;
        const lines = [];
        if (sec.prose.length) lines.push(sec.prose.join("\n").replace(/\n{3,}/g, "\n\n").trim());
        for (const b of sec.bullets) lines.push(`- ${b}`);
        const body = lines.join("\n").trim();
        if (body) blocks.push(`### ${header}\n${body}`);
    }
    if (!blocks.length) return "";
    return `\n\n## LOCKED SECTIONS (operator marked these "do not touch" — output the body VERBATIM, character-for-character; do not paraphrase, do not reorder bullets, do not add or remove lines; treat the locked text as authoritative and make sure surrounding sections do not contradict it)
${blocks.join("\n\n")}`;
}

// renderSystemNotesDirective: the operator's "Notes to AI" text, appended
// VERBATIM to the SYSTEM message (not just the user message). The user-message
// renderAiNotesBlock carries the full routing rules; this puts the raw
// directives at system level so the model treats them as authoritative
// instructions that OVERRIDE profile/resume signals — not as data to
// summarise. Empty / missing notes → empty string (no append).
function renderSystemNotesDirective(profile) {
  const text = stripPromptFences((profile?.aiNotes?.text || "").trim());
  if (!text) return "";
  const who = stripPromptFences(profile?.aiNotes?.updatedBy || "ops");
  return `

═══════════════════════════════════════════════════════════════════════
ACTIVE CLIENT DIRECTIVES — operator "Notes to AI" (from ${who}).
TREAT EVERY LINE BELOW AS A SYSTEM-LEVEL INSTRUCTION, not as data to be
summarised. These directives OVERRIDE any conflicting profile or resume
signal. Each one MUST be reflected in the brief with the correct polarity
per the ROUTING RULES given in the user message (e.g. "do not scrap X" /
"skip X" → a clean "Skip X." bullet under # Hard Disqualifiers). A directive
that is missed, dropped, or polarity-flipped is a CRITICAL FAILURE — re-read
this block and self-check before you output.

<<<OPERATOR NOTES — VERBATIM>>>
${text}
<<<END OPERATOR NOTES>>>
═══════════════════════════════════════════════════════════════════════`;
}

// Purely logistical removal reasons (duplicate card, already applied,
// posting closed) carry no preference signal. Shared by UpdateChanges (to
// skip storing/rebuilding) and by this file (to drop legacy entries that
// were stored before the filter existed). A reason is logistical only when
// EVERY ";"/"."-separated segment matches — "Duplicate job; Company isn't
// a fit" still carries signal.
const LOGISTICAL_SEGMENT = /^(duplicate(\s+job)?|already\s+applied(\s+(on\s+my\s+own|elsewhere|myself))?|applied\s+(already|myself|on\s+my\s+own|elsewhere|via\s+referral)|(job|posting|position|role)\s+(closed|expired|no\s+longer\s+(available|active|open))|(closed|expired)\s+(job|posting))$/i;
export function isPureLogisticalReason(reason) {
    const segments = String(reason)
        .split(/[;.]/)
        .map((s) => s.trim().replace(/[!?,]+$/, ""))
        .filter(Boolean);
    return segments.length > 0 && segments.every((s) => LOGISTICAL_SEGMENT.test(s));
}

// usableRemovalFeedback: reasoned, non-logistical entries, newest first,
// capped for the prompt. Single source of truth for the prompt block AND
// the deterministic enforcement pass.
const REMOVAL_FEEDBACK_PROMPT_LIMIT = 10;

// Removal reasons are CLIENT-authored free text. They are pasted into the
// prompt inside <<<REMOVALS>>> / <<<END>>> fences (applyNotesPass) and into
// the user message (renderRemovalFeedbackBlock). A reason containing a fence
// marker would close the block early and have whatever follows it read as
// instruction rather than data. Neutralise any <<<...>>> run on the way in.
// The same guard covers operator aiNotes — a trusted author, but the
// structural break is identical and it lands in the SYSTEM message.
const FENCE_RE = /<{2,}[^<>]*>{2,}/g;
export function stripPromptFences(s) {
    return String(s ?? "").replace(FENCE_RE, " ");
}

function usableRemovalFeedback(profile) {
    return (Array.isArray(profile?.removalFeedback) ? profile.removalFeedback : [])
        .filter((i) => i?.reason && String(i.reason).trim() && !isPureLogisticalReason(i.reason))
        .slice(0, REMOVAL_FEEDBACK_PROMPT_LIMIT)
        .map((i) => ({
            ...i,
            reason: stripPromptFences(i.reason),
            jobTitle: stripPromptFences(i.jobTitle),
            companyName: stripPromptFences(i.companyName),
        }));
}

// companyRejectedByEntry: true when the entry's reason rejects the COMPANY
// itself — the "Company isn't a fit" / "No visa sponsorship" chips, or free
// text that names the company ("i don't want jobs from google"). These are
// resolved deterministically: the company name comes from the entry's job
// context, never from model inference.
function companyRejectedByEntry(entry) {
    const reason = String(entry?.reason || "");
    const company = String(entry?.companyName || "").trim();
    if (!company || company.length < 3) return false;
    if (/company\s+(isn'?t|is\s+not)\s+a\s+fit/i.test(reason)) return true;
    if (/no\s+visa\s+sponsorship/i.test(reason)) return true;
    // Free-text sponsorship complaints are company-specific even when the
    // company isn't named — "they don't sponsor h1b" means THIS employer.
    if (/(they|company|employer)\s+(don'?t|do\s+not|won'?t|doesn'?t|does\s+not)\s+(provide\s+|offer\s+|give\s+)?(visa\s+|h-?1b\s+)?sponsor/i.test(reason)) return true;
    return reason.toLowerCase().includes(company.toLowerCase());
}

// --- deterministic title/family helpers -----------------------------------
// cleanTitleForSkip: strip seniority markers, level suffixes, and
// parenthetical qualifiers so "Software Engineer II, Backend (Capital
// Orchestration)" becomes a reusable pattern "Software Engineer Backend".
const TITLE_NOISE = /\b(senior|junior|staff|principal|lead|sr|jr|entry|level|intern|internship|associate|assistant|i{1,3}|iv|v|l\d+|\d+)\b/gi;
function cleanTitleForSkip(title) {
    return String(title || "")
        .replace(/\(.*?\)/g, " ")
        .replace(/[,/|–—-]+/g, " ")
        .replace(TITLE_NOISE, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// Generic role nouns carry no family signal on their own ("Engineer" in a
// QA title must not collide with "Software Engineer" in preferredRoles) —
// overlap is decided by the QUALIFIER tokens only.
const GENERIC_ROLE_TOKENS = new Set([
    "engineer", "engineering", "developer", "analyst", "manager", "specialist",
    "consultant", "associate", "scientist", "architect", "coordinator", "lead",
]);
function qualifierTokens(s) {
    const stop = new Set(["and", "the", "for", "with", "of", "in", "a", "an", "or",
        "roles", "role", "jobs", "job", "position", "positions"]);
    return String(s).toLowerCase().split(/[^a-z0-9+#]+/)
        .filter((t) => t.length >= 2 && !stop.has(t) && !GENERIC_ROLE_TOKENS.has(t));
}
// titleOverlapsPreferred: true when the removed job's qualifier tokens
// intersect the profile's preferredRoles qualifiers — meaning a family-wide
// skip would contradict what the client actually wants.
function titleOverlapsPreferred(cleanedTitle, profile) {
    const prefSet = new Set(qualifierTokens((profile?.preferredRoles || []).join(" ")));
    if (!prefSet.size) return false;
    return qualifierTokens(cleanedTitle).some((t) => prefSet.has(t));
}

// deterministicRemovalBullets: everything about an entry we can resolve in
// CODE, with zero model involvement. Each item is enforced post-build via
// ensureBulletInSection, so these signals hold even if the model drops
// every one of them. Conservative by design: anything ambiguous falls back
// to a # Notes for Grader line instead of a hard skip.
export function deterministicRemovalBullets(profile) {
    const out = [];
    const seen = new Set();
    const push = (header, needle, bullet) => {
        const key = `${header}|${needle.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ header, needle, bullet });
    };
    for (const entry of usableRemovalFeedback(profile)) {
        const reason = String(entry.reason || "");
        const company = String(entry.companyName || "").trim();
        const title = String(entry.jobTitle || "").trim();
        const cleaned = cleanTitleForSkip(title);

        // 1. Company rejection — chips, free text naming the company, or
        //    company-specific sponsorship complaints.
        if (companyRejectedByEntry(entry)) {
            push("# Hard Disqualifiers", `${company} jobs`, `- Skip ${company} jobs.`);
        }
        // 2. Staffing / consulting agency complaints.
        if (/staffing|recruit(?:er|ing)?\s+agency|consultanc/i.test(reason)) {
            push("# Hard Disqualifiers", "staffing", "- Skip staffing or consulting agency companies.");
        }
        // 3. Explicit family in free text: "this is a qa role", "it is a
        //    sales job" — the client named the family themselves.
        const fam = reason.match(/(?:this|it)\s+is\s+an?\s+([a-z][a-z /&+-]{1,40}?)\s+(?:role|job|position)/i);
        if (fam) {
            const family = fam[1].trim();
            if (family && !titleOverlapsPreferred(family, profile)) {
                push("# Hard Disqualifiers", family, `- Skip ${family} roles.`);
            }
        }
        // 4. "Not my target role" chip — skip the cleaned title pattern,
        //    but NEVER when it overlaps a preferred role family.
        if (/not\s+my\s+target\s+role/i.test(reason) && cleaned) {
            if (!titleOverlapsPreferred(cleaned, profile)) {
                const needleTokens = qualifierTokens(cleaned).slice(0, 2).join(" ") || cleaned.toLowerCase();
                // Plain `Skip <title> roles.` — NOT `Skip roles like "<title>".`.
                // The extension's matcher (background.js extractSummarySkipPhrases)
                // takes everything after "skip ", strips role nouns, and requires
                // the remainder to appear literally in a job title. The old
                // wording left it holding the dead token `like <title>`, which no
                // posting can ever contain, so this bullet never enforced.
                push("# Hard Disqualifiers", needleTokens, `- Skip ${cleaned} roles.`);
            } else {
                push("# Notes for Grader", title, `- Removal feedback: the candidate removed "${title}"${company ? ` at ${company}` : ""} as not their target role — down-rank near-identical postings even within their preferred families.`);
            }
        }
        // 5. Seniority — word marker from the title, or "too junior/senior"
        //    in free text.
        const senMatch = title.match(/\b(junior|jr|senior|sr|staff|principal|lead|director|vp|head)\b/i)
            || reason.match(/too\s+(junior|senior)/i);
        if ((/wrong\s+seniority\s+level/i.test(reason) || /too\s+(junior|senior)/i.test(reason)) && senMatch) {
            const band = senMatch[1].toLowerCase().replace(/^jr$/, "junior").replace(/^sr$/, "senior");
            // `Skip <band> roles.`, not `Skip <band>-level roles.` — the
            // hyphenated form yields the token "junior-level", and job titles
            // say "Junior Software Engineer", so the matcher never fired.
            push("# Hard Disqualifiers", `${band} level roles`, `- Skip ${band} roles.`);
        }
        // 6. Location / salary — grader guidance, never hard skips.
        if (/location\s+doesn'?t\s+work/i.test(reason)) {
            push("# Notes for Grader", `location ${company || title}`, `- Removal feedback: the location of "${title}"${company ? ` at ${company}` : ""} doesn't work for the candidate — verify location fit on similar postings.`);
        }
        if (/salary\s+is\s+below\s+my\s+range|salary\s+(is\s+)?too\s+low/i.test(reason)) {
            push("# Notes for Grader", `salary ${company || title}`, `- Removal feedback: "${title}"${company ? ` at ${company}` : ""} paid below the candidate's range — down-rank postings at that level/pay band.`);
        }
    }
    return out;
}

// resolveEntryDirectives: pre-resolve each chip into an explicit action the
// model cannot misroute — the company/title are substituted server-side.
function resolveEntryDirectives(entry) {
    const reason = String(entry?.reason || "");
    const company = String(entry?.companyName || "").trim();
    const title = String(entry?.jobTitle || "").trim();
    const out = [];
    if (companyRejectedByEntry(entry)) {
        out.push(`REQUIRED: add "Skip ${company} jobs." under # Hard Disqualifiers.`);
    }
    if (/not\s+my\s+target\s+role/i.test(reason)) {
        out.push(`Read the role family off the TITLE ("${title}"). If that family is NOT among the profile's preferredRoles → add "Skip <role family> roles." under # Hard Disqualifiers. If it overlaps a preferred role → do NOT skip it; add a # Notes for Grader sentence to down-rank near-identical postings.`);
    }
    if (/wrong\s+seniority\s+level/i.test(reason)) {
        out.push(`Read the seniority marker off the TITLE ("${title}") and add "Skip <that seniority band> roles." under # Hard Disqualifiers.`);
    }
    if (/location\s+doesn'?t\s+work/i.test(reason)) {
        out.push(`Add a # Notes for Grader sentence down-ranking this job's location; never contradict preferredLocations.`);
    }
    if (/salary\s+is\s+below\s+my\s+range/i.test(reason)) {
        out.push(`Add a # Notes for Grader sentence: postings at this job's level/pay band are below the candidate's salary floor.`);
    }
    return out;
}

// renderRemovalFeedbackBlock: client-authored removal feedback. When the
// client removes a job card from their dashboard they say why; UpdateChanges
// pushes each reason onto profile.removalFeedback (newest first) and fires an
// auto rebuild. Rendered directly BELOW the operator-notes block — HIGH
// priority, but operator notes always win on conflict. Each entry is
// pre-resolved server-side into explicit directives (company/title already
// substituted) so a generic chip like "Company isn't a fit" can never lose
// its company. Empty → empty string.
function renderRemovalFeedbackBlock(profile) {
    const recent = usableRemovalFeedback(profile);
    if (!recent.length) return "";
    const lines = recent.map((i) => {
        const when = i.removedAt ? new Date(i.removedAt).toISOString().slice(0, 10) : "";
        const jobBits = [i.jobTitle, i.companyName].filter(Boolean).join(" @ ");
        const head = `  • ${when ? `[${when}] ` : ""}${jobBits ? `${jobBits} — ` : ""}"${String(i.reason).trim()}"`;
        const actions = resolveEntryDirectives(i).map((d) => `      → ${d}`);
        return [head, ...actions].join("\n");
    });
    return `## CLIENT REMOVAL FEEDBACK (HIGH PRIORITY — direct candidate signal, second only to operator notes)
The candidate removed these jobs from their own tracker and told us why
(newest first). Every entry is the candidate saying "stop sending me jobs
like this one". Each entry carries the REMOVED JOB'S TITLE and COMPANY —
when the reason text is generic, the job context IS the signal: read the
pattern off the title/company, not off the reason wording.

${lines.join("\n")}

REASON FORMAT: the dashboard lets the client pick quick-reason phrases
(joined by ";") and/or type free text (appended after ". "). So a reason
may be chip-phrases only, free text only, or both. Process EVERY phrase in
an entry as its own signal about the SAME job.

ENTRY ACTIONS: every "→" line under an entry is a PRE-RESOLVED directive —
the company/title has already been substituted from the removed job. A
"→ REQUIRED:" line is MANDATORY: its bullet MUST appear verbatim in the
stated section. Missing a REQUIRED line is a CRITICAL FAILURE.

CHIP LEXICON (exact phrases → mechanical routing):
- "Not my target role" → the signal is the removed job's TITLE. Identify
  its role family (e.g. "Software Engineer II, Backend" → backend software
  engineering). If that family is NOT among the profile's preferredRoles →
  # Hard Disqualifiers: "Skip <role family> roles." If it OVERLAPS a
  preferred role, do NOT skip the family — add one # Notes for Grader
  sentence to down-rank near-identical postings instead.
- "Wrong seniority level" → read the title's seniority marker (Junior,
  Senior, Staff, Lead, II/III, L4…) and compare with the candidate's level
  → # Hard Disqualifiers: "Skip <that seniority band> roles." (e.g. a
  junior candidate removing "Staff Engineer" → "Skip Staff/Principal-level
  roles.").
- "Location doesn't work for me" → if the title/company pins a location,
  # Notes for Grader: down-rank that location; NEVER contradict the
  profile's preferredLocations.
- "Salary is below my range" → # Notes for Grader: treat postings at or
  below that job's apparent level/pay band as below the candidate's floor.
- "No visa sponsorship" → this company is CONFIRMED not to sponsor →
  # Hard Disqualifiers: "Skip <Company> jobs." If the profile needs
  sponsorship, also make sure sponsorship-providing employers appear as a
  Strong Signal.
- "Company isn't a fit" → # Hard Disqualifiers: "Skip <Company> jobs."
- "Already applied on my own" / "Duplicate job" → IGNORE ENTIRELY. Zero
  bullets, zero grader notes. These are logistics, not preference.

FREE-TEXT RULES (casual client typing — "i don't want jobs from google"):
- Naming a company negatively → "Skip <Company> jobs."
- Expressing a durable preference (role family, seniority, industry,
  staffing agencies, location, salary, visa, tech stack) → ONE clean
  "Skip <pattern>." bullet capturing the PATTERN, never the single posting.
- One-off/logistical text (duplicate, already applied, posting closed,
  applied via referral) → IGNORE.

CONSOLIDATION + RECENCY:
- One bullet per pattern/company across ALL entries — never duplicates,
  never one bullet per posting.
- Entries are newest-first; newer feedback outweighs older. If two entries
  conflict, follow the newer one and drop the older signal.

HARD GUARDS:
- Removal feedback NEVER overrides operator notes, the profile's
  preferredRoles, or work-authorisation facts. On conflict the higher
  input wins and the feedback becomes at most a grader-note caution.
- NEVER emit a skip bullet that would exclude a preferred role family
  outright — a client removing one bad posting does not mean they stopped
  wanting their target role.
- Bullets from this block are candidate-driven: tag with the [I]
  provenance marker; NEVER suffix with "— operator priority".
- Add ONE # Notes for Grader sentence: down-rank postings matching
  patterns the candidate has removed before.

WORKED EXAMPLES:
- Entry: Software Engineer II, Backend @ Affirm — "Not my target role;
  Company isn't a fit" (client targets Product Manager roles):
  ✓ "Skip Affirm jobs." AND "Skip backend software engineering roles."
    (backend engineering is not among their preferred roles)
  ✗ NOT "Skip Software Engineer II, Backend at Affirm." (posting-specific)
- Entry: Software Engineer, (L2) CDP @ Twilio — "Duplicate job":
  ✓ Nothing. No bullet, no note.
- Entry: Software Engineer III @ Google — "i don't want jobs from google":
  ✓ "Skip Google jobs."
- Entry: Business Analyst @ Deloitte — "they don't sponsor h1b visa"
  (client needs sponsorship):
  ✓ "Skip Deloitte jobs." + sponsorship-providing employers as a Strong
    Signal.

SELF-CHECK before output: walk the entries once more — every durable
signal has exactly ONE consolidated bullet in the right section; every
"Duplicate job"/"Already applied" entry produced NOTHING; no bullet
contradicts a preferred role, operator note, or work-auth fact.

(End of removal feedback. Continue with the normal inputs below.)

`;
}

// renderAiNotesBlock: top-priority operator guidance. Sits ABOVE every other
// block in the user prompt so the model treats it as authoritative when
// composing the brief. Empty / missing notes → empty string (no block).
function renderAiNotesBlock(profile) {
    const text = (profile?.aiNotes?.text || "").trim();
    if (!text) return "";
    const when = profile?.aiNotes?.updatedAt
        ? new Date(profile.aiNotes.updatedAt).toISOString().slice(0, 10)
        : "";
    const who = profile?.aiNotes?.updatedBy || "ops";
    return `## OPERATOR NOTES (DIRECTIVES — HIGHEST PRIORITY · ZERO TOLERANCE FOR MISSED ITEMS)
The text below is from the operator (${when}${who ? ` · ${who}` : ""}). These are DIRECTIVES, NOT data to be summarised.

╔═══════════════════════════════════════════════════════════════════════╗
║ TERMINOLOGY — READ FIRST. THIS OVERRIDES YOUR DICTIONARY INTUITION.    ║
║                                                                       ║
║ In this company's jargon, "scrap" means SCRAPE = APPLY TO = TARGET a  ║
║ job. It is a POSITIVE action. It does NOT mean discard, junk, drop,   ║
║ or exclude — ignore the everyday English meaning of the word.         ║
║                                                                       ║
║   "scrap X"               = APPLY TO X   → X is a TARGET / wanted role ║
║   "scrap only X"          = apply to X and NOTHING ELSE (WHITELIST)    ║
║   "strictly scrap only X" = WHITELIST X, skip every other role        ║
║   "also scrap Y"          = add Y to the targets                      ║
║   "prioritise / prefer X" = X is a strong-fit signal                  ║
║                                                                       ║
║   "do NOT scrap X" / "don't scrap X" / "never scrap X" = EXCLUDE X     ║
║   ONLY a NEGATION word (not/don't/never/no/skip/exclude) next to      ║
║   "scrap" flips it to an exclusion. Bare "scrap X" is ALWAYS a target.║
║                                                                       ║
║ FATAL MISTAKE TO AVOID: putting a role the operator told you to       ║
║ "scrap" (i.e. apply to) into Hard Disqualifiers as "excluded". That   ║
║ is the exact OPPOSITE of the instruction. Never do it.                ║
╚═══════════════════════════════════════════════════════════════════════╝

CRITICAL CONTRACT — read before writing anything:
A. Split the notes text into a numbered list of distinct directives in your head. A directive = one sentence or one bullet expressing ONE intent.
B. For each directive, FIRST decide its polarity. If the line begins with an explicit "SCRAP:" or "SKIP:" prefix, THAT prefix is the FINAL, AUTHORITATIVE polarity — SCRAP: = TARGET/INCLUDE (the candidate WANTS it), SKIP: = EXCLUDE — and it OVERRIDES everything else; never flip it. Otherwise fall back to the negation-word test: is there a negation word (not/don't/never/no/skip/exclude) attached to "scrap"? If NO negation → TARGET/INCLUDE; if negation present → EXCLUDE. (Note: bare "scrap X" / "scrap X more" with NO negation is a TARGET — the candidate WANTS X — never route it to Hard Disqualifiers.) Get polarity right before routing.
C. Every directive MUST produce at least one corresponding bullet in the brief, in the section dictated by the ROUTING RULES below.
D. After writing the brief, walk the directive list a second time and verify each is reflected with the CORRECT polarity. If even one is missing, in the wrong section, or has flipped polarity, REWRITE before output. A flipped or missed directive is a CRITICAL FAILURE.
E. The "— operator priority" suffix is RESERVED for items that come FROM operator notes. Items derived from the resume or profile MUST NOT carry this suffix. Do not blanket-tag every Strong Signal bullet.
F. COMPLETENESS IS MANDATORY — operator notes are the HIGHEST authority, above profile and resume. EVERY directive from the notes MUST appear in the brief, including short, vague, or one-word ones (e.g. "marketing intelligence more" → "Marketing Intelligence — operator priority"; "provides sponsorship" → "Sponsorship-providing employers — operator priority"). If a directive does not cleanly match a routing rule below, DEFAULT-ROUTE it: has a negation word → Hard Disqualifiers "Skip <X>."; otherwise → Strong Signals "<X> — operator priority". NEVER silently drop, merge, soften, or generalise a note directive — use the operator's own wording. A dropped note directive is a CRITICAL FAILURE.

ROUTING RULES (apply mechanically — do NOT improvise):

R0. WHITELIST — "scrap only X" / "only scrap X" / "strictly scrap only X" / "scrap X only" / "scrap X exclusively" (X = one or more role titles, NO negation word):
    → This RESTRICTS scope to X. X is WANTED.
    → Target Roles: the bullet list becomes EXACTLY X (the whitelisted roles), replacing/narrowing the family list. Keep the verbatim "Preferred roles (verbatim from profile)" line as-is.
    → Strong Signals: ONE bullet per whitelisted role, "X — operator priority".
    → Hard Disqualifiers: add ONE bullet, exactly: "Skip all roles other than <list of X>.".
    → ABSOLUTE: NEVER put any whitelisted role X itself into Hard Disqualifiers. The candidate WANTS X. Only the catch-all "all roles other than X" bullet goes there.

R1. NEGATED scrap / explicit exclusion — "Do NOT scrap X" / "don't scrap X" / "never scrap X" / "do not pick X" / "exclude X" / "skip X" / "no X" (negation word REQUIRED):
    → Hard Disqualifiers: ONE bullet per X, exactly "Skip <X>." (e.g. "Skip QA roles.").
    → Do NOT append "excluded per operator note" or any operator-attribution suffix — keep the bullet clean, same style as the other disqualifier bullets.
    → NEVER include X in Strong Signals or Target Roles.
    → NEVER summarise multiple X's into one bullet; emit one bullet per item.

R2. Priority — "Prioritise X" / "focus on X" / "scrap more X" / "we want X" / "prefer X" (NO negation):
    → Strong Signals: ONE bullet per X, exactly "X — operator priority".
    → NEVER include X in Hard Disqualifiers.

R3. Additive target — "Also scrap Y" / "include Y" / "Y is fine too" / "can scrap Y as well" (NO negation):
    → Target Roles bullet list grows to include Y (when Y is a role title).
    → Strong Signals adds: "Y — operator allows" (when Y is a role/tech/skill).
    → NEVER include Y in Hard Disqualifiers, even if Y looks like an "off-discipline" role.

R4. Company-name exclusions — "do NOT scrap from Acme" / "don't scrap Foo Inc" / "skip Foo Inc" (negation REQUIRED):
    → Hard Disqualifiers: one bullet per company, exactly "Skip <Company> jobs." — no attribution suffix.
    → NEVER list these under Hard Constraints "Excluded industries" — companies are not industries.
    → NEVER list these in Strong Signals.
    NOTE: "scrap from Acme" WITHOUT a negation = apply to Acme (priority), NOT an exclusion → Strong Signals "<Company> — operator priority".

R5. Company / industry category exclusions — "do NOT scrap staffing" / "no staffing" / "skip consulting firms" (negation REQUIRED):
    → Hard Disqualifiers: "Skip <category> companies." — no attribution suffix.
    → NEVER as Strong Signals. NEVER as Hard Constraints "Excluded industries" — keep them as their own bullets in Hard Disqualifiers.

R6. Company / industry category priorities — "prioritise H1B sponsors" / "prefer fintech" / "scrap H1B sponsors" (NO negation):
    → Strong Signals: "<Category> — operator priority".
    → NEVER as Hard Disqualifiers.

R7. Operational instructions that are NOT about job content ("scrap 35-40 daily", "build twice a week"):
    → IGNORE — these are workflow instructions, not candidate signals. Do NOT echo them anywhere in the brief. (A bare number/quota next to "scrap" = workflow, not a role.)

R9. GEOGRAPHIC / REGION / LANGUAGE market skips — directives saying to skip roles whose TITLE signals a country, region, or foreign-language market OUTSIDE the client's home country (the home country is US or Canada — read it off the profile's preferredLocations + work authorisation). Examples: "skip Japanese-speaking roles", "skip APAC/EMEA analyst", "skip non-US region titles unless the job is in the USA", or a list of example titles like "Research Analyst – Japanese Speaking", "Japan Market Analyst", "APAC Analyst", "EMEA Analyst", "UK Market Associate":
    → This is a CONDITIONAL skip. Do NOT split the example titles into one "Skip X." bullet each, and do NOT drop the "unless ... home-country location" exception.
    → Determine the client's home country from the profile. A US client skips Canada-market titles; a Canada client skips US-market titles; both skip all overseas titles.
    → Hard Disqualifiers: emit EXACTLY ONE consolidated bullet in this shape (substitute the client's actual home country — US or Canada — for <COUNTRY>):
      "Skip roles whose title signals a country, region, or language market outside <COUNTRY> (e.g. <verbatim example titles/keywords from the note>) unless the posting clearly confirms a <COUNTRY> location."
      List the operator's example tokens/titles verbatim inside the parentheses, comma-separated.
    → Notes for Grader: add ONE sentence: treat an unconfirmed or out-of-home-country location on such titles as a SKIP; keep the role only when the posting confirms a <COUNTRY> (or Remote-<COUNTRY>) location.
    → NEVER place these titles in Strong Signals or Target Roles. NEVER omit the bullet — a missed geographic directive is a CRITICAL FAILURE just like a missed exclusion.

R8. The "Notes for Grader" section gets ONLY meta-guidance on how to WEIGH conflicts. NEVER restates the routed directives (except the single geographic-policy sentence required by R9).

WORKED EXAMPLES (use these for the current candidate too):

Operator note: "strictly scrap only Data Engineer or data analyst positions"
  → POLARITY: no negation → TARGET/WHITELIST (R0). Candidate WANTS these two roles only.
  ✓ Target Roles bullet list MUST be exactly: "Data Engineer", "Data Analyst"
  ✓ Strong Signals MUST contain: "Data Engineer — operator priority", "Data Analyst — operator priority"
  ✓ Hard Disqualifiers MUST contain: "Skip all roles other than Data Engineer / Data Analyst."
  ✗ Hard Disqualifiers must NOT contain "Data Engineer roles — excluded" or "Data Analyst roles — excluded" — that flips the directive and is a CRITICAL FAILURE

Operator note: "DO NOT scrap at all staffing/consulting companies."
  → POLARITY: "DO NOT" → EXCLUDE (R5).
  ✓ Hard Disqualifiers MUST contain: "Skip staffing or consulting companies."
  ✗ Strong Signals must NOT contain "Staffing/Consulting companies"

Operator note: "Prioritize and scrap companies that provide H1B sponsorship."
  → POLARITY: no negation → PRIORITY (R6).
  ✓ Strong Signals MUST contain: "Companies that sponsor H1B — operator priority"
  ✗ Hard Disqualifiers must NOT contain "Companies that provide H1B sponsorship"

Operator note: "Do not scrap roles from Humana or JP Morgan Chase."
  → POLARITY: "Do not" → EXCLUDE (R4).
  ✓ Hard Disqualifiers MUST contain TWO bullets:
       "Skip Humana jobs."
       "Skip JP Morgan Chase jobs."
  ✗ A single combined bullet like "Humana and JP Morgan Chase" is NOT acceptable — emit two

Operator note: "Can scrap Data Engineer roles as well."
  → POLARITY: no negation → ADDITIVE TARGET (R3).
  ✓ Target Roles bullet list MUST grow to include "Data Engineer"
  ✓ Strong Signals MUST add: "Data Engineer — operator allows"
  ✗ Hard Disqualifiers must NOT contain "Data Engineer"

Operator note: "Scrap 35-40 Daily"
  → IGNORE — workflow instruction (bare quota), not candidate signal. Do not echo anywhere.

Operator note: "Skip jobs like 'Research Analyst – Japanese Speaking'. Roles with non-U.S. language, country, or region keywords should not be scraped unless the job page clearly says the location is in the USA. Skip titles like: Research Analyst – Japanese Speaking, Japanese Speaking Analyst, Japan Market Analyst, APAC Analyst, EMEA Analyst, UK Market Associate, Canada Operations Analyst. Rule: If the title sounds country/region-specific and the USA location is not 100% confirmed, skip it."
  → POLARITY: "Skip" → EXCLUDE, but CONDITIONAL on location (R9, geographic/region/language).
  ✓ Hard Disqualifiers MUST contain EXACTLY ONE bullet: "Skip roles whose title signals a non-US country, region, or language market (e.g. Japanese Speaking, Japan Market Analyst, APAC Analyst, EMEA Analyst, UK Market Associate, Canada Operations Analyst) unless the posting clearly confirms a US location."
  ✓ Notes for Grader MUST contain: "For any title with a non-US country/region/language keyword, treat an unconfirmed or non-US location as a skip; keep it only when the posting confirms a US or Remote-US location."
  ✗ Do NOT emit one "Skip ..." bullet per example title (that loses the US-location exception and over-skips US bilingual roles).
  ✗ Do NOT drop the directive entirely (a multi-line/conditional note is STILL a directive — missing it is a CRITICAL FAILURE).

SELF-CHECK BEFORE FINAL OUTPUT (mandatory):
1. List every directive in the notes and tag each with its polarity (TARGET vs EXCLUDE) using the negation-word test from contract step B.
2. For each, locate the section it should land in per the ROUTING RULES.
3. Open your draft and confirm the bullet exists in the right section. Exclusions read as a clean "Skip <X>." with NO attribution suffix. Strong-Signal note items carry "— operator priority" / "— operator allows".
4. POLARITY AUDIT: for every role/company the operator said to "scrap" (no negation), confirm it appears as a TARGET/priority and does NOT appear as a "Skip ..." disqualifier anywhere. For every "do not scrap" item, confirm it appears ONLY as a "Skip ..." disqualifier. A single flipped item = REWRITE.
5. Confirm no Preferred role appears as a disqualifier. Confirm NO disqualifier bullet contains "excluded per operator note" or any attribution suffix. Confirm "— operator priority" / "— operator allows" appear ONLY on notes-derived Strong-Signal items.
If any check fails: REWRITE the affected section(s) before outputting.

OPERATOR NOTES TEXT (treat this entire block as the directive source — every sentence is a directive):
${text}

(End of operator notes. Continue with the normal inputs below.)

`;
}

function buildUserPrompt(profile, resume, existingSummary, profileDiff, overlay = null) {
  const profileBlob = JSON.stringify(profile || {}, null, 2).slice(0, 12_000);
  // Split positive vs negative role clauses up-front so the model sees an
  // explicit "EXCLUDED ROLES" block rather than having to detect "Do not
  // add ..." phrasing buried inside the preferredRoles array. Reduces the
  // chance the model lists an excluded role under Target Roles.
  const { preferred: preferredRoles, excluded: excludedRoles } = splitPreferredRoles(profile?.preferredRoles);
  // Employment types — multi-select array from the /profile UI. Default
  // to ["Full-time"] when profile field is missing/empty so legacy clients
  // still surface as full-time-only in the prompt.
  const rawEmp = Array.isArray(profile?.employmentTypes) ? profile.employmentTypes : [];
  const cleanedEmp = rawEmp
    .map((v) => String(v || "").trim())
    .filter((v) => ["Full-time", "Part-time", "Contract", "Internship"].includes(v));
  const employmentTypes = cleanedEmp.length ? cleanedEmp : ["Full-time"];
  const allEmp = ["Full-time", "Part-time", "Contract", "Internship"];
  const excludedEmp = allEmp.filter((t) => !employmentTypes.includes(t));
  // Per-type bullet wording. Each entry is { accept, reject } — the exact
  // line the model must (accept) or must NOT (reject) put in the summary.
  // Generated server-side so the model never has to "decide" what to write
  // for a given type — it just copies the supplied line.
  const EMP_WORDING = {
    "Full-time":  { accept: "Open to full-time roles.",                          reject: "Skip full-time roles." },
    "Part-time":  { accept: "Open to part-time roles.",                          reject: "Skip part-time roles." },
    "Contract":   { accept: "Open to contract / contract-to-hire roles.",        reject: "Skip contract / contract-to-hire roles." },
    "Internship": { accept: "Open to internships.",                              reject: "Skip internships." },
  };
  const empPerType = allEmp.map((t) => {
    const isAccepted = employmentTypes.includes(t);
    const wording = isAccepted ? EMP_WORDING[t].accept : EMP_WORDING[t].reject;
    const section = isAccepted ? "Hard Constraints" : "Hard Disqualifiers";
    return `  - ${t}: ${isAccepted ? "ACCEPT" : "REJECT"} → put "${wording}" under ${section}. Do NOT add any contradictory bullet for ${t} in any other section.`;
  }).join("\n");
  // Co-op IS an internship. Drive co-op handling off the Internship decision so
  // co-op titles are treated the same as internships for EVERY candidate.
  // When internships are rejected we emit dedicated literal-spelling skip
  // bullets (the deterministic title matcher needs the exact word "co-op" /
  // "co op" / "coop" — "Skip internships." alone would not catch a "Co-op" title).
  const internshipAccepted = employmentTypes.includes("Internship");
  const coOpRule = internshipAccepted
    ? `  - Co-op: ACCEPT (co-op = internship, and internships are accepted) → add "Open to co-op / co op roles." under Hard Constraints. Do NOT skip co-op roles.`
    : `  - Co-op: REJECT (co-op = internship, and internships are rejected) → add these THREE exact bullets under Hard Disqualifiers, one per line, so the title matcher catches every spelling: "Skip co-op roles." AND "Skip co op roles." AND "Skip coop roles."`;
  const rolesBlock = `\n\n## Role classifier (AUTHORITATIVE — applies on top of profile.preferredRoles)
Preferred (positive):  ${preferredRoles.length ? preferredRoles.map((r) => `"${r}"`).join(", ") : "(none)"}
Excluded (negative):   ${excludedRoles.length ? excludedRoles.map((r) => `"${r}"`).join(", ") : "(none)"}
Accepted employment types: ${employmentTypes.join(", ")}
Rejected employment types: ${excludedEmp.length ? excludedEmp.join(", ") : "(none — accepts all)"}
Rules:
- Use ONLY the Preferred list on the "Preferred roles (verbatim from profile)" line.
- If the Excluded list is "(none)": OMIT the "Excluded roles" line entirely AND emit ZERO role-level bullets under Hard Disqualifiers. Do not generate any "<Role> — candidate explicitly opted out" bullet. Do not infer exclusions from seniority, role family, or anything else.
- If the Excluded list has entries: render them on the "Excluded roles (verbatim from profile, do NOT pick these)" line and add ONE matching disqualifier bullet per entry, using the candidate's exact wording.
- NEVER include any role from the Preferred list under Hard Disqualifiers, Strong Signals exclusions, or any negative section. Preferred = wanted; emitting a Preferred role as a disqualifier directly contradicts the candidate.

## Employment type rules (AUTHORITATIVE — overrides every other instruction)
For each employment type below, use EXACTLY the wording given. Do not invent
synonyms, do not add "skip" bullets for any ACCEPT type, do not omit "skip"
bullets for any REJECT type:
${empPerType}
${coOpRule}`;
  const resumeBlob = resume
    ? JSON.stringify(
        {
          personalInfo: resume.personalInfo,
          summary: resume.summary,
          workExperience: resume.workExperience,
          projects: resume.projects,
          skills: resume.skills,
          education: resume.education,
          leadership: resume.leadership,
          publications: resume.publications,
        },
        null,
        2,
      ).slice(0, 16_000)
    : "(no resume found for this candidate — work from profile only)";
  // Candidate's own employers (current + previous) → mandatory exclusions.
  // Extracted deterministically from resume.workExperience so the model gets
  // an explicit, authoritative list rather than having to guess which resume
  // entries are employers. Drives one "Skip <Company> jobs." Hard Disqualifier
  // per company. Empty when no resume / no work history.
  const ownEmployers = extractResumeEmployers(resume);
  const employersBlock = `\n\n## Candidate's own employers (AUTHORITATIVE — current + previous, from resume work history)
NEVER surface the candidate a job at a company they currently work at or have
previously worked at. For EACH company listed below, add ONE bullet under Hard
Disqualifiers, exactly: "Skip <Company> jobs." — no attribution suffix, same
clean style as the other disqualifier bullets. One bullet per company; never
merge multiple companies into a single bullet. These are grounded in the resume
work history, so mark each with the [R] provenance tag.
Companies: ${ownEmployers.length ? ownEmployers.map((c) => `"${c}"`).join(", ") : "(none — emit zero employer bullets)"}`;
  // Diff-aware path: when a previous summary exists and the profile was
  // edited (summaryStale=true), preserve the existing summary's voice +
  // structure and only revise the parts that no longer match the inputs.
  // This avoids OpenAI rewriting tone/wording on every minor profile edit.
  if (existingSummary && existingSummary.trim().length > 100) {
    const diffBlock = renderDiffBlock(profileDiff || []);
    const removedAll = (profileDiff || []).flatMap((c) => c.removed);
    const removalGuard = removedAll.length
      ? `\n\nMANDATORY REMOVALS — these strings MUST NOT appear anywhere in the
updated summary (the candidate explicitly removed them from their profile,
do not infer they still apply, do not list them in any section):
${removedAll.map((v) => `  • "${v}"`).join("\n")}`
      : "";

    // Employment-type flip guard: if a type changed ACCEPT↔REJECT, the
    // existing summary likely still carries the old bullet. The per-type
    // rules block above already states the new wording, but the existing
    // summary is also fed in and can be sticky — call out the flip
    // explicitly so the model strips the contradictory line.
    const empDiff = (profileDiff || []).find((c) => c.field === "employmentTypes");
    let empFlipGuard = "";
    if (empDiff) {
      const flips = [];
      for (const t of empDiff.added) {
        // type became ACCEPTED → any "Skip <t>" bullet must be removed
        flips.push(`  • ${t} is now ACCEPTED — REMOVE any "Skip ${t.toLowerCase()}" / "no ${t.toLowerCase()}" bullet from the existing summary and use ONLY the wording supplied in the Employment type rules block above.`);
      }
      for (const t of empDiff.removed) {
        // type became REJECTED → must add the skip bullet
        flips.push(`  • ${t} is now REJECTED — ENSURE the existing summary contains the Hard Disqualifier wording supplied in the Employment type rules block above for ${t}, and remove any "Open to ${t.toLowerCase()}" / accepting language.`);
      }
      if (flips.length) {
        empFlipGuard = `\n\nEMPLOYMENT TYPE FLIPS (CRITICAL — overrides the existing summary):\n${flips.join("\n")}`;
      }
    }
    const diffPathBody = `## Existing summary (built from a profile snapshot that is now out of date)
${existingSummary.trim().slice(0, 6_000)}

## Field-level diff since last build (AUTHORITATIVE — applies on top of existing summary)
${diffBlock}
${rolesBlock}${employersBlock}

## Updated onboarding profile (full current state)
${profileBlob}

## Parsed resume
${resumeBlob}

## Task
Rewrite the existing summary so every section is consistent with the
updated profile. Hard rules:

1. Treat the diff above as authoritative. Every REMOVED value must be
   STRIPPED from the summary even if the existing summary still mentions
   it; every ADDED value must be INCORPORATED into the appropriate
   section (Target Roles, Hard Constraints, Strong Signals, etc.).
2. Preserve voice, tone, and phrasing for sentences that are NOT
   contradicted by the diff. Do not rewrite from scratch.
3. The "Preferred roles (verbatim from profile)" line at the top of
   the Target Roles section must be regenerated from the CURRENT
   preferredRoles list — never reuse the old line.
4. The Hard Constraints "Locations" bullet must list ONLY the current
   preferredLocations. If the diff shows a removed city, that city
   must vanish from the summary entirely.
5. If a field in the diff went from a value to empty, replace the
   relevant bullet with "not specified" rather than leaving the old
   text in place.
6. The Employment type rules block above is AUTHORITATIVE. The existing
   summary may contradict it (e.g. carry a "Skip internships" bullet from
   a previous build). When that happens, the per-type wording in the rules
   block WINS — delete every contradictory line and substitute the
   supplied wording verbatim.${removalGuard}${empFlipGuard}

Output the FULL updated summary in the same format as before — do not
output a diff or a list of changes.${renderLockedSectionsBlock(overlay)}`;
    return `${renderAiNotesBlock(profile)}${renderRemovalFeedbackBlock(profile)}${diffPathBody}`;
  }
  // Priority order in the prompt body: Notes (rendered above by
  // renderAiNotesBlock) > Removal feedback (renderRemovalFeedbackBlock) >
  // Resume > Profile. When the resume conflicts with the profile, the
  // resume wins (resume = ground truth of what the candidate actually did;
  // profile = self-reported preferences).
  const freshBody = `## INPUT PRIORITY (for any conflict, higher beats lower)
1. Operator notes (above) — DIRECTIVES, always win
2. Client removal feedback (above, when present) — candidate preference signals
3. Parsed resume (below) — ground truth of actual experience
4. Onboarding profile (below) — self-reported preferences / exclusions / work auth

## Parsed resume (PRIORITY 3 — ground truth of experience; cite YOE, titles, companies, skills from here)
${resumeBlob}

## Onboarding profile (PRIORITY 4 — preference signals; use for preferredRoles, preferredLocations, work auth, target/excluded companies)
${profileBlob}
${rolesBlock}${employersBlock}${renderLockedSectionsBlock(overlay)}`;
  return `${renderAiNotesBlock(profile)}${renderRemovalFeedbackBlock(profile)}${freshBody}`;
}

async function fetchResume(email) {
  try {
    const res = await axios.post(
      `${RESUME_API_URL}/api/resume-by-email`,
      { email },
      { timeout: 15_000, headers: { "content-type": "application/json" } },
    );
    return { ok: true, resume: res.data };
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) {
      return { ok: false, error: "NO_RESUME", message: err.response?.data?.error || "no resume assigned" };
    }
    return {
      ok: false,
      error: status ? `HTTP_${status}` : "NETWORK",
      message: err.response?.data?.error || err.message,
    };
  }
}

// SUMMARY_TEMPERATURE — tuned for the structured-brief task. 0.05 (near
// greedy decoding) is required to make the operator-notes routing rules
// stick: at 0.15 the model occasionally dropped a "do not scrap from <co>"
// directive or mis-suffixed Strong Signals. Lower temp = stricter prompt
// adherence at the cost of slightly more repetitive phrasing — acceptable
// because the brief is read by a grader, not a human reader.
// 0 = greedy decoding — most deterministic, strictest rule adherence (this is
// a classification/routing task, not creative writing). Hardcoded on purpose.
const SUMMARY_TEMPERATURE = 0;

// retryHint — when a previous round-1 attempt came back missing required
// headers, this string is appended to the system message so the reroll is
// explicitly told which sections to restore. Empty on the first attempt.
async function callOpenAI(profile, resume, existingSummary, profileDiff, apiKey, overlay = null, retryHint = "", deadlineAt = 0) {
  const body = {
    model: OPENAI_MODEL,
    messages: [
      // Operator notes are appended to the SYSTEM message (verbatim) so the
      // model treats them as authoritative instructions, on top of the
      // detailed routing rules carried in the user message.
      { role: "system", content: SYSTEM_PROMPT + renderSystemNotesDirective(profile) + retryHint },
      { role: "user", content: buildUserPrompt(profile, resume, existingSummary, profileDiff, overlay) },
    ],
    temperature: SUMMARY_TEMPERATURE,
  };
  try {
    const res = await postOpenAI(body, apiKey, deadlineAt);
    recordAiUsage({
      source: AI_USAGE_SOURCES.AI_SUMMARY,
      model: res.data?.model || OPENAI_MODEL,
      usage: res.data?.usage,
    });
    const summary = (res.data?.choices?.[0]?.message?.content || "").trim();
    return { ok: true, summary, usage: res.data?.usage || null };
  } catch (err) {
    const status = err.response?.status;
    const detail =
      err.response?.data?.error?.message ||
      (typeof err.response?.data === "string" ? err.response.data : "") ||
      err.message;
    return {
      ok: false,
      error: status ? `OPENAI_${status}` : "OPENAI_NETWORK",
      message: detail.slice(0, 500),
    };
  }
}

// applyNotesPass — focused SECOND LLM pass: hand the model round-1's brief +
// the operator notes and have it fix/complete the brief so EVERY directive is
// reflected with correct polarity. Runs only when notes exist (+1 call/build).
// Fail-open: returns the input brief unchanged on any error/empty — the
// deterministic enforceNoteDirectives still runs afterwards as the guarantee.
async function applyNotesPass(brief, notesText, apiKey, removalDirectivesText = "", deadlineAt = 0) {
  if (!notesText && !removalDirectivesText) return brief;
  const sys = `You revise a candidate brief so it FULLY reflects the operator's notes and the client's removal-feedback directives. Output ONLY the corrected brief — same section headers, same order, keep all existing content, change nothing the inputs don't require.
Rules:
- A note line beginning "SCRAP:" = the candidate WANTS it (TARGET). "SKIP:" = EXCLUDE it. The prefix is the FINAL polarity — NEVER flip it. For un-prefixed lines: "scrap X" (no negation) = TARGET; "do not scrap X" / "skip X" = EXCLUDE.
- Every TARGET directive MUST appear in "# Strong Signals" as "- <X> — operator priority".
- Every EXCLUDE directive MUST appear in "# Hard Disqualifiers" as "- Skip <X>.".
- Include EVERY directive — do not drop, merge, soften, or duplicate; use the operator's wording.
- NEVER put a wanted (SCRAP/target) role into Hard Disqualifiers.
- REMOVAL DIRECTIVES are pre-resolved actions from jobs the client removed: each states its exact bullet and section. Every one MUST be reflected; never skip a role family the candidate still prefers.`;
  const removalBlock = removalDirectivesText
    ? `\n\nRemoval-feedback directives:\n<<<REMOVALS>>>\n${removalDirectivesText}\n<<<END>>>`
    : "";
  const user = `Operator notes:\n<<<NOTES>>>\n${notesText || "(none)"}\n<<<END>>>${removalBlock}\n\nCurrent brief:\n<<<BRIEF>>>\n${brief}\n<<<END>>>\n\nReturn the corrected full brief.`;
  try {
    const res = await postOpenAI({
      model: OPENAI_MODEL,
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      temperature: 0,
    }, apiKey, deadlineAt);
    recordAiUsage({
      source: AI_USAGE_SOURCES.AI_SUMMARY,
      model: res.data?.model || OPENAI_MODEL,
      usage: res.data?.usage,
    });
    // Strip any <<<MARKER>>> lines the model echoes back from the prompt
    // wrappers before length sanity — they are prompt scaffolding, not brief.
    const fixed = (res.data?.choices?.[0]?.message?.content || "")
      .replace(/^\s*<{2,}[^<>]*>{2,}\s*$/gm, "")
      .trim();
    return fixed.length > 50 ? fixed : brief; // sanity: ignore a truncated/empty rewrite
  } catch (e) {
    console.warn("[BuildAiSummary] applyNotesPass failed, keeping round-1:", e.message);
    return brief;
  }
}

// Core build pipeline — no req/res. Returns a { success, ... } object so it
// can be called both from the HTTP handler AND fire-and-forget from profile
// create/update controllers to auto-rebuild summaries.
export async function buildSummaryForEmail(email, reasonTag = "manual") {
  try {
    let effectiveKey = OPENAI_API_KEY;
    if (!effectiveKey) {
      try {
        const settings = await getAppSettings();
        effectiveKey = (settings?.globalOpenaiKey || "").trim();
      } catch (e) {
        console.warn("buildSummaryForEmail global-key load failed:", e.message);
      }
    }
    if (!effectiveKey) {
      return { success: false, status: 503, error: "NO_OPENAI_KEY", message: "OPENAI key not configured", step: "config" };
    }
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return { success: false, status: 400, error: "BAD_INPUT", message: "email is required", step: "validate" };
    }
    const profile = await resolveProfileByEmail(email);
    if (!profile) {
      return { success: false, status: 404, error: "PROFILE_NOT_FOUND", message: `No profile in DB for ${email}`, step: "loading-profile" };
    }

    // Claim the build atomically. Every trigger routes through here — the
    // Build button, job-removal feedback, resume attach, profile create/update
    // and the 30-min cron sweep — so this is the single place that can stop
    // two builds racing on the same profile document. Two overlapping builds
    // both write the full aiSummaryMeta and aiSummaryPrevious, so the loser's
    // text wins at random and the operator sees a summary that ignores the
    // change they just made.
    const startedAt = new Date();
    const staleCutoff = new Date(startedAt.getTime() - BUILD_STALE_MS);
    const claimed = await ProfileModel.findOneAndUpdate(
      {
        _id: profile._id,
        $or: [
          { "aiSummaryMeta.status": { $ne: "building" } },
          { "aiSummaryMeta.buildStartedAt": null },
          { "aiSummaryMeta.buildStartedAt": { $exists: false } },
          { "aiSummaryMeta.buildStartedAt": { $lt: staleCutoff } },
        ],
      },
      {
        $set: {
          "aiSummaryMeta.status": "building",
          "aiSummaryMeta.buildStartedAt": startedAt,
          "aiSummaryMeta.lastError": null,
        },
      },
      { new: false, lean: true },
    );
    if (!claimed) {
      // Record that a rebuild was wanted DURING the running build. Without
      // this the in-flight build (which started before this change existed)
      // clears summaryStale on success and the change — a removal reason, a
      // freshly attached resume — never reaches the brief.
      const running = await ProfileModel.findOneAndUpdate(
        { _id: profile._id },
        { $set: { summaryStale: true, summaryRebuildRequestedAt: startedAt } },
        { new: true, lean: true },
      ).select({ "aiSummaryMeta.buildStartedAt": 1 });
      console.log(`[BuildAiSummary] build already in progress email=${email} reason=${reasonTag} — skipping duplicate`);
      return {
        success: false,
        skipped: true,
        status: 202,
        error: "BUILD_IN_PROGRESS",
        message: "A build is already running for this client.",
        step: "claim",
        buildStartedAt: running?.aiSummaryMeta?.buildStartedAt || null,
      };
    }

    // runForProfileCore persists the whole aiSummaryMeta object, so hand it
    // the claim we just wrote — otherwise it would restore the PREVIOUS
    // buildStartedAt and the staleness maths would be wrong on the next run.
    profile.aiSummaryMeta = { ...(profile.aiSummaryMeta || {}), status: "building", buildStartedAt: startedAt };

    let result;
    try {
      result = await runForProfileCore(profile, effectiveKey, reasonTag, startedAt.getTime() + BUILD_BUDGET_MS);
    } catch (err) {
      result = { success: false, status: 500, error: "INTERNAL", message: err?.message || String(err), step: "internal" };
    }
    // runForProfileCore writes status:"done" itself on success. Every failure
    // path returns early without touching the document, so release the claim
    // here — otherwise the profile stays "building" until BUILD_STALE_MS and
    // the UI spins on a build that is already dead.
    if (!result?.success) {
      await ProfileModel.updateOne(
        { _id: profile._id },
        {
          $set: {
            "aiSummaryMeta.status": "error",
            "aiSummaryMeta.lastAttemptAt": new Date(),
            "aiSummaryMeta.lastError": {
              error: result?.error || "UNKNOWN",
              message: result?.message || "",
              step: result?.step || "",
            },
          },
        },
      ).catch(() => {});
      console.error(
        `[BuildAiSummary] build failed email=${email} reason=${reasonTag} error=${result?.error} step=${result?.step} msg=${result?.message}`,
      );
    }
    return result;
  } catch (err) {
    console.error("buildSummaryForEmail fatal:", err);
    return { success: false, status: 500, error: "INTERNAL", message: err.message, step: "internal" };
  }
}

// runBuildInBackground — kick off buildSummaryForEmail without holding the
// HTTP request open. buildSummaryForEmail owns the whole build lifecycle
// (claim → status:"done" on success, status:"error" + lastError on failure),
// so there is nothing to write here; this only logs the outcome.
async function runBuildInBackground(email, reasonTag) {
  try {
    const result = await buildSummaryForEmail(email, reasonTag);
    if (result?.success) {
      console.log(`[BuildAiSummary] background build ok email=${email} words=${result.wordCount} source=${result.source}`);
    } else if (result?.skipped) {
      console.log(`[BuildAiSummary] background build skipped email=${email} — ${result.error}`);
    }
  } catch (err) {
    // buildSummaryForEmail already catches everything; this is belt-and-braces
    // so an unhandled rejection can never take the process down.
    console.error(`[BuildAiSummary] background build threw email=${email}:`, err);
  }
}

// POST /build-ai-summary  { email }
// Returns 202 immediately and builds in the background — the full build is
// 90-150s (resume fetch + two OpenAI passes), longer than Cloudflare's ~100s
// origin timeout, so a synchronous response reliably 502s. The clients-tracking
// AI Summary page polls GET /ai-summary-status until status leaves "building"
// AND builtAt catches up to the `buildStartedAt` returned here.
export default async function BuildAiSummary(req, res) {
  const { email } = req.body || {};
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ success: false, error: "BAD_INPUT", message: "email is required", step: "validate" });
  }
  // Case-insensitive, same as every other summary consumer — an exact-match
  // lookup 404s on legacy mixed-case profile rows that build fine everywhere
  // else.
  const profile = await resolveProfileByEmail(email, { _id: 1, email: 1, aiSummaryMeta: 1 });
  if (!profile) {
    return res.status(404).json({ success: false, error: "PROFILE_NOT_FOUND", message: `No profile in DB for ${email}`, step: "loading-profile" });
  }

  // Informational only — the real guard is the atomic claim inside
  // buildSummaryForEmail, which also covers builds started by the auto
  // triggers (job removal, resume attach, profile save, cron sweep).
  const meta = profile.aiSummaryMeta || {};
  const startedAt = meta.buildStartedAt ? new Date(meta.buildStartedAt).getTime() : 0;
  const alreadyRunning = meta.status === "building" && startedAt > 0 && Date.now() - startedAt < BUILD_STALE_MS;

  // Timestamp handed back to the poller. Taken BEFORE the build is fired, so
  // it can never be later than the claim's buildStartedAt — the poller uses it
  // to reject a "done" left over from an earlier build.
  const requestedAt = new Date();

  // Fire and forget — do NOT await.
  runBuildInBackground(profile.email || String(email).toLowerCase(), "manual");

  return res.status(202).json({
    success: true,
    status: "building",
    alreadyRunning,
    buildStartedAt: (alreadyRunning ? new Date(startedAt) : requestedAt).toISOString(),
    requestedAt: requestedAt.toISOString(),
    message: alreadyRunning
      ? "A build is already in progress for this client."
      : "Build started. Poll /ai-summary-status for completion.",
  });
}

// GET /ai-summary-status?email=
// Lightweight poll target for the clients-tracking AI Summary page.
export async function AiSummaryStatus(req, res) {
  const email = (req.query?.email || "").toString();
  if (!email || !email.includes("@")) {
    return res.status(400).json({ success: false, error: "BAD_INPUT", message: "email query param is required" });
  }
  const profile = await resolveProfileByEmail(email, {
    email: 1, aiSummary: 1, aiSummaryMeta: 1, summaryStale: 1,
  });
  if (!profile) {
    return res.status(404).json({ success: false, error: "PROFILE_NOT_FOUND", message: `No profile in DB for ${email}` });
  }
  const meta = profile.aiSummaryMeta || {};
  let status = meta.status || (meta.builtAt ? "done" : "idle");
  // Treat a build that started too long ago with no result as dead so the UI
  // stops spinning forever after a mid-build process restart. BUILD_STALE_MS
  // sits above BUILD_BUDGET_MS, so a build that is still legitimately running
  // never trips this.
  const startedAt = meta.buildStartedAt ? new Date(meta.buildStartedAt).getTime() : 0;
  if (status === "building" && startedAt && Date.now() - startedAt > BUILD_STALE_MS) {
    status = "error";
    // Persist it — otherwise the document stays "building" forever and every
    // other reader of aiSummaryMeta.status keeps showing a build that died.
    ProfileModel.updateOne(
      { email: profile.email },
      {
        $set: {
          "aiSummaryMeta.status": "error",
          "aiSummaryMeta.lastError": {
            error: "BUILD_ABANDONED",
            message: "Build did not finish — the server most likely restarted mid-build.",
            step: "background",
          },
        },
      },
    ).catch(() => {});
  }
  return res.status(200).json({
    success: true,
    status,
    builtAt: meta.builtAt || null,
    buildStartedAt: meta.buildStartedAt || null,
    lastError: status === "error" && !meta.lastError
      ? { error: "BUILD_ABANDONED", message: "Build did not finish — the server most likely restarted mid-build.", step: "background" }
      : meta.lastError || null,
    wordCount: meta.wordCount || 0,
    source: meta.source || "",
    model: meta.model || "",
    summaryStale: !!profile.summaryStale,
    aiSummary: profile.aiSummary || "",
    aiSummaryMeta: meta,
  });
}

function escapeRegex(s) {
  return String(s).replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

// ── Structural contract ────────────────────────────────────────────────────
// These six headers are not cosmetic. Three separate consumers pattern-match
// them and ALL of them fail silently when one goes missing:
//   • ensureBulletInSection() below returns the text untouched when the header
//     isn't found, so both deterministic enforce passes become no-ops.
//   • jr-direct-extension/background.js → extractSummarySkipPhrases() matches
//     /#+\s*Hard Disqualifiers/ and returns [] on a miss, dropping every
//     auto-skip the brief was supposed to carry.
//   • clients-tracking → ClientAiSummary.jsx renders per-# section.
// The model is told to emit them verbatim (SYSTEM_PROMPT rule 5), but nothing
// verified it until now — a malformed brief was persisted and shipped to the
// grader with no log line anywhere.
const REQUIRED_SECTIONS = [
  "# Candidate Summary",
  "# Target Roles",
  "# Hard Constraints",
  "# Strong Signals",
  "# Hard Disqualifiers",
  "# Notes for Grader",
];

// missingSections — which required headers a brief does NOT contain. Prefix
// match, so the parenthetical suffixes ("# Strong Signals (auto-PICK if
// matched)") still count as present.
export function missingSections(text) {
  const heads = String(text || "")
    .split("\n")
    .filter((l) => /^\s*#\s/.test(l))
    .map((l) => l.trim().toLowerCase());
  return REQUIRED_SECTIONS.filter(
    (want) => !heads.some((h) => h.startsWith(want.toLowerCase())),
  );
}

// ensureRequiredSections — append any REQUIRED_SECTIONS header the brief is
// missing, each with a single placeholder bullet. The model sometimes omits
// sections it judges "empty" (sparse profile, no notes, no removal feedback)
// despite the prompt. Rather than hard-fail the whole build, we backfill so
// the six-header contract the grader + JR-direct extension depend on always
// holds. Deterministic, no LLM call.
export function ensureRequiredSections(text) {
  const missing = missingSections(text);
  if (!missing.length) return String(text || "").trimEnd();
  const missingSet = new Set(missing);
  // Split the brief into "everything before the first # header" + one block
  // per header, then rebuild in REQUIRED_SECTIONS order with the placeholders
  // slotted into place. Appending them at the end instead would render
  // e.g. "# Hard Constraints" below "# Notes for Grader" in clients-tracking.
  const lines = String(text || "").split("\n");
  const preamble = [];
  const blocks = []; // { key, lines }
  let current = null;
  for (const line of lines) {
    if (/^\s*#\s/.test(line)) {
      current = { key: line.trim().toLowerCase(), lines: [line] };
      blocks.push(current);
      continue;
    }
    (current ? current.lines : preamble).push(line);
  }
  const placeholder = (header) => [header, "- None specified."];
  const ordered = [];
  const used = new Set();
  for (const want of REQUIRED_SECTIONS) {
    if (missingSet.has(want)) {
      ordered.push(placeholder(want));
      continue;
    }
    const idx = blocks.findIndex((b, i) => !used.has(i) && b.key.startsWith(want.toLowerCase()));
    if (idx !== -1) {
      used.add(idx);
      ordered.push(blocks[idx].lines);
    }
  }
  // Anything the model added on top of the six required headers keeps its
  // content and lands after them rather than being dropped.
  blocks.forEach((b, i) => { if (!used.has(i)) ordered.push(b.lines); });
  const body = ordered
    .map((blk) => blk.join("\n").replace(/\s+$/, ""))
    .join("\n\n");
  const head = preamble.join("\n").trim();
  return (head ? `${head}\n\n${body}` : body).trimEnd();
}

// enforceRemovalDirectives — deterministic backstop for removal feedback,
// mirroring enforceNoteDirectives: for every feedback entry that rejects a
// COMPANY (chips "Company isn't a fit" / "No visa sponsorship", or free
// text naming the company), GUARANTEE "Skip <Company> jobs." exists under
// # Hard Disqualifiers — regardless of what the model emitted. This is what
// makes company rejection 100% reliable; the prompt handles the softer
// pattern-level signals (role family, seniority, location, salary).
function enforceRemovalDirectives(summary, profile, lockedSections = []) {
  const bullets = deterministicRemovalBullets(profile);
  if (!bullets.length) return summary;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  let out = summary;
  for (const b of bullets) {
    if (isLockedHeader(b.header, lockedSections)) continue; // operator owns it
    out = ensureBulletInSection(out, b.header, b.needle, b.bullet, norm);
  }
  return out;
}

// isLockedHeader — does `headerPrefix` ("# Hard Disqualifiers") name a section
// the operator locked? lockedSections stores headers WITHOUT the leading "# "
// and WITH the parenthetical suffix ("Hard Disqualifiers (auto-SKIP if
// matched)"), so compare on the normalised prefix from both ends.
//
// Locked means "AI must not touch this". mergeWithLocks honours that, but the
// enforce passes below run AFTER the merge and used to write into locked
// sections anyway — and because ClientAiSummary.jsx paints every line in a
// locked section as 'Operator', the injected bullet then read as if the
// operator had authored it.
function isLockedHeader(headerPrefix, lockedSections) {
  const want = String(headerPrefix).replace(/^#\s*/, "").trim().toLowerCase();
  if (!want) return false;
  return (Array.isArray(lockedSections) ? lockedSections : []).some((h) => {
    const got = String(h || "").replace(/^#\s*/, "").trim().toLowerCase();
    return got.startsWith(want) || want.startsWith(got);
  });
}

// enforceNoteDirectives — deterministic "round 2": after the LLM writes the
// brief, GUARANTEE every explicit `SKIP:`/`SCRAP:` operator-note line is
// reflected with the correct polarity (SCRAP→Strong Signals priority,
// SKIP→Hard Disqualifiers), and strip the malformed "[— operator priority]"
// tag the model sometimes emits. ponytail: code, not a 2nd OpenAI call.
function enforceNoteDirectives(summary, notesText, lockedSections = []) {
  if (!notesText) return summary;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  // Strip the literal "[— operator priority]" / "[— operator allows]" artifact.
  let out = summary.replace(/\s*\[\s*[—-]\s*operator (?:priority|allows)\s*\]/gi, "");
  for (const raw of String(notesText).split("\n")) {
    const m = raw.match(/^\s*(SKIP|SCRAP)\s*:\s*(.+?)\s*$/i);
    if (!m) continue;
    // Drop a redundant leading verb ("Scrap Business Intelligence" → "Business Intelligence").
    const text = m[2].replace(/^(?:do\s*not\s+scrap|don'?t\s+scrap|never\s+scrap|scrap|skip)\s+/i, "").trim();
    if (!text) continue;
    if (/^scrap$/i.test(m[1])) {
      if (isLockedHeader("# Strong Signals", lockedSections)) continue;
      out = ensureBulletInSection(out, "# Strong Signals", text, `- ${text} — operator priority`, norm);
    } else {
      if (isLockedHeader("# Hard Disqualifiers", lockedSections)) continue;
      // A conditional / full-sentence rule ("If in job title, ... do not
      // scrap them") reads wrong with a "Skip " prefix bolted on — render
      // it verbatim as its own rule bullet instead.
      const bullet = /^if\s/i.test(text) || /\bdo\s+not\b|\bdon'?t\b/i.test(text)
        ? `- ${text.replace(/[.\s]+$/, "")}.`
        : `- Skip ${text}.`;
      out = ensureBulletInSection(out, "# Hard Disqualifiers", text, bullet, norm);
    }
  }
  return out;
}

// ensureBulletInSection — append `bullet` under the given header iff the
// section doesn't already mention `needle` (normalised substring). Never
// fabricates a section; never rewrites existing lines.
function ensureBulletInSection(summary, headerPrefix, needle, bullet, norm) {
  const lines = summary.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase().startsWith(headerPrefix.toLowerCase()));
  if (start === -1) return summary;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) { if (/^#\s/.test(lines[i])) { end = i; break; } }
  if (norm(lines.slice(start + 1, end).join("\n")).includes(norm(needle))) return summary; // already present
  let at = end;
  while (at - 1 > start && lines[at - 1].trim() === "") at--; // insert after last non-blank line of section
  lines.splice(at, 0, bullet);
  return lines.join("\n");
}

async function runForProfileCore(profile, apiKey, reasonTag = "manual", deadlineAt = 0) {
  const email = profile.email;
  // When this build claimed the profile — used at persist time to tell whether
  // another trigger asked for a rebuild while this one was running.
  const buildStartedMs = profile?.aiSummaryMeta?.buildStartedAt
    ? new Date(profile.aiSummaryMeta.buildStartedAt).getTime()
    : 0;
  const resumeRes = await fetchResume(email);
  const resume = resumeRes.ok ? resumeRes.resume : null;
  const source = resume ? "profile+resume" : "profile-only";
  // "No resume assigned" (404) is a legitimate profile-only build. A network
  // error or 5xx from the resume API is NOT — it produces a materially weaker
  // brief that is indistinguishable from the legitimate case in the UI ("Built
  // from Profile only"). Flag it, and leave summaryStale set at the end so the
  // 30-min sweep rebuilds with the resume once the API recovers.
  const resumeFetchFailed = !resumeRes.ok && resumeRes.error !== "NO_RESUME";
  if (resumeFetchFailed) {
    console.error(
      `[BuildAiSummary] resume fetch FAILED email=${email} error=${resumeRes.error} msg=${resumeRes.message} — building profile-only and leaving summaryStale=true for retry`,
    );
  }

  // FRESH BUILD EVERY TIME — never feed the previous summary back into the
  // prompt. Old behaviour was diff-aware ("preserve voice, only edit
  // changed fields") which made every rebuild carry stale wording forward.
  // Now every Rebuild starts from scratch using: operator notes (highest)
  // > resume > profile. This is what the operator wants — every change
  // anywhere in those three inputs reflects across the WHOLE summary, not
  // just the diffed bullets.
  const existingSummary = "";
  const profileDiff = [];
  // Track which inputs actually fed this build so the UI can show "Built
  // from: 💬 Notes + 📄 Resume + 👤 Profile" pills + model + temperature.
  const builtInputs = {
    notes: !!(profile?.aiNotes?.text && profile.aiNotes.text.trim()),
    resume: !!resume,
    profile: true,
    removalFeedback: !!(Array.isArray(profile?.removalFeedback)
      && profile.removalFeedback.some((i) => i?.reason && String(i.reason).trim())),
  };
  // OpenAI gpt-4o-mini is the sole summary builder. Gemini path removed —
  // it repeatedly miscategorised operator-notes directives (excluded
  // companies → Strong Signals, "prioritise H1B" → Hard Disqualifiers).
  // No fallback; if OpenAI fails the build fails loudly so the operator
  // knows to fix the key / retry, instead of silently degrading.
  const overlayForPrompt = profile?.aiSummaryOverlay || null;
  // gpt-4o-mini intermittently drops one or more of the six required headers
  // from round 1 (observed: only "# Candidate Summary" + "# Target Roles"
  // emitted). That is a stochastic instruction-following miss, not a profile
  // problem — a plain reroll with an explicit "you omitted X" nudge almost
  // always produces a well-formed brief. Try up to MAX_ROUND1_ATTEMPTS times
  // before failing with MALFORMED_SUMMARY.
  const MAX_ROUND1_ATTEMPTS = 3;
  let ai = null;
  let round1Missing = [];
  let round1Raw = "";
  for (let attempt = 1; attempt <= MAX_ROUND1_ATTEMPTS; attempt++) {
    // Only reroll while there is room for a full attempt AND the notes pass
    // that follows it. Without this the retries can eat the entire build
    // budget and the brief never gets persisted at all.
    if (attempt > 1 && msLeft(deadlineAt) < 2 * OPENAI_TIMEOUT_MS) {
      console.warn(
        `[BuildAiSummary] round-1 reroll skipped (budget ${Math.round(msLeft(deadlineAt) / 1000)}s left) email=${profile.email}`,
      );
      break;
    }
    const hint = round1Missing.length
      ? `\n\nCRITICAL: your previous attempt OMITTED required section(s): ${round1Missing.join(", ")}. `
        + `Re-emit the FULL brief now with ALL SIX headers, each on its own line, exactly as: `
        + `"# Candidate Summary", "# Target Roles", "# Hard Constraints", "# Strong Signals", `
        + `"# Hard Disqualifiers", "# Notes for Grader". Do not skip any header even if a section would be short.`
      : "";
    ai = await callOpenAI(profile, resume, existingSummary, profileDiff, apiKey, overlayForPrompt, hint, deadlineAt);
    if (!ai.ok) break; // network/HTTP error — handled below, no point rerolling
    round1Raw = (ai.summary || "")
      .replace(/^\s*<{2,}[^<>]*>{2,}\s*$/gm, "")
      .trim();
    round1Missing = missingSections(round1Raw);
    if (!round1Missing.length) {
      if (attempt > 1) {
        console.log(`[BuildAiSummary] round-1 well-formed on attempt ${attempt} email=${profile.email}`);
      }
      break;
    }
    console.warn(
      `[BuildAiSummary] round-1 attempt ${attempt}/${MAX_ROUND1_ATTEMPTS} malformed email=${profile.email} missing=${round1Missing.join(", ")}`,
    );
  }
  const usedModel = OPENAI_MODEL;
  let usedSource = `${source}+openai`;
  // Append the trigger origin so the AI Summaries dashboard / logs show whether
  // this build was manual or auto-fired by profile-update / resume-attach /
  // cron-sweep / new-client-create.
  if (reasonTag && reasonTag !== "manual") {
    usedSource = `${usedSource} [auto:${reasonTag}]`;
  } else if (reasonTag === "manual") {
    usedSource = `${usedSource} [manual]`;
  }
  // Make the degraded build visible in the AI Summaries UI rather than letting
  // it read as a normal profile-only client.
  if (resumeFetchFailed) usedSource = `${usedSource} [resume-fetch-failed:${resumeRes.error}]`;
  if (!ai.ok) {
    return { success: false, status: 502, error: ai.error, message: ai.message, step: "openai" };
  }
  // Strip any whole-line <<<MARKER>>> the model echoed back from the prompt
  // fences. applyNotesPass already does this for round 2, but it returns early
  // when there are no notes and no removal directives — so without this a
  // no-notes client could keep an echoed marker in their persisted brief.
  let summary = (round1Raw || ai.summary || "")
    .replace(/^\s*<{2,}[^<>]*>{2,}\s*$/gm, "")
    .trim()
    .slice(0, MAX_SUMMARY_CHARS);
  if (!summary) {
    return { success: false, status: 502, error: "EMPTY_SUMMARY", message: "OpenAI returned empty content", step: "openai" };
  }
  // Strip [R]/[P]/[RP]/[I] markers off every bullet + prose line and build the
  // provenance map BEFORE overlay merging (overlay snapshot has no markers, so
  // we must extract while the AI output is still annotated). cleanText becomes
  // what we persist + merge + ship to the grader. provenance lands on
  // aiSummaryMeta so the UI can colour-tint each line by source.
  const provExtract = extractProvenance(summary, { noResume: !resume });
  summary = provExtract.cleanText;
  // provIndex is content-keyed, so it survives every rewrite below. The
  // positional map the UI consumes is re-derived from the FINAL text at the
  // end of this function — deriving it here would leave the colour codes
  // pointing at the wrong lines the moment anything inserts a bullet.
  const provIndex = provExtract.index;
  // Round 1 must already carry the six required headers. If it doesn't, the
  // enforce passes and the extension's skip matcher are both no-ops, so fail
  // loudly instead of persisting a brief that silently grades on nothing.
  const missingRound1 = missingSections(summary);
  if (missingRound1.length) {
    // The retry loop above already gave the model MAX_ROUND1_ATTEMPTS tries.
    // If headers are STILL missing, backfill them with a placeholder bullet
    // instead of failing the build — a persisted brief with an empty section
    // is far better than no brief at all, and the 6-header contract stays
    // intact for the grader + extension skip matcher.
    console.warn(
      `[BuildAiSummary] round-1 still missing ${missingRound1.join(", ")} after ${MAX_ROUND1_ATTEMPTS} attempts email=${profile.email} — backfilling placeholders`,
    );
    summary = ensureRequiredSections(summary.slice(0, MAX_SUMMARY_CHARS));
  }
  // Round 2 (LLM): re-apply the operator notes AND the pre-resolved removal
  // directives so every directive is reflected with correct polarity. The
  // deterministic enforce* passes below are the guarantee if this misses.
  const removalDirectivesText = usableRemovalFeedback(profile)
    .flatMap((entry) => {
      const label = [entry.jobTitle, entry.companyName].filter(Boolean).join(" @ ");
      return resolveEntryDirectives(entry).map((d) => `${label ? `[${label}] ` : ""}${d}`);
    })
    .join("\n");
  const beforeNotesPass = summary;
  summary = (await applyNotesPass(summary, (profile?.aiNotes?.text || "").trim(), apiKey, removalDirectivesText, deadlineAt)).slice(0, MAX_SUMMARY_CHARS);
  // The notes pass rewrites the WHOLE brief. If its rewrite dropped a required
  // section, keep round 1 — a brief that lost # Hard Disqualifiers grades with
  // no auto-skips at all, which is worse than one missing a note directive
  // (the deterministic enforce passes below still re-apply those).
  const missingAfterNotes = missingSections(summary);
  if (missingAfterNotes.length) {
    console.warn(
      `[BuildAiSummary] notes pass dropped section(s) ${missingAfterNotes.join(", ")} email=${profile.email} — reverting to round-1 brief`,
    );
    summary = beforeNotesPass;
  }
  // round-1 itself may have been backfilled with placeholders above; if the
  // revert still leaves anything missing, backfill again so we can't ship a
  // brief with fewer than six headers.
  summary = ensureRequiredSections(summary.slice(0, MAX_SUMMARY_CHARS));
  // Apply operator's saved format overlay: if enabled, re-inject any bullets
  // the operator added on top of the previous build + replace any
  // locked-section bodies verbatim. Pure AI output if no overlay or overlay
  // disabled. Trims to MAX_SUMMARY_CHARS after merge so a long overlay can't
  // bust the doc size cap.
  const overlay = profile?.aiSummaryOverlay || {};
  let overlayStats = null;
  let lockCount = 0;
  // Locks only bind when the overlay is actually enabled with saved text —
  // that is the only path where mergeWithLocks runs, so it is also the only
  // case where the enforce passes must hold off.
  const activeLocks =
    overlay.enabled && overlay.savedText && Array.isArray(overlay.lockedSections)
      ? overlay.lockedSections
      : [];
  if (overlay.enabled && overlay.savedText) {
    const locks = Array.isArray(overlay.lockedSections) ? overlay.lockedSections : [];
    lockCount = locks.length;
    const merged = locks.length
      ? mergeWithLocks(summary, overlay.savedText, locks)
      : mergeOverlay(summary, overlay.savedText);
    if (typeof merged === "string" && merged.trim().length) {
      summary = merged.slice(0, MAX_SUMMARY_CHARS);
      overlayStats = countOverlayBullets(overlay.savedText, summary);
      const tagParts = [];
      if (overlayStats.total) tagParts.push(`+overlay:${overlayStats.total}`);
      if (lockCount) tagParts.push(`+locks:${lockCount}`);
      if (tagParts.length) {
        usedSource = `${usedSource} ${tagParts.join(" ")}`;
        console.log(`[BuildAiSummary] overlay applied email=${profile.email} extras=${overlayStats?.total || 0} locks=${lockCount}`);
      }
    }
  }
  // Round 2 (deterministic): guarantee every SKIP:/SCRAP: operator-note line is
  // present with the right polarity, regardless of what the LLM emitted.
  summary = enforceNoteDirectives(summary, (profile?.aiNotes?.text || "").trim(), activeLocks).slice(0, MAX_SUMMARY_CHARS);
  // Round 3 (deterministic): guarantee every company-rejecting removal
  // feedback entry produced its "Skip <Company> jobs." disqualifier.
  summary = enforceRemovalDirectives(summary, profile, activeLocks).slice(0, MAX_SUMMARY_CHARS);
  // Final structural check — the overlay merge can drop a section too (a saved
  // overlay from an older prompt version, a lock whose body was emptied).
  const missingFinal = missingSections(summary);
  if (missingFinal.length) {
    console.warn(
      `[BuildAiSummary] FINAL brief missing section(s) ${missingFinal.join(", ")} email=${profile.email} — backfilling placeholders before persist`,
    );
    summary = ensureRequiredSections(summary.slice(0, MAX_SUMMARY_CHARS));
  }
  // Now that the text is final, derive the positional provenance the UI reads.
  const aiProvenance = provenanceForText(summary, provIndex);
  const wordCount = summary.trim().split(/\s+/).filter(Boolean).length;

  const builtAt = new Date();
  // Keep the outgoing summary as the "previous version" so the tracking UI
  // can diff old vs new after every rebuild.
  const previousSnapshot = (profile?.aiSummary || "").trim()
    ? {
        text: profile.aiSummary,
        builtAt: profile.aiSummaryMeta?.builtAt || null,
        source: profile.aiSummaryMeta?.source || "",
        wordCount: profile.aiSummaryMeta?.wordCount || 0,
      }
    : null;
  const updated = await ProfileModel.findOneAndUpdate(
    { _id: profile._id },
    {
      $set: {
        ...(previousSnapshot ? { aiSummaryPrevious: previousSnapshot } : {}),
        aiSummary: summary,
        aiSummaryMeta: {
          builtAt,
          model: usedModel,
          source: usedSource || source,
          wordCount,
          profileSnapshot: snapshotProfile(profile),
          provenance: aiProvenance || null,
          builtInputs,
          temperature: SUMMARY_TEMPERATURE,
          lastAttemptAt: builtAt,
          status: "done",
          buildStartedAt: profile?.aiSummaryMeta?.buildStartedAt || null,
          lastError: null,
        },
        // Stay stale when the resume API failed, so the cron sweep retries and
        // upgrades this profile-only brief once the resume is reachable again.
        summaryStale: resumeFetchFailed,
      },
    },
    { new: true, lean: true },
  );

  // A trigger that fired while this build was running was skipped as a
  // duplicate, so this brief does not reflect whatever changed. Keep the
  // profile stale and let the 30-min sweep rebuild it.
  const requestedDuringBuild = updated?.summaryRebuildRequestedAt
    && buildStartedMs
    && new Date(updated.summaryRebuildRequestedAt).getTime() > buildStartedMs;
  if (requestedDuringBuild && !resumeFetchFailed) {
    console.log(`[BuildAiSummary] rebuild was requested mid-build email=${profile.email} — leaving summaryStale=true for the sweep`);
    await ProfileModel.updateOne({ _id: profile._id }, { $set: { summaryStale: true } }).catch(() => {});
  } else if (updated?.summaryRebuildRequestedAt) {
    // This build started after the request, so it already reflects it. Clear
    // the flag or the sweeper's cooldown exemption would fire forever.
    await ProfileModel.updateOne({ _id: profile._id }, { $set: { summaryRebuildRequestedAt: null } }).catch(() => {});
  }

  return {
    success: true,
    status: 200,
    aiSummary: summary,
    wordCount,
    source: usedSource || source,
    model: usedModel,
    builtAt: builtAt.toISOString(),
    resumeFound: !!resume,
    profile: updated
      ? {
          email: updated.email,
          aiSummary: updated.aiSummary,
          aiSummaryMeta: updated.aiSummaryMeta,
        }
      : null,
  };
}
