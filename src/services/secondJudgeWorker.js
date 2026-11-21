// secondJudgeWorker — second-stage screening of extension-pushed jobs.
//
// The JR-Direct extension judges jobs on JobRight's own description only (no
// scraper) and pushes the matches to the dashboard. This worker is the second
// gate: for each such job it opens the REAL employer posting via the scraper,
// scrapes the full visible text, and re-judges that text against the client
// profile (LOCATION + FRESHNESS only).
//
// The two failure kinds are treated DIFFERENTLY, on purpose:
//   • FRESHNESS (skipKind 'threshold') — the posting is closed / expired / stale.
//     Nobody can apply to it, so there is nothing for an operator to decide: the
//     job is moved to the Removed column ("removed by AI") IMMEDIATELY, carrying
//     the reason.
//   • LOCATION (skipKind 'location-mismatch') — judgement call (the client may
//     still want a London role). The job is FLAGGED and KEPT; it shows up in the
//     CRM "AI second-stage flags" queue and only an operator can remove it.
// A pass or a skip never moves the job.
//
// Removing on freshness needs TWO independent keys, because an LLM alone is not
// trustworthy about dates: the grader must return skipKind 'threshold' AND the
// scraped text must carry deterministic evidence (an explicit closed/expired
// statement, or a parsed posted-date older than STALE_POSTING_DAYS). If the
// grader says "expired" but the page shows no such evidence, we KEEP the job.
//
// Pattern mirrors autoOptimizationWorker.js: MongoDB polling (no Redis), atomic
// claim, exponential backoff, stale-processing recovery. Failures to SCREEN
// (scrape down, OpenAI down, thin content, no profile) fail OPEN — the job is
// kept and marked 'skipped'.
//
// secondJudge.status lifecycle:
//   pending    → queued by AddJob (extension jobs with a joblink)
//   processing → claimed by this worker
//   passed     → re-judged on real-site text, kept
//   failed     → LOCATION mismatch → FLAGGED for operator review, job stays put
//   reviewed   → flag resolved (operator keep/remove), or auto-removed as stale
//   skipped    → could not screen after retries (kept, fail-open)

import { JobModel } from '../../Schema_Models/JobModel.js';
import { recordAiUsage, AI_USAGE_SOURCES } from '../../Utils/aiUsage.js';
import { ProfileModel } from '../../Schema_Models/ProfileModel.js';
import { UserModel } from '../../Schema_Models/UserModel.js';
import {
  STALE_POSTING_DAYS,
  buildSecondJudgeSystemPrompt,
  buildSecondJudgeUserPrompt,
} from '../../Utils/secondJudgePrompt.js';

// ─── Configuration ───────────────────────────────────────────────────
const WORKER_ENABLED = process.env.SECOND_JUDGE_ENABLED !== 'false';
const POLL_INTERVAL_MS = parseInt(process.env.SECOND_JUDGE_POLL_INTERVAL_MS) || 10000;
const DELAY_BETWEEN_JOBS_MS = parseInt(process.env.SECOND_JUDGE_DELAY_BETWEEN_JOBS_MS) || 2000;
// How many jobs to screen IN PARALLEL. The scraper cluster has ~6 concurrent
// slots, so 6 keeps it saturated; each in-flight job is one scrape + (maybe) one
// OpenAI call, both I/O-bound. claimNextJob is atomic, so parallel claims (and
// multiple backend instances) never grab the same job.
const CONCURRENCY = Math.max(1, parseInt(process.env.SECOND_JUDGE_CONCURRENCY) || 6);
const MAX_ATTEMPTS = parseInt(process.env.SECOND_JUDGE_MAX_ATTEMPTS) || 5;
// Backoff after each failed attempt N (minutes). First three are quick (the
// scraper/OpenAI is usually back in seconds); attempts 4 and 5 wait HOURS so a
// posting behind a long outage / slow ATS still gets two more shots over the
// next ~15h before we give up and keep it (fail-open). Index = attempts-1.
//   attempt 1 → 1 min · 2 → 2 min · 3 → 5 h · 4 → 10 h · 5 → skip
const RETRY_DELAYS_MIN = [1, 2, 5 * 60, 10 * 60];
const THRESHOLD = Number.isFinite(Number(process.env.SECOND_JUDGE_THRESHOLD))
  ? Number(process.env.SECOND_JUDGE_THRESHOLD)
  : 50;
// Floor below the scraper's own full-text floor (100) so we never re-reject a
// page the scraper already returned ok — the scraper is the single thin-gate.
const MIN_JD_CHARS = parseInt(process.env.SECOND_JUDGE_MIN_JD_CHARS) || 80;
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// The two flag kinds the grader may return (see secondJudgePrompt.js). Only
// these are actionable; any other skipKind the model invents is ignored (keep).
const FRESHNESS_KIND = 'threshold';        // posting closed / expired / stale
const LOCATION_KIND = 'location-mismatch'; // outside US / Canada / India, on-site
const VALID_FLAGS = new Set([LOCATION_KIND, FRESHNESS_KIND]);

// Auto-remove ONLY the freshness failures, and do it immediately: a closed or
// expired posting cannot be applied to, so there is no operator decision to
// make. Location mismatches are never auto-removed — they stay flagged for the
// operator. Master switch for the removal half only (flagging always happens).
const AUTO_REMOVE_ENABLED = process.env.SECOND_JUDGE_AUTO_REMOVE_ENABLED !== 'false';
const AI_REMOVAL_STATUS = 'removed by AI'; // mirrors reconcileExclusionJobs.js → lands in Removed column
// STALE_POSTING_DAYS (3) is imported, not read from the environment: it is the
// deterministic half of the two-key freshness gate (freshnessEvidence), and the
// grader's worked examples are generated from the very same constant, so the
// prompt and this gate cannot disagree about what "expired" means. See
// Utils/secondJudgePrompt.js.
//
// Built once: identical on every request, so it stays prompt-cacheable.
const SYSTEM_PROMPT = buildSecondJudgeSystemPrompt();
// One-shot migration at boot: rows flagged 'failed' by the OLD grader (which was
// never told today's date, so it read fresh postings as "expired") carry no
// skipKind. Re-queue the freshness-looking ones for a clean re-screen instead of
// trusting — or blindly removing on — that old verdict.
const REQUEUE_LEGACY_FLAGS = process.env.SECOND_JUDGE_REQUEUE_LEGACY_FLAGS !== 'false';

// Scraper (Playwright text extractor). EXTRACT path matches the extension's
// exports.js SCRAPER_ENDPOINTS.EXTRACT_INFO ('/extract/infor=').
// Default points at the live cluster (77.237.239.34, 2 replicas behind nginx).
// It used to fall back to 34.100.143.80, which was decommissioned - second-stage
// screening silently failed wherever SCRAPER_BASE_URL was unset.
const SCRAPER_BASE_URL = (process.env.SCRAPER_BASE_URL || 'http://77.237.239.34:8092').replace(/\/+$/, '');
const SCRAPER_EXTRACT_PATH = process.env.SCRAPER_EXTRACT_PATH || '/extract/infor=';
// 70s (was 45s): must exceed the scraper's own nav timeout (JDFETCH_NAV_TIMEOUT_MS,
// now 35s) plus HTTP-tier + queue wait, else we abort a scrape that was about to
// succeed and wrongly log "couldn't open the posting".
const SCRAPER_TIMEOUT_MS = parseInt(process.env.SECOND_JUDGE_SCRAPER_TIMEOUT_MS) || 70000;

// OpenAI judge (reuses the same key as /extension/openai-judge).
// SECOND_JUDGE_LLM_URL lets the operator's own machine run this worker against a
// local OpenAI-compatible endpoint (e.g. Claude through a proxy) instead of
// OpenAI. Unset = unchanged behaviour (OpenAI, billed to OPENAI_API_KEY).
const CUSTOM_LLM_URL = process.env.SECOND_JUDGE_LLM_URL || '';
const OPENAI_URL = CUSTOM_LLM_URL || 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = process.env.OPENAI_JUDGE_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_TIMEOUT_MS = parseInt(process.env.SECOND_JUDGE_OPENAI_TIMEOUT_MS) || 30000;

let inFlight = 0;   // jobs currently being screened in parallel (0..CONCURRENCY)
let workerRunning = false;
let pollTimer = null;
let lastRecoverMs = 0;
const RECOVER_EVERY_MS = 60 * 1000; // periodic stale-recovery cadence

function nowIST() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// fetchWithTimeout — fetch that ABORTS on timeout so a slow scraper/OpenAI
// request doesn't leak a socket (the old withTimeout(fetch(...)) left the
// underlying request running). On timeout the AbortError surfaces to the
// caller, which retries with backoff / fails open.
async function fetchWithTimeout(url, options = {}, ms = 30000, label = 'request') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`${label} timed out after ${ms}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// isScrapeableEmployerUrl — only real employer/ATS pages can be scraped for
// full text. jobright.ai / indeed / linkedin need auth or block bots, so
// scraping them yields a login/app shell — judging that text would WRONGLY
// remove a good job. For those we skip the second judge (fail-open, keep).
function isScrapeableEmployerUrl(url) {
  if (!url || typeof url !== 'string') return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (/(^|\.)jobright\.ai$/i.test(host)) return false;
  if (/(^|\.)indeed\./i.test(host)) return false;
  if (/(^|\.)linkedin\.com$/i.test(host)) return false;
  return true;
}

// escapeRegExp — for a safe case-insensitive exact-match email lookup.
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Fast deterministic pre-screen (cost saver, #2) ──────────────────
// The second judge checks ONLY location (allow US/Canada/India, remote,
// missing) + freshness (open vs closed/expired) — both strongly
// regex-detectable. When the scraped text carries NEITHER a foreign-location
// signal NOR a closed-posting signal, the LLM verdict is a certain KEEP, so we
// skip the OpenAI call. Fail-open in BOTH directions, so the regex NEVER
// removes anything on its own — it only decides whether the LLM must run:
//   • a foreign job the regex misses (no country named) → kept, exactly as the
//     LLM would (its rule: missing/unclear location → KEEP);
//   • a false foreign hit (e.g. "London, Ontario") → escalates to the LLM,
//     which confirms KEEP.
const FOREIGN_LOCATION_RX = /\b(united kingdom|u\.k\.|uk|england|scotland|wales|ireland|dublin|london|manchester|edinburgh|germany|deutschland|berlin|munich|münchen|frankfurt|france|paris|spain|madrid|barcelona|portugal|lisbon|italy|rome|milan|netherlands|amsterdam|belgium|brussels|switzerland|zurich|geneva|sweden|stockholm|norway|oslo|denmark|copenhagen|finland|helsinki|poland|warsaw|krakow|austria|vienna|czech|prague|hungary|budapest|romania|bucharest|greece|athens|singapore|hong kong|japan|tokyo|osaka|china|shanghai|beijing|shenzhen|taiwan|taipei|south korea|seoul|australia|sydney|melbourne|brisbane|perth|new zealand|auckland|wellington|united arab emirates|u\.a\.e\.|uae|dubai|abu dhabi|qatar|doha|bahrain|kuwait|oman|saudi arabia|riyadh|jeddah|israel|tel aviv|turkey|istanbul|brazil|brasil|são paulo|sao paulo|rio de janeiro|argentina|buenos aires|chile|santiago|colombia|bogota|mexico|méxico|mexico city|philippines|manila|cebu|malaysia|kuala lumpur|indonesia|jakarta|vietnam|hanoi|ho chi minh|thailand|bangkok|pakistan|karachi|lahore|bangladesh|dhaka|sri lanka|colombo|south africa|johannesburg|cape town|nigeria|lagos|abuja|kenya|nairobi|egypt|cairo|morocco|casablanca|ghana|accra)\b/i;
// A closure statement must be about the POSITION. "We are no longer accepting
// paper resumes / applications by post" is about the SUBMISSION CHANNEL and the
// job is open — the old pattern matched it via a bare "no longer accepting", and
// the grader made the same mistake, so both keys agreed and an open job was
// auto-removed. Every "accepting" branch now names what is not being accepted,
// and a trailing channel word ("by post", "via email") vetoes the match.
const NOT_A_CHANNEL = '(?!\\s+(?:by|via|through|in)\\b)';
const CLOSED_POSTING_RX = new RegExp(
  '\\b(?:' +
    [
      `no longer accepting (?:applications?|candidates?|applicants?)${NOT_A_CHANNEL}`,
      `we (?:are|'re) no longer (?:accepting (?:applications?|candidates?|applicants?)${NOT_A_CHANNEL}|hiring)`,
      'not accepting (?:new )?(?:applications?|candidates?|applicants?)',
      'applications? (?:are|is) no longer being accepted',
      'this (?:job|position|posting|role|requisition|listing|opening) (?:has been |is )?(?:closed|filled|expired|no longer (?:available|open|active))',
      'position (?:has been )?filled',
      "applications? (?:are |is )?(?:now )?closed",
      'posting (?:is )?closed',
      '(?:job|posting) (?:has )?expired',
      'requisition closed',
      'position (?:is )?no longer available',
      'this opportunity (?:has|is) (?:closed|no longer)',
    ].join('|') +
    ')\\b',
  'i'
);

// ─── Posted-date parsing (deterministic freshness evidence) ──────────
// Only read a date that FOLLOWS an explicit "posted"/"published" label, so the
// many other dates in a JD (start date, founding year, benefits-enrolment
// window) can never be mistaken for the posting date.
const MONTH_NAMES = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// The date window is captured in a LOOKAHEAD so it is not consumed: a later
// "Posted <date>" that sits within 40 chars of an earlier label must still be
// found (a re-posted job prints both, and the newer one has to win).
const POSTED_LABEL_RX = /(?:date\s+posted|posted\s+on|posted\s+date|first\s+posted|published\s+on|posted|published)\s*[:\-–—]?\s*(?=([^\n\r]{0,40}))/gi;
const DAY_MONTH_YEAR_RX = new RegExp(`^(\\d{1,2})\\s+(${MONTH_NAMES})\\.?,?\\s+(\\d{4})`, 'i');
const MONTH_DAY_YEAR_RX = new RegExp(`^(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, 'i');

// ageFromSnippet — days between `now` and the date at the START of `snippet`.
// Returns null when the snippet holds no date we can read. A date in the FUTURE
// yields 0 (never "stale"): that is a site bug or a timezone artifact, and it is
// exactly the case the old grader misread as "expired".
function ageFromSnippet(snippet, now) {
  const s = String(snippet || '').trim();
  if (!s) return null;

  let m = s.match(/^(\d{1,4})\s*\+?\s*days?\s+ago/i);
  if (m) return Number(m[1]);
  // 30 and 365 here are UNIT CONVERSIONS (days per month / per year), not a
  // freshness threshold — that is STALE_POSTING_DAYS (3) and nothing else. Any
  // "N months ago" therefore lands at >= 30 days, i.e. comfortably expired.
  m = s.match(/^(\d{1,3})\s*\+?\s*months?\s+ago/i);
  if (m) return Number(m[1]) * 30;
  m = s.match(/^(\d{1,2})\s*\+?\s*years?\s+ago/i);
  if (m) return Number(m[1]) * 365;
  if (/^(today|yesterday|just\s+posted|\d{1,3}\s*\+?\s*(?:hours?|minutes?|mins?)\s+ago)/i.test(s)) return 0;

  let utc = null;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  } else if ((m = s.match(DAY_MONTH_YEAR_RX))) {
    utc = Date.UTC(Number(m[3]), MONTH_INDEX[m[2].slice(0, 3).toLowerCase()], Number(m[1]));
  } else if ((m = s.match(MONTH_DAY_YEAR_RX))) {
    utc = Date.UTC(Number(m[3]), MONTH_INDEX[m[1].slice(0, 3).toLowerCase()], Number(m[2]));
  } else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) {
    utc = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])); // US M/D/YYYY
  }
  if (utc == null || Number.isNaN(utc)) return null;
  const age = Math.floor((now - utc) / 86400000);
  return age < 0 ? 0 : age;
}

// parsePostedAgeDays — age in days of the posting, or null if the page states
// none. When several posted-dates appear we take the MOST RECENT (smallest age):
// a page must not be condemned by the oldest date printed anywhere on it.
// Exported for tests.
export function parsePostedAgeDays(text, now = Date.now()) {
  const t = String(text || '');
  POSTED_LABEL_RX.lastIndex = 0; // the regex is /g and module-scoped — reset per call
  let m;
  let best = null;
  while ((m = POSTED_LABEL_RX.exec(t)) !== null) {
    const age = ageFromSnippet(m[1], now);
    if (age == null) continue;
    if (best == null || age < best) best = age;
  }
  return best;
}

// ─── Bot walls / error pages ─────────────────────────────────────────
// Some ATS (Akamai-fronted Manulife, Cloudflare, Incapsula) serve a short
// "Access Denied" page to our reader. The scraper returns it as ok:true /
// confidence:'full-text', and it clears MIN_JD_CHARS, so without this check the
// judge grades the block page, finds no foreign-location and no closed wording,
// and reports the job as "second-stage screening passed" — a lie. Treat it as
// UNSCREENABLE instead: keep the job, mark 'skipped', say why.
const BOT_WALL_RX = /(access denied|you don'?t have permission to access|request unsuccessful|incapsula|attention required|checking your browser|just a moment|enable javascript and cookies|verify you are (?:a )?human|unusual traffic|are you a robot|recaptcha|captcha|error 403|403 forbidden|request blocked|access to this page has been denied|ddos protection|cf-browser-verification)/i;
// A real JD is long. Only a SHORT page that also matches the phrases above is a
// block page — otherwise a security-engineer JD mentioning "access denied" logs
// would be thrown away.
const BOT_WALL_MAX_CHARS = 1500;

// Exported for tests.
export function isBlockedPage(text, title = '') {
  const t = String(text || '');
  if (BOT_WALL_RX.test(String(title || ''))) return true;
  return t.length < BOT_WALL_MAX_CHARS && BOT_WALL_RX.test(t);
}

// ─── "Recommended jobs" rails ────────────────────────────────────────
// Most ATS append a "Similar jobs" / "Recommended for you" rail to the posting.
// Its cards carry OTHER jobs' locations and posted dates, which would poison
// both checks — a London card in the rail reads as a location mismatch, and a
// fresh card in the rail can mask a stale posting. Cut the page at the rail so
// every check (regex and LLM alike) only ever sees the role's own text.
const RECOMMENDED_HEADING_RX = new RegExp(
  '^(?:' +
    [
      '(?:recommended|similar|related|suggested|additional|other|more)\\s+(?:jobs?|roles?|positions?|openings?|opportunities)',
      'recommended\\s+for\\s+you',
      '(?:jobs?|roles?|opportunities)\\s+for\\s+you',
      '(?:jobs?|roles?)\\s+you\\s+may\\s+(?:like|be\\s+interested\\s+in)',
      'you\\s+may\\s+also\\s+(?:like|be\\s+interested)',
      '(?:people|others?)\\s+also\\s+viewed',
      'recently\\s+viewed(?:\\s+jobs?)?',
      '(?:explore|browse|view|see)\\s+(?:all\\s+|more\\s+)?(?:jobs?|opportunities|openings?)',
      '(?:other|more)\\s+jobs\\s+at\\b',
    ].join('|') +
    ')\\b',
  'i'
);
// Phrases strong enough to cut on even when the page has no line breaks around
// them. Deliberately narrower than the heading list — "more jobs" or "see jobs"
// can legitimately appear in prose, "people also viewed" cannot.
const RECOMMENDED_INLINE_RX = /(recommended\s+jobs?|similar\s+jobs?|related\s+jobs?|suggested\s+jobs?|recommended\s+for\s+you|people\s+also\s+viewed|jobs?\s+you\s+may\s+like)/i;
// Never cut inside the first N chars: the role's own title/location/date live at
// the top, and a nav link ("Explore jobs") up there must not truncate the page.
const MIN_BODY_CHARS_BEFORE_CUT = 400;
const MAX_HEADING_CHARS = 60; // a heading is a short standalone line

// Exported for tests.
export function stripRecommendedSections(text) {
  const full = String(text || '');
  if (full.length <= MIN_BODY_CHARS_BEFORE_CUT) return full;

  // 1) Heading on its own short line — the common case.
  const lines = full.split('\n');
  let used = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (used >= MIN_BODY_CHARS_BEFORE_CUT && line.length <= MAX_HEADING_CHARS && RECOMMENDED_HEADING_RX.test(line)) {
      return lines.slice(0, i).join('\n').trim();
    }
    used += lines[i].length + 1;
  }

  // 2) Fallback for pages the scraper flattened into one long line.
  const m = RECOMMENDED_INLINE_RX.exec(full);
  if (m && m.index >= MIN_BODY_CHARS_BEFORE_CUT) return full.slice(0, m.index).trim();
  return full;
}

// freshnessEvidence — the DETERMINISTIC key for auto-removal. The grader's
// 'threshold' verdict alone never removes a job; this must agree.
// Exported for tests.
export function freshnessEvidence(text) {
  if (CLOSED_POSTING_RX.test(text)) {
    return { stale: true, why: 'the posting states it is closed / filled / no longer accepting applications' };
  }
  const age = parsePostedAgeDays(text);
  if (age != null && age > STALE_POSTING_DAYS) {
    return { stale: true, why: `the posting is dated ${age} days ago, older than the ${STALE_POSTING_DAYS}-day freshness limit` };
  }
  return { stale: false, why: '', age };
}

// Exported for tests.
export function fastScreen(text) {
  const t = String(text || '');
  if (CLOSED_POSTING_RX.test(t)) return { needsLLM: true, hint: 'closed-signal' };
  // A stale posted-date is a freshness signal in its own right. Without this the
  // LLM never sees an old-but-otherwise-normal US posting, so it could never be
  // flagged as expired.
  const age = parsePostedAgeDays(t);
  if (age != null && age > STALE_POSTING_DAYS) return { needsLLM: true, hint: `stale-posted-date(${age}d)` };
  if (FOREIGN_LOCATION_RX.test(t)) return { needsLLM: true, hint: 'foreign-location-signal' };
  return { needsLLM: false, hint: '' };
}

// friendlySkipReason — turn a raw technical error into a plain-English line the
// operator sees on the card / modal. The exact error is still stored separately
// in secondJudge.error for debugging; this is only the human-readable summary.
function friendlySkipReason(raw) {
  const m = String(raw || '').toLowerCase();
  if (m.includes('bot wall') || m.includes('blocked by the job site'))
    return 'The job site blocked our reader (bot protection), so the posting couldn’t be checked. Job kept.';
  if (m.includes('not a scrapeable') || m.includes('bad_input'))
    return 'The saved link isn’t a job-site page we can open, so the second-stage check was skipped. Job kept.';
  if (m.includes('no client profile') || m.includes('profile'))
    return 'No client profile was on file to check against, so the second-stage check was skipped. Job kept.';
  if (m.includes('timed out') || m.includes('scraper request failed') || m.includes('scraper http') ||
      m.includes('econnrefused') || m.includes('fetch failed') || m.includes('network') || m.includes('nav_timeout'))
    return 'Couldn’t open the job posting — the job site was slow or unavailable after several tries. Job kept.';
  if (m.includes('thin') || m.includes('empty') || m.includes('page text') || m.includes('content'))
    return 'The job page had almost no readable text (likely a login or bot wall), so it couldn’t be checked. Job kept.';
  if (m.includes('openai') || m.includes('grader') || m.includes('json'))
    return 'The AI screener was temporarily unavailable, so the second-stage check was skipped. Job kept.';
  return 'The second-stage check couldn’t finish after several tries. Job kept.';
}

// ─── Stale Job Recovery ──────────────────────────────────────────────
async function recoverStaleJobs() {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const result = await JobModel.updateMany(
    {
      'secondJudge.status': 'processing',
      'secondJudge.startedAt': { $lt: cutoff },
    },
    {
      $set: {
        'secondJudge.status': 'pending',
        'secondJudge.error': 'Recovered from stale processing state (worker restart)',
      },
    }
  );
  if (result.modifiedCount > 0) {
    console.log(`[SecondJudge] Recovered ${result.modifiedCount} stale processing job(s)`);
  }
}

// ─── One-shot: re-screen legacy freshness flags ──────────────────────
// Rows flagged 'failed' before this version carry no skipKind, so we cannot tell
// a location flag from a freshness flag — and the freshness verdicts among them
// came from a grader that was never told today's date (it read "Posted 07 July
// 2026" as "closed/expired"). Rather than trust those verdicts (or remove on
// them), put the freshness-looking ones back in the queue: the fixed grader plus
// the deterministic freshnessEvidence() gate then decides them correctly. Rows
// that are genuinely closed get removed; false positives quietly pass and stay.
// Location flags are left untouched. Converges: a re-screen always writes a
// skipKind, so a row can never be picked up twice.
const LEGACY_FRESHNESS_REASON_RX = /\b(clos(?:ed|ing)|expired?|filled|no longer (?:accepting|available|open)|not accepting|stale|(?:posting|listing) is dated)\b/i;

// Exported for tests. Must match freshness reasons and never a location reason.
export function isLegacyFreshnessReason(reason) {
  return LEGACY_FRESHNESS_REASON_RX.test(String(reason || ''));
}

async function requeueLegacyFreshnessFlags() {
  if (!REQUEUE_LEGACY_FLAGS) return;
  const candidates = await JobModel.find({
    'secondJudge.status': 'failed',
    'secondJudge.skipKind': null, // matches missing OR null — i.e. pre-upgrade rows only
    currentStatus: { $not: /^(deleted|removed)/i },
  })
    .select('_id secondJudge.reason')
    .limit(1000)
    .lean();

  const ids = candidates.filter((j) => isLegacyFreshnessReason(j.secondJudge?.reason)).map((j) => j._id);
  if (!ids.length) return;

  await JobModel.updateMany(
    { _id: { $in: ids } },
    {
      $set: {
        'secondJudge.status': 'pending',
        'secondJudge.attempts': 0,
        'secondJudge.retryAfter': null,
        'secondJudge.error': null,
      },
    }
  );
  console.log(`[SecondJudge] Re-queued ${ids.length} legacy freshness flag(s) for a clean re-screen`);
}

// ─── One-shot AUDIT (read-only): location flags the old sweep removed ─────
// An earlier version of this worker moved EVERY failed flag to the Removed column
// after a 24h grace, location mismatches included. That policy is gone — a
// location flag is now a judgement only an operator may act on — but any job the
// old sweep caught is still sitting in Removed, wrongly, and inflates the
// "AI removed" column on the client-job-analysis page.
//
// This ONLY COUNTS them. It writes nothing. Restoring a job means guessing its
// pre-removal status out of the timeline array, which is not something to do
// unattended; read the log, then decide.
//
// Signature of an old-sweep removal:
//   removedBy 'AI'  (so: not an operator delete)
//   secondJudge.reason present and secondJudge.status 'reviewed'
//                   (so: the second judge decided it, not the exclusion list —
//                    exclusion removals carry no secondJudge at all)
//   secondJudge.skipKind absent   (so: written before skipKind existed)
//   reason is NOT freshness-worded (so: it was a LOCATION mismatch)
const AUDIT_LEGACY_REMOVALS = process.env.SECOND_JUDGE_AUDIT_LEGACY_REMOVALS !== 'false';

async function auditLegacyLocationRemovals() {
  if (!AUDIT_LEGACY_REMOVALS) return;
  const rows = await JobModel.find({
    removedBy: 'AI',
    currentStatus: { $regex: /^(removed|deleted)/i },
    'secondJudge.status': 'reviewed',
    'secondJudge.skipKind': null, // matches missing OR null — pre-upgrade rows only
    'secondJudge.reason': { $exists: true, $nin: [null, ''] },
  })
    .select('_id userID secondJudge.reason')
    .limit(5000)
    .lean();

  // Two distinct populations, both wrong, for different reasons:
  //   location  — removed under a policy we have since reversed.
  //   freshness — removed by the grader that was never told today's date, so a
  //               3-day-old posting could be called "closed/expired". Some of
  //               these were genuinely expired; the reason text cannot tell us
  //               which, only a re-scrape can.
  const location = rows.filter((j) => !isLegacyFreshnessReason(j.secondJudge?.reason));
  const freshness = rows.filter((j) => isLegacyFreshnessReason(j.secondJudge?.reason));

  if (!rows.length) {
    console.log('[SecondJudge] Legacy audit: no AI removals predate skipKind — nothing to review');
    return;
  }

  const report = (label, list, note) => {
    if (!list.length) return;
    const perUser = new Map();
    for (const j of list) {
      if (!j.userID) continue;
      perUser.set(j.userID, (perUser.get(j.userID) || 0) + 1);
    }
    const top = [...perUser.entries()].sort((a, b) => b[1] - a[1]);
    console.warn(`[SecondJudge] Legacy audit: ${list.length} ${label} — ${note}`);
    for (const [email, n] of top.slice(0, 20)) console.warn(`[SecondJudge]     ${email}: ${n}`);
    if (top.length > 20) console.warn(`[SecondJudge]     …and ${top.length - 20} more client(s)`);
    console.warn(`[SecondJudge]     e.g. "${String(list[0].secondJudge?.reason || '').slice(0, 120)}"`);
  };

  console.warn('[SecondJudge] Legacy audit — READ ONLY, NOTHING WAS MODIFIED.');
  report(
    'job(s) removed for a LOCATION mismatch',
    location,
    'the old 24h sweep removed these; current policy never removes a location flag'
  );
  report(
    'job(s) removed as EXPIRED before the grader knew today\'s date',
    freshness,
    'some were genuinely closed; only a re-scrape can separate them'
  );
  console.warn('[SecondJudge]   Set SECOND_JUDGE_AUDIT_LEGACY_REMOVALS=false to silence this.');
}

// ─── Claim Next Pending Job (Atomic) ─────────────────────────────────
async function claimNextJob() {
  return JobModel.findOneAndUpdate(
    {
      'secondJudge.status': 'pending',
      'secondJudge.attempts': { $lt: MAX_ATTEMPTS },
      joblink: { $exists: true, $nin: [null, ''] },
      $or: [
        { 'secondJudge.retryAfter': { $exists: false } },
        { 'secondJudge.retryAfter': null },
        { 'secondJudge.retryAfter': { $lte: new Date() } },
      ],
    },
    {
      $set: { 'secondJudge.status': 'processing', 'secondJudge.startedAt': new Date() },
      $inc: { 'secondJudge.attempts': 1 },
    },
    { new: true, sort: { _id: 1 } }
  ).lean();
}

// ─── Mark technical failure (retry w/ backoff, fail-open after MAX) ──
// Used for screening errors (scrape down, OpenAI down, thin content, no
// profile). NEVER removes the job — after MAX attempts we 'skip' and keep it.
async function markScreenFailure(jobId, errorMessage, attempts) {
  const update = {
    'secondJudge.error': String(errorMessage).slice(0, 500),
    'secondJudge.lastFailedAt': new Date(),
  };
  if (attempts >= MAX_ATTEMPTS) {
    update['secondJudge.status'] = 'skipped';
    update['secondJudge.reason'] = friendlySkipReason(errorMessage);
    update['secondJudge.completedAt'] = new Date();
    console.error(`[SecondJudge] Job ${jobId} could not be screened after ${attempts} attempts (kept): ${errorMessage}`);
  } else {
    // Delay after THIS attempt: 1 min, 2 min, 5 h, 10 h. Falls back to 10 h if
    // MAX_ATTEMPTS is raised past the table.
    const backoffMinutes = RETRY_DELAYS_MIN[attempts - 1] ?? 10 * 60;
    update['secondJudge.status'] = 'pending';
    update['secondJudge.retryAfter'] = new Date(Date.now() + backoffMinutes * 60 * 1000);
    const human = backoffMinutes >= 60 ? `${backoffMinutes / 60} h` : `${backoffMinutes} min`;
    console.log(`[SecondJudge] Job ${jobId} screen retry in ${human} (attempt ${attempts}/${MAX_ATTEMPTS})`);
  }
  await JobModel.findByIdAndUpdate(jobId, { $set: update });
}

// ─── Scrape the real employer-site text ──────────────────────────────
async function scrapeJobText(joblink) {
  const url = `${SCRAPER_BASE_URL}${SCRAPER_EXTRACT_PATH}${encodeURIComponent(joblink)}`;
  let resp;
  try {
    resp = await fetchWithTimeout(url, { method: 'GET' }, SCRAPER_TIMEOUT_MS, 'scraper /extract');
  } catch (e) {
    const err = new Error(`Scraper request failed: ${e.message}`);
    err._stage = 'Scraper Fetch';
    throw err;
  }
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    const err = new Error(`Scraper HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    err._stage = 'Scraper Fetch';
    throw err;
  }
  const data = await resp.json().catch(() => ({}));
  // /extract/infor= returns the FULL visible page text in pageText (and mirrors
  // it into mainJd/jobDescription/description for back-compat).
  const text = String(
    data?.pageText || data?.mainJd || data?.jobDescription || data?.description || ''
  ).trim();
  // title is the block-page tell ("Access Denied", "Just a moment…") even when
  // the body is too long for the length guard.
  return { text, finalUrl: data?.finalUrl || joblink, title: String(data?.title || '') };
}

// ─── Call the OpenAI grader on the real-site text ────────────────────
async function judgeRealSite({ profile, job, scrapedText }) {
  const apiKey = process.env.OPENAI_API_KEY || (CUSTOM_LLM_URL ? 'local' : '');
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY not configured on backend');
    err._stage = 'OpenAI Judge';
    throw err;
  }
  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildSecondJudgeUserPrompt({
          profile,
          job,
          scrapedText,
          threshold: THRESHOLD,
          // The model cannot know the current date — anchor the freshness check.
          todayISO: new Date().toISOString().slice(0, 10),
          staleAfterDays: STALE_POSTING_DAYS,
        }),
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  };
  let resp;
  try {
    resp = await fetchWithTimeout(
      OPENAI_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      },
      OPENAI_TIMEOUT_MS,
      'OpenAI chat.completions'
    );
  } catch (e) {
    const err = new Error(`OpenAI request failed: ${e.message}`);
    err._stage = 'OpenAI Judge';
    throw err;
  }
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    const err = new Error(`OpenAI HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    err._stage = 'OpenAI Judge';
    throw err;
  }
  const data = await resp.json();
  // Real token usage → the milestone cost report. Fire-and-forget: a cost
  // datapoint must never be able to fail a job screen.
  // A custom endpoint is not billed by OpenAI: keep it out of the OpenAI cost report.
  if (!CUSTOM_LLM_URL) {
    recordAiUsage({
      source: AI_USAGE_SOURCES.SECOND_JUDGE,
      model: data?.model || OPENAI_MODEL,
      usage: data?.usage,
    });
  }
  const content = data?.choices?.[0]?.message?.content || '{}';
  let parsed = null;
  try { parsed = JSON.parse(content); } catch { /* ignore */ }
  if (!parsed || typeof parsed.pick !== 'boolean') {
    const err = new Error(`Bad grader JSON: ${content.slice(0, 200)}`);
    err._stage = 'OpenAI Judge';
    throw err;
  }
  return {
    pick: parsed.pick === true,
    score: Number.isFinite(Number(parsed.score)) ? Number(parsed.score) : 0,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    skipKind: typeof parsed.skipKind === 'string' ? parsed.skipKind : '',
  };
}

// ─── Flag a mismatch (job stays put, operator decides) ───────────────
// Records the FAILED verdict and nothing else: currentStatus / removal fields /
// timeline are untouched, so the job keeps its column and simply shows up in the
// CRM "AI second-stage flags" queue with its reason. This is the ONLY outcome for
// a location mismatch — that call is a judgement the operator owns, never the AI.
// (A stale posting also lands here when auto-removal is switched off.)
async function flagForMismatch(job, verdict, scrapedChars, kind = LOCATION_KIND) {
  const reason = (verdict.reason || 'Did not match client profile on the full posting').trim();
  await JobModel.findByIdAndUpdate(job._id, {
    $set: {
      'secondJudge.status': 'failed',
      'secondJudge.skipKind': kind,
      'secondJudge.score': verdict.score,
      'secondJudge.reason': reason,
      'secondJudge.scrapedChars': scrapedChars,
      'secondJudge.completedAt': new Date(),
      'secondJudge.error': null,
    },
  });
}

// ─── Remove a CLOSED / EXPIRED posting immediately ───────────────────
// Mirrors reconcileExclusionJobs.js' AI-removal fields so the job lands in the
// Removed column exactly like an exclusion removal. Reached only when BOTH keys
// agree (grader skipKind='threshold' AND freshnessEvidence().stale).
//
// The filter re-checks currentStatus so a job an operator removed while we were
// screening is not re-stamped, and its client's removedJobsCount not double-
// counted. status:'reviewed' (not 'failed') keeps it out of the flag queue.
async function removeForStalePosting(job, verdict, scrapedChars, why) {
  const now = nowIST();
  const reason = (verdict.reason || '').trim() || `Posting is no longer open — ${why}.`;
  const secondJudge = {
    'secondJudge.status': 'reviewed',
    'secondJudge.skipKind': FRESHNESS_KIND,
    'secondJudge.score': verdict.score,
    'secondJudge.reason': reason,
    'secondJudge.scrapedChars': scrapedChars,
    'secondJudge.completedAt': new Date(),
    'secondJudge.error': null,
  };

  const moved = await JobModel.findOneAndUpdate(
    { _id: job._id, currentStatus: { $not: /^(deleted|removed)/i } },
    {
      $set: {
        currentStatus: AI_REMOVAL_STATUS,
        updatedAt: now,
        removalReason: reason,
        removalDate: now,
        removedBy: 'AI',
        ...secondJudge,
      },
      $push: { timeline: AI_REMOVAL_STATUS },
    },
    { new: true }
  ).lean();

  if (!moved) {
    // Already removed by an operator / another pass — just record the verdict.
    await JobModel.findByIdAndUpdate(job._id, { $set: secondJudge });
    return false;
  }
  if (job.userID) {
    await UserModel.findOneAndUpdate({ email: job.userID }, { $inc: { removedJobsCount: 1 } }).catch((e) =>
      console.warn(`[SecondJudge] removedJobsCount inc failed for ${job.userID}:`, e.message)
    );
  }
  return true;
}

// ─── Keep a job that passed the second judge ─────────────────────────
async function keepForPass(job, verdict, scrapedChars) {
  await JobModel.findByIdAndUpdate(job._id, {
    $set: {
      'secondJudge.status': 'passed',
      'secondJudge.skipKind': '',
      'secondJudge.score': verdict.score,
      'secondJudge.reason': (verdict.reason || '').trim(),
      'secondJudge.scrapedChars': scrapedChars,
      'secondJudge.completedAt': new Date(),
      'secondJudge.error': null,
    },
  });
}

// ─── Process a Single Job ────────────────────────────────────────────
async function processJob(job) {
  const tag = `[SecondJudge] [${job.userID}] [${job._id}]`;
  console.log(`${tag} Screening "${job.jobTitle}" at ${job.companyName} → ${job.joblink}`);

  // Step 0: only real employer/ATS URLs can be scraped for full text. If the
  // push left a jobright/indeed/linkedin link (employer URL never resolved),
  // skip — scraping it would yield a login wall and wrongly fail the job.
  if (!isScrapeableEmployerUrl(job.joblink)) {
    await JobModel.findByIdAndUpdate(job._id, {
      $set: {
        'secondJudge.status': 'skipped',
        'secondJudge.reason': friendlySkipReason('not a scrapeable employer URL'),
        'secondJudge.error': 'joblink is not a scrapeable employer URL — kept',
        'secondJudge.completedAt': new Date(),
      },
    });
    console.warn(`${tag} Skipped: non-employer joblink (${job.joblink}) — kept`);
    return;
  }

  // Step 1: client profile (the grader ground-truth). No profile → can't judge.
  // Try exact match first, then case-insensitive (push lowercases the email but
  // some profiles may be stored with original case).
  let profile = await ProfileModel.findOne({ email: job.userID }).lean();
  if (!profile && job.userID) {
    profile = await ProfileModel.findOne({
      email: new RegExp(`^${escapeRegExp(job.userID)}$`, 'i'),
    }).lean();
  }
  if (!profile) {
    // Fail-open: keep the job, mark skipped (permanent — retrying won't help).
    await JobModel.findByIdAndUpdate(job._id, {
      $set: {
        'secondJudge.status': 'skipped',
        'secondJudge.reason': friendlySkipReason('No client profile found'),
        'secondJudge.error': 'No client profile found for second judge',
        'secondJudge.completedAt': new Date(),
      },
    });
    console.warn(`${tag} Skipped: no profile for ${job.userID} (kept)`);
    return;
  }

  // Step 2: scrape the real employer-site text.
  const { text: rawText, title } = await scrapeJobText(job.joblink);

  // Step 2a: a bot wall / error page is NOT the posting. The scraper hands it
  // back as a normal success (ok:true, 'full-text') and it is long enough to
  // clear MIN_JD_CHARS, so it must be caught by content, not by length. Skip
  // permanently (retrying the same URL from the same IP hits the same wall) and
  // keep the job — never let a block page be graded as if it were the JD.
  if (isBlockedPage(rawText, title)) {
    await JobModel.findByIdAndUpdate(job._id, {
      $set: {
        'secondJudge.status': 'skipped',
        'secondJudge.reason': friendlySkipReason('bot wall'),
        'secondJudge.error': `Blocked by the job site (${title || 'bot protection'}) — kept`,
        'secondJudge.scrapedChars': rawText.length,
        'secondJudge.completedAt': new Date(),
      },
    });
    console.warn(`${tag} Skipped: site blocked our reader (${title || 'bot wall'}, ${rawText.length} chars) — kept`);
    return;
  }

  // Step 2b: drop the "recommended / similar jobs" rail. Its cards carry other
  // postings' locations and dates; everything below judges the ROLE only.
  const text = stripRecommendedSections(rawText);
  if (!text || text.length < MIN_JD_CHARS) {
    const err = new Error(`Thin/empty scrape (${text ? text.length : 0} chars, need >= ${MIN_JD_CHARS})`);
    err._stage = 'Scraper Content';
    throw err; // retry/backoff; fail-open after MAX
  }

  // Step 2.5: fast deterministic screen (#2). If the scraped text shows no
  // foreign-location signal and no closed/expired signal, the LLM verdict is a
  // certain KEEP — skip the OpenAI call entirely. Only ambiguous pages (a
  // foreign-location or closed hint) pay for the LLM, which then confirms and
  // guards against regex false-positives (e.g. "London, Ontario" / boilerplate).
  const fast = fastScreen(text);
  if (!fast.needsLLM) {
    await keepForPass(
      job,
      { score: 85, reason: 'Kept — fast location/freshness check: no foreign-location or closed-posting signal in the posting.', skipKind: '' },
      text.length
    );
    console.log(`${tag} FAST-KEPT (no LLM call — no foreign/closed signal)`);
    return;
  }
  console.log(`${tag} fast-screen escalating to LLM (${fast.hint})`);

  // Step 3: re-judge on the real-site text.
  const verdict = await judgeRealSite({ profile, job, scrapedText: text });
  const pass = verdict.pick === true && verdict.score >= THRESHOLD;

  // Hard guard: this stage flags ONLY location/freshness. Ignore any stray
  // role/sponsorship/other flag the model emits (or an old prompt leaks) —
  // those are not this stage's job, so keep the job.
  if (pass || !VALID_FLAGS.has(verdict.skipKind)) {
    await keepForPass(job, verdict, text.length);
    console.log(`${tag} ${pass ? 'PASS' : `KEPT (ignored non-location flag: ${verdict.skipKind || 'none'})`} (score ${verdict.score})`);
    return;
  }

  // Step 4a: FRESHNESS → remove immediately, but only on two independent keys.
  // The grader said "expired"; the page must also SHOW it (explicit closed
  // wording, or a posted-date past the freshness limit). An LLM has no reliable
  // sense of "now", so its date verdict alone must never delete a live job.
  if (verdict.skipKind === FRESHNESS_KIND) {
    const evidence = freshnessEvidence(text);
    if (!evidence.stale) {
      await keepForPass(
        job,
        {
          ...verdict,
          // The grader's score graded a conclusion we just rejected, so it is
          // meaningless here — drop it rather than render "passed (score 20)".
          score: null,
          reason:
            'Kept — the AI called this posting expired, but the page carries no closed/expired notice and its posted date is within the freshness limit.',
        },
        text.length
      );
      console.log(`${tag} KEPT (freshness verdict vetoed — no closed signal, posted age ${evidence.age ?? 'unknown'}d)`);
      return;
    }
    if (!AUTO_REMOVE_ENABLED) {
      await flagForMismatch(job, verdict, text.length, FRESHNESS_KIND);
      console.log(`${tag} FLAGGED stale (auto-remove disabled) — ${evidence.why}`);
      return;
    }
    const removed = await removeForStalePosting(job, verdict, text.length, evidence.why);
    console.log(`${tag} ${removed ? `AUTO-REMOVED (stale posting) — ${evidence.why}` : 'stale, but already removed — verdict recorded'}`);
    return;
  }

  // Step 4b: LOCATION → flag only. The job stays; an operator decides.
  await flagForMismatch(job, verdict, text.length);
  console.log(`${tag} FLAGGED location-mismatch (score ${verdict.score}) — kept, operator review`);
}

// Run one claimed job to completion (screen → verdict), converting a thrown
// screening error into retry/backoff. NEVER rejects, so it always frees its slot.
async function runJob(job) {
  try {
    await processJob(job);
  } catch (err) {
    const attempts = job.secondJudge?.attempts || 1;
    await markScreenFailure(job._id, `${err._stage || 'Unknown'}: ${err.message}`, attempts)
      .catch((e) => console.error('[SecondJudge] markScreenFailure error:', e.message));
  }
}

// ─── Polling Loop (bounded concurrency) ──────────────────────────────
// One self-scheduling timer chain (no overlapping invocations, so the in-flight
// count can't be raced past CONCURRENCY). Each tick tops the in-flight set up to
// CONCURRENCY by atomically claiming pending jobs; each claimed job runs
// concurrently and frees its slot on completion. A backlog of N now drains in
// ≈ (N / CONCURRENCY) × per-job time instead of one-at-a-time.
async function pollLoop() {
  if (!workerRunning) return;
  // Periodic stale-recovery (not just at boot): a job left in 'processing' by a
  // crash/restart is invisible to claimNextJob (which only picks 'pending').
  // Fire-and-forget so it never delays claiming; the updateMany is indexed.
  if (Date.now() - lastRecoverMs > RECOVER_EVERY_MS) {
    lastRecoverMs = Date.now();
    recoverStaleJobs().catch((e) => console.warn('[SecondJudge] recover error:', e.message));
  }

  let claimedAny = false;
  try {
    // Fill every free slot. claimNextJob is atomic, so each iteration gets a
    // DISTINCT job; the launched runJob is NOT awaited (runs in background) and
    // decrements inFlight when it settles.
    while (inFlight < CONCURRENCY) {
      const job = await claimNextJob();
      if (!job) break; // queue empty, or everything left is backing off
      claimedAny = true;
      inFlight += 1;
      runJob(job).finally(() => { inFlight -= 1; });
    }
  } catch (err) {
    console.error('[SecondJudge] Poll loop error:', err.message);
  }

  // Poll fast while work is in flight (refill freed slots promptly); slow when idle.
  const nextDelay = (inFlight > 0 || claimedAny) ? DELAY_BETWEEN_JOBS_MS : POLL_INTERVAL_MS;
  pollTimer = setTimeout(pollLoop, nextDelay);
}

// ─── Public API ──────────────────────────────────────────────────────
export function startSecondJudgeWorker() {
  if (!WORKER_ENABLED) {
    console.log('[SecondJudge] Disabled (SECOND_JUDGE_ENABLED=false)');
    return;
  }
  if (workerRunning) {
    console.log('[SecondJudge] Already running');
    return;
  }
  workerRunning = true;
  console.log('[SecondJudge] Starting second-stage screening worker');
  console.log(`[SecondJudge] Config: poll=${POLL_INTERVAL_MS}ms, concurrency=${CONCURRENCY}, maxAttempts=${MAX_ATTEMPTS}, threshold=${THRESHOLD}, model=${OPENAI_MODEL}`);
  console.log(
    `[SecondJudge] Auto-remove: ${AUTO_REMOVE_ENABLED ? `on — CLOSED/EXPIRED postings only (>${STALE_POSTING_DAYS}d or explicit notice) → "${AI_REMOVAL_STATUS}"` : 'off'}; location mismatches are always flagged, never removed`
  );
  console.log(`[SecondJudge] Scraper: ${SCRAPER_BASE_URL}${SCRAPER_EXTRACT_PATH}<url>`);

  // Each boot step is best-effort: a failure is logged but must not stop the
  // worker from polling.
  recoverStaleJobs()
    .catch((err) => console.warn('[SecondJudge] stale recovery skipped:', err.message))
    .then(() => requeueLegacyFreshnessFlags())
    .catch((err) => console.warn('[SecondJudge] legacy flag re-queue skipped:', err.message))
    .then(() => auditLegacyLocationRemovals())
    .catch((err) => console.warn('[SecondJudge] legacy removal audit skipped:', err.message))
    .then(() => pollLoop())
    .catch((err) => {
      console.error('[SecondJudge] Failed to start:', err);
      workerRunning = false;
    });
}

export function stopSecondJudgeWorker() {
  workerRunning = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  console.log('[SecondJudge] Stopped');
}

export function getSecondJudgeStatus() {
  return {
    running: workerRunning,
    processing: inFlight > 0,
    inFlight,
    enabled: WORKER_ENABLED,
    config: {
      pollIntervalMs: POLL_INTERVAL_MS,
      concurrency: CONCURRENCY,
      maxAttempts: MAX_ATTEMPTS,
      threshold: THRESHOLD,
      model: OPENAI_MODEL,
      scraper: `${SCRAPER_BASE_URL}${SCRAPER_EXTRACT_PATH}`,
      autoRemove: AUTO_REMOVE_ENABLED ? 'stale-postings-only' : 'off',
      staleAfterDays: STALE_POSTING_DAYS,
    },
  };
}
