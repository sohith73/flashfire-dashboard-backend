// rejectionJobMatcher - decide WHICH of a client's job cards a rejection mail is about.
//
// Pure: no Mongo, no network, no clock. The caller loads the client's jobs and
// hands them in; this module returns a verdict and never writes anything.
//
// PRECISION OVER RECALL. A card wrongly moved to Rejected is a client-visible
// error and wrecks the client's trust in the board; a rejection we fail to
// match just stays where it was, which is today's behaviour. So every rule
// below defaults to "do nothing" and a match needs two independent things to
// line up: the COMPANY, and either the ROLE or the fact that the client has
// exactly one live application at that company.
//
// Measured on staging (60 recent genuine rejections, company-name match only):
// exactly one job 18, several jobs 31, none 11. Company alone is not enough,
// which is why the role disambiguates the "several" case.
//
// Company evidence comes in two strengths:
//   STRONG  the job's company equals a company the mail names (verifier output,
//           the sender display name, "... at X" in the subject), or the sender
//           domain / careers URL carries it (careers.acme.com, jobs.lever.co/acme).
//   WEAK    the company's words merely appear in the subject, sender or summary,
//           or the mail names a longer / shorter relative ("Cape Analytics" vs
//           "Cape"). Weak evidence is only accepted together with the role.
//
// ATS hosts (greenhouse, workday, ashby ...) are never company evidence on
// their own: every client's mail comes from them.

import { classifyStatus } from "./clientActivityStats.js";
import { parseLocaleDateMs, objectIdTimeMs } from "./jobActivityTime.js";

export const MATCH_STATUS = Object.freeze({
  MATCHED: "matched",
  AMBIGUOUS: "ambiguous",
  NO_MATCH: "no_match"
});

const STRONG = 2;
const WEAK = 1;

/**
 * Role score needed when the mail names a role. Dice 0.9 means near-identical
 * titles: "Senior Sales Data Analyst" vs "Senior Financial Data Analyst" (0.75)
 * and "Software Engineer" vs "Software Engineer, Product Platform" (0.67) are
 * different postings and must not match.
 */
const ROLE_MIN_STRONG = 0.9;
const ROLE_MIN_WEAK = 0.9;
/** Winner must beat the runner-up by this much, or the match is ambiguous. */
const ROLE_MARGIN = 0.2;
/** Penalty when exactly one side says senior / junior / intern / lead ... */
const SENIORITY_PENALTY = 0.35;
/** A card rejected this recently at the same company makes a role-less rejection ambiguous. */
const RECENT_REJECT_MS = 7 * 24 * 60 * 60 * 1000;
/** Applied-date slack: dates are locale strings, day-level at best. */
const APPLIED_SLACK_MS = 2 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

const ENTITIES = { "&amp;": "&", "&nbsp;": " ", "&#39;": "'", "&apos;": "'", "&quot;": '"', "&lt;": "<", "&gt;": ">" };

export function decodeEntities(s) {
  return String(s || "")
    .replace(/&(?:amp|nbsp|apos|quot|lt|gt|#39);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function plain(s) {
  return decodeEntities(s)
    .normalize("NFKD")
    .replace(/[̀-ͯ​-‏⁠﻿]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();
}

const LEGAL_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "llp", "lp", "ltd", "limited", "gmbh", "plc", "corp", "corporation",
  "co", "company", "ag", "sa", "nv", "bv", "pty", "pvt", "private", "lc"
]);
const COMPANY_NOISE = new Set(["the"]);
const TEAM_WORDS = new Set([
  "hiring", "recruiting", "recruitment", "recruiter", "talent", "acquisition", "careers", "career", "jobs", "team",
  "people", "hr", "human", "resources", "notifications", "no", "reply", "noreply", "communication", "workday", "system"
]);

/** Company name -> comparable token list ("The Acme Corp., Inc." -> ["acme"]). */
export function companyTokens(name) {
  const toks = plain(name).split(" ").filter(Boolean);
  const out = toks.filter((t) => !COMPANY_NOISE.has(t));
  while (out.length > 1 && LEGAL_SUFFIXES.has(out[out.length - 1])) out.pop();
  return out;
}

const ABBREVIATIONS = {
  sr: "senior", snr: "senior", jr: "junior", jnr: "junior",
  eng: "engineer", engr: "engineer", engg: "engineer", engineering: "engineer",
  mgr: "manager", mngr: "manager", dev: "developer", devops: "devops",
  swe: "software engineer", sde: "software engineer", sdet: "sdet",
  ml: "ml", ai: "ai", qa: "qa", ii: "2", iii: "3", iv: "4", i: "1",
  assoc: "associate", admin: "administrator", analytics: "analyst", analysis: "analyst",
  dir: "director", vp: "vp", intl: "international", sw: "software", hw: "hardware"
};
const TITLE_STOP = new Set([
  "a", "an", "and", "or", "of", "the", "for", "in", "at", "to", "with", "on", "as", "by",
  "remote", "hybrid", "onsite", "fulltime", "full", "time", "parttime", "part", "contract", "usa", "us", "united", "states",
  "opening", "opportunity", "position", "role", "job", "new", "grad", "level"
]);
const SENIORITY = new Set(["senior", "junior", "intern", "internship", "lead", "staff", "principal", "head", "director", "manager", "vp", "associate", "graduate", "entry", "chief"]);

/** Job title -> comparable token list. "Sr. SW Eng (Remote)" -> senior, software, engineer. */
export function titleTokens(title) {
  let s = decodeEntities(title)
    .replace(/\(\s*[A-Za-z]*\d[\w-]*\s*\)/g, " ") // requisition ids: (70387)
    .replace(/\b(?:req|r|jr|id)[-#: ]?\d{3,}\b/gi, " ")
    .replace(/\(.*?\)/g, " "); // (Remote), (Boston, MA)
  const out = [];
  for (const raw of plain(s).split(" ")) {
    if (!raw) continue;
    let t = raw;
    if (ABBREVIATIONS[t] !== undefined) {
      for (const piece of ABBREVIATIONS[t].split(" ")) out.push(piece);
      continue;
    }
    if (/^\d{3,}$/.test(t)) continue; // bare requisition numbers
    if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
    if (TITLE_STOP.has(t)) continue;
    out.push(t);
  }
  return out;
}

/** Tokens from "(...)" groups of a title, e.g. "(Merchant Advocacy)". Requisition ids are dropped. */
export function parenTokens(title) {
  const out = [];
  for (const g of decodeEntities(title).matchAll(/\(([^)]*)\)/g)) {
    if (/^\s*[A-Za-z]*\d[\w-]*\s*$/.test(g[1])) continue;
    out.push(...titleTokens(g[1]));
  }
  return out;
}

function seniorityOf(tokens) {
  return new Set(tokens.filter((t) => SENIORITY.has(t)));
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Dice coefficient over distinct tokens, minus a penalty for a seniority clash. */
export function roleSimilarity(jobTokens, mailTokens) {
  const a = new Set(jobTokens);
  const b = new Set(mailTokens);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  let score = (2 * common) / (a.size + b.size);
  if (!sameSet(seniorityOf(jobTokens), seniorityOf(mailTokens))) score -= SENIORITY_PENALTY;
  return Math.max(0, score);
}

/**
 * Role score for a job title against the role named in the mail. Parenthetical
 * qualifiers ("(Remote)", "(Identity Decisioning)") are ignored unless BOTH sides
 * have some, because then they are what tells two near-identical postings apart.
 */
export function titleSimilarity(jobTitle, mailTitle) {
  const base = roleSimilarity(titleTokens(jobTitle), titleTokens(mailTitle));
  const pj = parenTokens(jobTitle);
  const pm = parenTokens(mailTitle);
  const noise = new Set(["remote", "hybrid", "onsite"]);
  const realJ = pj.filter((t) => !noise.has(t));
  const realM = pm.filter((t) => !noise.has(t));
  if (!realJ.length || !realM.length) return base;
  const full = roleSimilarity([...titleTokens(jobTitle), ...pj], [...titleTokens(mailTitle), ...pm]);
  return Math.min(base, full);
}

/** True when every token of the job title occurs in the mail text tokens. */
function titleFullyInText(jobTokens, textTokenSet) {
  if (jobTokens.length < 2) return false; // one word ("Engineer") matches everything
  return jobTokens.every((t) => textTokenSet.has(t));
}

// ---------------------------------------------------------------------------
// Mail facts
// ---------------------------------------------------------------------------

/** Hosts that carry mail for every employer, so say nothing about which one. */
const ATS_LABELS = new Set([
  "greenhouse", "greenhouse-mail", "lever", "hire", "workday", "myworkday", "myworkdayjobs", "ashbyhq", "ashby",
  "smartrecruiters", "icims", "taleo", "successfactors", "jobvite", "bamboohr", "breezy", "recruitee", "workable",
  "applytojob", "jazzhr", "teamtailor", "pinpointhq", "rippling", "paylocity", "paycom", "ultipro", "ukg", "oraclecloud",
  "eightfold", "phenom", "avature", "brassring", "cornerstoneondemand", "hrmdirect", "applicantpro", "gem", "dover",
  "wellfound", "linkedin", "indeed", "ziprecruiter", "glassdoor", "gmail", "google", "outlook", "microsoft", "yahoo",
  "sendgrid", "mailgun", "amazonses", "mcdlv", "mailchimp", "salesforce", "force", "hubspot", "zohorecruit", "zoho",
  "dayforcehcm", "adp", "csod", "peopleclick", "careerpuck", "recruiterbox", "jobscore", "comeet", "personio", "join",
  "jobs2web", "sapsf", "sap", "wd1", "wd3", "wd5", "wd12", "wd103", "fa", "ocs", "hcmui", "mail", "email", "e", "em", "notify"
]);
const GENERIC_LABELS = new Set([
  "www", "careers", "career", "jobs", "job", "talent", "recruiting", "recruit", "recruitment", "hr", "apply", "no", "reply",
  "noreply", "donotreply", "do-not-reply", "no-reply", "notifications", "notification", "mail", "email", "mailer", "hiring",
  "people", "team", "update", "updates", "status", "com", "net", "org", "io", "co", "us", "uk", "ca", "au", "de", "in", "eu",
  "app", "ai", "dev", "info", "support", "hello", "recruiter", "candidates", "candidate", "workforce", "employment"
]);

function splitAddress(from) {
  const s = decodeEntities(from);
  const m = s.match(/<([^>]+)>/);
  const addr = (m ? m[1] : s.match(/[^\s<>"]+@[^\s<>"]+/)?.[0] || "").trim().toLowerCase();
  const display = (m ? s.slice(0, s.indexOf("<")) : "").replace(/["']/g, "").trim();
  return { addr, display };
}

function domainLabels(host) {
  return String(host || "")
    .toLowerCase()
    .split(".")
    .filter(Boolean)
    .map((l) => l.replace(/[^a-z0-9-]/g, ""))
    // Locale path/host pieces ("en-us", "fr-ca") are not names.
    .filter((l) => l && !/^[a-z]{2}(?:-[a-z]{2})?$/.test(l) && !GENERIC_LABELS.has(l) && !ATS_LABELS.has(l));
}

/** Labels from the sender domain and from careers URLs ("jobs.lever.co/acme", "acme.wd5.myworkdayjobs.com"). */
export function senderDomainLabels({ from, urls }) {
  const labels = new Set();
  const { addr } = splitAddress(from);
  const host = addr.split("@")[1] || "";
  for (const l of domainLabels(host)) labels.add(l);
  for (const u of Array.isArray(urls) ? urls : []) {
    let url;
    try {
      url = new URL(String(u));
    } catch {
      continue;
    }
    const h = url.hostname.toLowerCase();
    const hostIsAts = h.split(".").some((l) => ATS_LABELS.has(l));
    for (const l of domainLabels(h)) labels.add(l);
    // Path-slug style ATS boards: jobs.lever.co/acme/..., boards.greenhouse.io/acme/...
    if (hostIsAts) {
      const slug = url.pathname.split("/").filter(Boolean)[0];
      const low = slug ? slug.toLowerCase() : "";
      if (low && /^[a-z0-9-]{3,}$/.test(low) && !/^[a-z]{2}-[a-z]{2}$/.test(low) && !GENERIC_LABELS.has(low) && !ATS_LABELS.has(low)) labels.add(low);
    }
  }
  return [...labels];
}

function cleanTitle(s) {
  let t = decodeEntities(s)
    .replace(/\s+/g, " ")
    .replace(/\(\s*[A-Za-z]*\d[\w-]*\s*\)\s*$/, "")
    .replace(/^[\s\-:,"']+|[\s\-:,."'!]+$/g, "")
    .replace(/^(?:the\s+)?(?:role|position)\s+of\s+/i, "")
    .trim();
  t = t.replace(/\s*[-\u2013]?\s*\b(?:role|position|opening|opportunity)s?\b(?:\s+(?:here|at|with|in)\b.*)?$/i, "").replace(/[\s\-\u2013:,]+$/, "").trim();
  if (t.length < 3 || t.length > 90) return "";
  // Placeholders the mail templates leave behind: "[not available]", "[[job_title]]", "current", "Employment".
  if (/[\[\]{}]|^(?:current|employment|this|the|open|our|a|an|new|your|available|not available|n\/a|na|null|undefined)$/i.test(t)) return "";
  if (/\b(application|update|status|thank|interest|your|candidate)\b/i.test(t) && t.split(" ").length > 6) return "";
  return t;
}

function cleanCompany(s) {
  let c = decodeEntities(s)
    .replace(/\s+/g, " ")
    .replace(/^[\s\-:,"']+|[\s\-:,."'!]+$/g, "")
    .trim();
  if (c.length < 2 || c.length > 80) return "";
  // Sentence tail captured by a greedy pattern is not a company name.
  if (c.split(" ").length > 7) return "";
  return c;
}

/** Strip "Hiring Team" style tails from a sender display name. */
function senderCompanyFromDisplay(display) {
  const toks = String(decodeEntities(display) || "").trim().split(/\s+/).filter(Boolean);
  while (toks.length && TEAM_WORDS.has(plain(toks[toks.length - 1]))) toks.pop();
  // "Acme Careers Team" style leaves just the name; a bare "Recruiting" leaves nothing.
  const name = toks.join(" ").replace(/[,\s]+$/, "");
  if (!name || /^(system|noreply|no reply|donotreply|do not reply|talent|recruiting|careers)$/i.test(name)) return "";
  return cleanCompany(name);
}

const TITLE_PATTERNS = [
  /\byour\s+(.{3,80}?)\s+application\s+(?:at|with|to)\s+/i, // Update on your SWE application at Acme
  /\b(?:application|applying|applied|apply)\s+(?:for|to)\s+(?:the\s+)?(?:position\s+of\s+)?-?\s*([^.\n]{3,80}?)\s+(?:at|with)\s+/i, // application for X at Y
  /\b(?:for|in|and|of|with|to)\s+(?:the|our)\s+(.{3,80}?)\s+(?:role|position|opportunity|opening)\b/i, // in the X position
  /\binterest\s+in\s+(?:the\s+)?(.{3,70}?)\s+(?:role|position|opening)\b/i, // interest in X position at Y
  /\b(?:application|applying)\s+for\s+-?\s*([^.\n]{3,80})$/i, // subject: ... Application for - X (123)
  /\b(?:the|our)\s+(.{3,80}?)\s+(?:role|position)\s+(?:at|with)\s+/i, // the X role at Y
  /\b(?:role|position)\s+of\s+(.{3,80}?)(?:\s+(?:at|with|in)\s|[.,!;]|$)/i, // the role of X at Y
  /\binterest\s+in\s+.{2,60}?\s+and\s+our\s+(.{3,80}?)(?:[.!;]|\s+(?:role|position|opening)\b)/i, // interest in Acme and our X.
  /\bopening\s+for\s+(?:a|an|the)\s+(.{3,80}?)(?:[.!;]|\s+(?:at|with)\s)/i, // our opening for a X!
  /\bapply(?:ing)?\s+for\s+(?:the\s+)?(?:position\s+of\s+)?(?!(?:a|an|the|this|our)\b)(.{3,80}?)(?:[.!;]|\s+(?:at|with)\s)/i // apply for X.
];

const COMPANY_PATTERNS = [
  /\b(?:role|position|application|opportunity|opening|candidacy|interview|time)s?\s+(?:at|with)\s+([^.,;!\n]{2,70})/i,
  /\bapply(?:ing)?\s+(?:to|at|with)\s+([^.,;!\n]{2,70})/i,
  /\b(?:application|applying)\s+to\s+([^.,;!\n]{2,70})/i,
  /\binterest\s+in\s+(?!the\b|our\b|this\b|working\b|a\b|an\b|joining\b)([^.,;!\n]{2,70})/i,
  /\bupdate\s+(?:from|on)\s+([^.,;!\n]{2,70})$/i
];

/** First capture that survives `accept`; later patterns and texts are tried when one is junk. */
function firstMatch(patterns, texts, accept = () => true) {
  for (const text of texts) {
    if (!text) continue;
    for (const re of patterns) {
      const m = String(decodeEntities(text)).match(re);
      if (m && m[1] && accept(m[1])) return m[1];
    }
  }
  return "";
}

/** A captured "title" that is really a sentence fragment ("time you have invested to apply for the"). */
const SENTENCE_WORDS = /\b(?:you|your|we|our|have|has|had|time|invested|apply|applying|applied|interest|interested|thank|thanks|candidacy|consider\w*)\b/i;
function plausibleTitle(raw) {
  const t = cleanTitle(raw);
  return !!t && titleTokens(t).length > 0 && !SENTENCE_WORDS.test(t);
}

/** Trailing "... and for ..." / " - Req" clutter after a regex company capture. */
function trimCompanyTail(c) {
  return String(c || "")
    .replace(/\s+(?:and|for|as|so|because|which|where|that|we|is|was|has|have|but|after|regarding)\b.*$/i, "")
    .replace(/\s+\(.*$/, "");
}

/**
 * Best-effort extraction from what a digest stores (no body): used for digests
 * written before the verifier returned company/jobTitle, and as a cross-check.
 */
export function extractMailFacts({ from, subject, summary, snippet, urls, company, jobTitle } = {}) {
  const { display } = splitAddress(from);
  const text = [subject, summary, snippet];
  const companies = [];
  const add = (c, source) => {
    const cc = cleanCompany(trimCompanyTail(c));
    if (cc && companyTokens(cc).length) companies.push({ name: cc, source });
  };
  if (company) add(company, "verifier");
  const senderCo = senderCompanyFromDisplay(display);
  if (senderCo) add(senderCo, "sender");
  const subjCo = firstMatch(COMPANY_PATTERNS, [subject]);
  if (subjCo) add(subjCo, "subject");
  const bodyCo = firstMatch(COMPANY_PATTERNS, [summary, snippet]);
  if (bodyCo) add(bodyCo, "summary");

  let title = cleanTitle(jobTitle || "");
  let titleSource = title ? "verifier" : "";
  if (!title) {
    const t = cleanTitle(firstMatch(TITLE_PATTERNS, text, plausibleTitle));
    if (t) {
      title = t;
      titleSource = "regex";
    }
  }
  return {
    companies,
    jobTitle: title,
    jobTitleSource: titleSource,
    domainLabels: senderDomainLabels({ from, urls }),
    subject: String(subject || ""),
    sender: display,
    summary: String(summary || ""),
    snippet: String(snippet || "")
  };
}

// ---------------------------------------------------------------------------
// Company comparison
// ---------------------------------------------------------------------------

function tokensEqual(a, b) {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** One is a leading-word prefix of the other ("cape" / "cape analytics"). */
function tokensPrefix(a, b) {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length < l.length && s.every((t, i) => t === l[i]);
}

function containsRun(haystack, needle) {
  if (!needle.length || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * How strongly does this job's company agree with the mail? 0 = not at all.
 * Returns { level, why }.
 */
export function companyEvidence(jobCompany, facts) {
  const jt = companyTokens(jobCompany);
  if (!jt.length || (jt.length === 1 && jt[0] === "unknown")) return { level: 0, why: "" };
  const compact = jt.join("");
  const shortName = compact.length <= 3;
  let level = 0;
  let why = "";
  const bump = (l, w) => {
    if (l > level) {
      level = l;
      why = w;
    }
  };

  let conflict = false;
  for (const c of facts.companies) {
    const ct = companyTokens(c.name);
    if (!ct.length) continue;
    if (tokensEqual(ct, jt)) bump(STRONG, `company "${c.name}" (${c.source})`);
    else if (tokensPrefix(ct, jt)) bump(WEAK, `partial company "${c.name}" (${c.source})`);
    else if (c.source === "verifier") conflict = true;
  }
  // The verifier read the whole mail. If it named a different company, the
  // sender domain and loose text hits below are not allowed to overrule it.
  if (conflict && level === 0) return { level: 0, why: "verifier names a different company" };

  if (!shortName) {
    for (const label of facts.domainLabels) {
      if (label === compact || (jt.length > 1 && label === jt[0] && jt[0].length >= 5)) {
        bump(STRONG, `sender domain "${label}"`);
      }
    }
  }
  // Loose text hits are only allowed when the mail names no company of its own.
  // If the verifier, the sender or the subject already named one and it is not
  // this job's, a stray word ("a square fit") must not pull in another employer.
  const namedElsewhere = facts.companies.some((c) => c.source !== "summary");
  if (level === 0 && !namedElsewhere) {
    const zones = [facts.subject, facts.sender, facts.summary, facts.snippet];
    for (const z of zones) {
      if (containsRun(plain(z).split(" ").filter(Boolean), jt)) {
        bump(WEAK, "company words in mail text");
        break;
      }
    }
  }
  return { level, why };
}

// ---------------------------------------------------------------------------
// Candidate eligibility
// ---------------------------------------------------------------------------

/**
 * A job may be auto-rejected only when it is live in the pipeline (applied or
 * interviewing) and existed before the mail arrived. Saved, offer, removed,
 * deleted and already-rejected cards are never touched.
 */
export function isEligibleCandidate(job, mailDateMs) {
  const bucket = classifyStatus(job?.currentStatus);
  if (bucket !== "applied" && bucket !== "interview") return false;
  // "offer" inside e.g. "interview - offer pending" is caught by classifyStatus
  // (offer wins), so an offer-stage card never reaches here.
  if (Number.isFinite(mailDateMs)) {
    const created = job?._id ? objectIdTimeMs(job._id) : null;
    if (created != null && created > mailDateMs) return false;
    const applied = parseLocaleDateMs(job?.appliedDate);
    if (applied != null && applied > mailDateMs + APPLIED_SLACK_MS) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

const summarise = (c) => ({
  jobID: c.job.jobID,
  companyName: c.job.companyName,
  jobTitle: c.job.jobTitle,
  currentStatus: c.job.currentStatus,
  companyLevel: c.level === STRONG ? "strong" : "weak",
  roleScore: c.roleScore == null ? null : Math.round(c.roleScore * 100) / 100
});

const verdict = (status, reason, chosen, candidates) => ({
  status,
  jobId: chosen ? chosen.job.jobID : null,
  job: chosen ? chosen.job : null,
  reason,
  candidates: candidates.map(summarise)
});

/**
 * @param {Object} mail  { from, subject, summary, snippet, urls, date, company, jobTitle }
 * @param {Array}  jobs  the client's job docs (jobID, jobTitle, companyName, currentStatus, appliedDate, _id)
 * @returns {{status:"matched"|"ambiguous"|"no_match", jobId:string|null, job:Object|null, reason:string, candidates:Array}}
 */
export function matchRejectionToJob(mail, jobs) {
  const facts = extractMailFacts(mail || {});
  const dateMs = mail?.date ? new Date(mail.date).getTime() : NaN;
  const live = (Array.isArray(jobs) ? jobs : []).filter((j) => isEligibleCandidate(j, dateMs));
  if (!live.length) return verdict(MATCH_STATUS.NO_MATCH, "no applied or interview jobs to match", null, []);
  if (!facts.companies.length && !facts.domainLabels.length) {
    return verdict(MATCH_STATUS.NO_MATCH, "mail names no company", null, []);
  }

  // Cards at the mail's company already rejected within a week of this mail. A
  // second mail from the same employer (follow-up, duplicate notice) must not
  // fall through to the client's OTHER job there when the mail names no role.
  const blockers = [];
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (classifyStatus(j?.currentStatus) !== "rejected") continue;
    const ts = parseLocaleDateMs(j?.updatedAt);
    if (Number.isFinite(dateMs) && ts != null && (ts < dateMs - RECENT_REJECT_MS || ts > dateMs + RECENT_REJECT_MS)) continue;
    if (companyEvidence(j.companyName, facts).level > 0) blockers.push(j);
  }

  const mailTitleTokens = facts.jobTitle ? titleTokens(facts.jobTitle) : [];
  const textTokens = new Set(titleTokens([facts.subject, facts.summary, facts.snippet].join(" . ")));

  const cands = [];
  for (const job of live) {
    const ev = companyEvidence(job.companyName, facts);
    if (ev.level === 0) continue;
    const jt = titleTokens(job.jobTitle);
    const c = { job, level: ev.level, why: ev.why, jobTokens: jt, roleScore: null, inText: false };
    if (mailTitleTokens.length) {
      c.roleScore = titleSimilarity(job.jobTitle, facts.jobTitle);
      // JobModel.jobTitle is capped at 50 chars, so a long posting title is stored cut off.
      const len = String(job.jobTitle || "").length;
      if (len >= 48) c.roleScore = Math.max(c.roleScore, titleSimilarity(job.jobTitle, facts.jobTitle.slice(0, len)));
    }
    else c.inText = titleFullyInText(jt, textTokens);
    cands.push(c);
  }
  if (!cands.length) return verdict(MATCH_STATUS.NO_MATCH, "no job at the mail's company", null, []);

  // Mail names a role: it must agree with the job.
  if (mailTitleTokens.length) {
    const ok = cands.filter((c) => c.roleScore >= (c.level === STRONG ? ROLE_MIN_STRONG : ROLE_MIN_WEAK));
    if (!ok.length) return verdict(MATCH_STATUS.NO_MATCH, `role "${facts.jobTitle}" does not match the company's jobs`, null, cands);
    if (ok.length === 1) {
      return verdict(MATCH_STATUS.MATCHED, `${ok[0].why}; role "${facts.jobTitle}" ~ "${ok[0].job.jobTitle}" (${ok[0].roleScore.toFixed(2)})`, ok[0], cands);
    }
    ok.sort((a, b) => b.roleScore - a.roleScore);
    if (ok[0].roleScore - ok[1].roleScore >= ROLE_MARGIN) {
      return verdict(MATCH_STATUS.MATCHED, `${ok[0].why}; best role "${ok[0].job.jobTitle}" (${ok[0].roleScore.toFixed(2)}) beats runner-up (${ok[1].roleScore.toFixed(2)})`, ok[0], cands);
    }
    return verdict(MATCH_STATUS.AMBIGUOUS, "several jobs at the company fit the role equally", null, cands);
  }

  // Mail names no role.
  if (blockers.length) {
    return verdict(MATCH_STATUS.AMBIGUOUS, `another job at this company was rejected within 7 days ("${blockers[0].jobTitle}"); the mail names no role`, null, cands);
  }
  const strong = cands.filter((c) => c.level === STRONG);
  const pool = strong.length ? strong : cands;
  if (strong.length === 1) {
    return verdict(MATCH_STATUS.MATCHED, `${strong[0].why}; the client has one live job at this company`, strong[0], cands);
  }
  const covered = pool.filter((c) => c.inText);
  if (covered.length === 1) {
    return verdict(MATCH_STATUS.MATCHED, `${covered[0].why}; title "${covered[0].job.jobTitle}" appears in the mail`, covered[0], cands);
  }
  if (covered.length > 1) {
    // "Senior Software Engineer" in the mail also covers a "Software Engineer"
    // card; the longest fully-covered title wins only if it is unique.
    covered.sort((a, b) => b.jobTokens.length - a.jobTokens.length);
    if (covered[0].jobTokens.length > covered[1].jobTokens.length) {
      return verdict(MATCH_STATUS.MATCHED, `${covered[0].why}; most specific title in the mail is "${covered[0].job.jobTitle}"`, covered[0], cands);
    }
  }
  return verdict(MATCH_STATUS.AMBIGUOUS, "several jobs at the company and the mail does not single one out", null, cands);
}
