// mailRegexLearner — the self-improving regex layer.
//
// Closes the loop the team wants: when the AI verifier rejects a mail the
// keyword regexes flagged (a false positive), the AI is asked to WRITE a new
// exclusion pattern for that kind of mail. The pattern is validated, regression-
// tested against known-genuine milestone mail, stored in Mongo
// (MailClassifierRule), and applied to every future mail at the regex stage —
// so the same promo never costs an AI call or risks an alert again.
//
// Why this is safe to let an AI do:
//   • Learned rules only EXCLUDE. They run AFTER the positive keyword match
//     and can only downgrade a flagged mail. No AI-written pattern can ever
//     CREATE an alert.
//   • Every proposal must survive the validation gauntlet below (compiles,
//     bounded, no dangerous constructs, matches the offending mail, matches
//     NONE of the genuine fixtures nor recently-verified genuine mail).
//     A proposal that fails any check is dropped — the domain-suppression and
//     AI-verifier layers still protect the client either way.
//   • Full provenance is stored; one status flip disables a bad rule
//     (POST /gmail/mail-verify/rules/:id/disable).
//
// Everything is fail-soft: a Mongo or OpenAI failure never breaks the poll.

import { MailClassifierRule } from "../../Schema_Models/MailClassifierRule.js";
import { MailVerifierFeedback } from "../../Schema_Models/MailVerifierFeedback.js";
import { recordAiUsage, AI_USAGE_SOURCES } from "../../Utils/aiUsage.js";

const OPENAI_URL = process.env.MAIL_AI_API_URL || "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.MAIL_REGEX_MODEL || "gpt-4o-mini";
const TIMEOUT_MS = Number(process.env.MAIL_REGEX_TIMEOUT_MS) || 20000;

const MAX_ACTIVE_RULES = 300; // hard cap — beyond this, stop proposing and tell ops
const MIN_PATTERN_LEN = 8; // shorter than this is almost certainly over-broad
const MAX_PATTERN_LEN = 200;
const BODY_TEST_CHARS = 4000; // exclusions are tested against this much body
const CACHE_TTL_MS = 5 * 60 * 1000;

const TARGET_FIELDS = new Set(["subject", "from", "body"]);

// ── Canonical GENUINE milestone mails. A proposed exclusion that matches ANY
// of these is rejected outright — this is the automated regression suite that
// keeps AI-written patterns from eating real invites. Add cases here whenever
// a learned rule is found to have suppressed a real mail.
export const GENUINE_FIXTURES = [
  {
    subject: "Interview invitation - Backend Engineer at Acme",
    from: "jane.doe@acme.com",
    body: "Hi, we reviewed your application and would like to invite you to a 45-minute technical interview. Please pick a slot that works for you."
  },
  {
    subject: "Schedule your phone screen - Stripe",
    from: "recruiting@stripe.com",
    body: "Thanks for applying to Stripe. We'd like to schedule a 30 minute phone screen. Book a time that works for you via the link below."
  },
  {
    subject: "Reminder: Grant Street Group invites you to complete a Codility assessment",
    from: "no-reply@codility.com",
    body: "Grant Street Group invites you to complete a Codility assessment for the Software Engineer role. The assessment expires in 5 days."
  },
  {
    subject: "Take-home assignment - Frontend role at Nimbus",
    from: "hiring@nimbus.dev",
    body: "Following your interview, please complete the attached take-home assignment within 3 days. It should take about 4 hours."
  },
  {
    subject: "Your offer from Vertex Labs",
    from: "talent@vertexlabs.com",
    body: "We are pleased to extend a formal offer for the Senior Engineer position. Compensation details are attached; let us know your decision."
  },
  {
    // 2026-11-20: real iCIMS invite the regexes filed as a job-board alert.
    subject: "Interview invitation - Showroom Project Coordinator, B&Q Blackburn",
    from: "Jack Laycock <kingfisher2+email+1u66m-b131f7bf28@talent.icims.eu>",
    body: "Hello, thanks for your application to B&Q for the position of Showroom Project Coordinator. I'd like to invite you to an interview, which will take up to an hour."
  },
  {
    subject: "Interview confirmed: Thursday 2 PM ET",
    from: "scheduling@calendly.com",
    body: "Your interview with Hooli has been scheduled. A calendar invitation has been sent to your email."
  }
];

// ── Canonical GENUINE REJECTIONS. Kept separate from the milestone fixtures
// because a proposal is only regression-tested against the category it guards:
// an exclusion written to kill a marketing mail that looked like an interview
// has no business being measured against rejection wording, and vice versa.
// Add cases here whenever a learned rule is found to have eaten a real one.
export const GENUINE_REJECTION_FIXTURES = [
  {
    subject: "Your application to Acme",
    from: "no-reply@acme.com",
    body: "After careful consideration, we regret to inform you that we will not be moving forward with your application for the Backend Engineer role."
  },
  {
    subject: "Update on your application - Senior Engineer",
    from: "talent@nimbus.dev",
    body: "Thank you for taking the time to interview with us. Unfortunately, we have decided to move forward with other candidates whose experience more closely matches the role."
  },
  {
    subject: "Stripe - Software Engineer",
    from: "recruiting@stripe.com",
    body: "We appreciate your interest. The position has been filled, and you were not selected on this occasion. We will keep your resume on file."
  },
  {
    subject: "Thank you for your interest in Hooli",
    from: "careers@hooli.com",
    body: "After reviewing your application, we have decided not to proceed. We wish you the best of luck in your search."
  }
];

// ── Pattern safety validation (pure, exported for tests) ─────────────

// Dangerous or useless constructs an exclusion pattern may not contain:
// lookbehind (engine compat), backreferences (ReDoS risk), quantified groups
// like ")+/)*/){" (classic catastrophic-backtracking shape), and the
// match-anything shapes.
const FORBIDDEN = [/\(\?</, /\\[1-9]/, /\)[+*{]/, /^\^?\.\*\$?$/, /\.\*\.\*/];

/**
 * Validate a proposed exclusion pattern WITHOUT database access.
 * @returns {{ok:true, re:RegExp} | {ok:false, reason:string}}
 */
export function validatePatternSource(pattern) {
  const src = String(pattern || "").trim();
  if (src.length < MIN_PATTERN_LEN) return { ok: false, reason: `too short (<${MIN_PATTERN_LEN} chars)` };
  if (src.length > MAX_PATTERN_LEN) return { ok: false, reason: `too long (>${MAX_PATTERN_LEN} chars)` };
  for (const bad of FORBIDDEN) {
    if (bad.test(src)) return { ok: false, reason: `forbidden construct: ${bad}` };
  }
  let re;
  try {
    re = new RegExp(src, "i");
  } catch (e) {
    return { ok: false, reason: `does not compile: ${e.message}` };
  }
  return { ok: true, re };
}

// ── Senders a "from" exclusion may never cover ──
// Hiring systems, scheduling tools, assessment providers and the generic
// no-reply shapes all of them use send interviews, assessments and offers as
// well as noise. A sender-wide exclusion on any of them silences real mail:
// on 2026-11-21, 18 live rules (/noreply@.*/, /notifications@calendly\.com/,
// /no-reply@ashbyhq\.com/, /myworkday\.com/ ...) had hidden 92 invite-looking
// mails in two weeks. A "from" pattern that matches any of these is refused
// when proposed AND ignored when loaded, so the existing bad rules stop
// applying on deploy without anyone editing the database.
export const PROTECTED_SENDERS = [
  "noreply@example.com", "no-reply@example.com", "donotreply@example.com",
  "do-not-reply@example.com", "do_not_reply@example.com", "notifications@example.com",
  "recruiting@example.com", "careers@example.com", "talent@example.com", "jobs@example.com", "hr@example.com",
  "notifications@calendly.com", "no-reply@calendly.com", "no-reply@ashbyhq.com",
  "hr@myworkday.com", "acme@myworkday.com", "x@talent.icims.com", "x@talent.icims.eu",
  "no-reply@greenhouse.io", "no-reply@us.greenhouse-mail.io", "no-reply@hire.lever.co",
  "jobs@smartrecruiters.com", "system@successfactors.com", "noreply@successfactors.eu", "x@taleo.net",
  "noreply@hirevue.com", "noreply@mail.hirevue-app.eu", "no-reply@codility.com", "noreply@hackerrank.com",
  "noreply@codesignal.com", "noreply@testgorilla.com", "noreply@arcticshores.com", "noreply@cappassessments.com",
  "do-not-reply@criteriacorp.com", "noreply@mail.amazon.jobs", "noreply@google.com", "x@jobvite.com",
  "x@workablemail.com", "x@bamboohr.com", "x@teamtailor-mail.com", "x@recruitee.com", "x@pinpointhq.com",
  "interviews@example.com", "interview@example.com", "scheduling@example.com", "talentacquisition@example.com",
  "jobs+abc@adp.com", "noreply@adp.com", "no-reply@ats.rippling.com", "x@rippling.com", "x@paylocity.com",
  "x@ultipro.com", "x@ukg.com", "x@oraclecloud.com", "x@applytojob.com", "x@breezy.hr", "x@dayforcehcm.com",
  "x@avature.net", "x@eightfold.ai", "x@paradox.ai", "x@gem.com", "x@beamery.com", "x@personio.de",
  "x@phenompeople.com", "x@modernhire.com", "x@sparkhire.com", "x@willo.video", "x@micro1.ai"
];

/** True when a "from" exclusion would cover a hiring system or a generic no-reply sender. */
export function coversProtectedSender(re) {
  return PROTECTED_SENDERS.some((addr) => re.test(addr) || re.test(`"Recruiting Team" <${addr}>`));
}

function fieldText(mail, targetField) {
  if (targetField === "subject") return String(mail.subject || "");
  if (targetField === "from") return String(mail.from || "");
  return String(mail.bodyText || mail.body || "").slice(0, BODY_TEST_CHARS);
}

/**
 * Full acceptance check for a proposal (pure given the inputs).
 * @param {Object} a
 * @param {string} a.pattern
 * @param {string} a.targetField
 * @param {Object} a.offendingMail        - { subject, from, bodyText }
 * @param {Array}  [a.genuineExamples]    - extra known-genuine mails to protect
 * @param {Array}  [a.fixtures]            - the canonical set for this category;
 *                                           defaults to the milestone fixtures
 * @returns {{ok:true, re:RegExp} | {ok:false, reason:string}}
 */
export function acceptProposal({
  pattern,
  targetField,
  offendingMail,
  genuineExamples = [],
  fixtures = GENUINE_FIXTURES
}) {
  if (!TARGET_FIELDS.has(targetField)) return { ok: false, reason: `bad targetField: ${targetField}` };
  const v = validatePatternSource(pattern);
  if (!v.ok) return v;

  if (targetField === "from" && coversProtectedSender(v.re)) {
    return { ok: false, reason: "covers a hiring-system or generic no-reply sender" };
  }

  // Must actually catch the mail that triggered the learning.
  if (!v.re.test(fieldText(offendingMail, targetField))) {
    return { ok: false, reason: "does not match the offending mail" };
  }

  // Must not catch ANY genuine mail of this kind — fixtures first, then live examples.
  for (const g of [...fixtures, ...genuineExamples]) {
    if (v.re.test(fieldText(g, targetField))) {
      return { ok: false, reason: `matches genuine mail: "${(g.subject || g.from || "").slice(0, 80)}"` };
    }
  }
  return { ok: true, re: v.re };
}

// ── Runtime application (with cache) ─────────────────────────────────

let cache = { rules: null, loadedAt: 0 };

/** Drop the in-memory rule cache (after inserts/disables). */
export function invalidateRuleCache() {
  cache = { rules: null, loadedAt: 0 };
}

async function loadActiveRules() {
  const now = Date.now();
  if (cache.rules && now - cache.loadedAt < CACHE_TTL_MS) return cache.rules;
  try {
    const docs = await MailClassifierRule.find({ status: "active" })
      .select("pattern targetField category")
      .lean();
    const rules = [];
    for (const d of docs) {
      const v = validatePatternSource(d.pattern);
      if (!v.ok) continue;
      // Older rules were stored before the protected-sender check existed.
      if (d.targetField === "from" && coversProtectedSender(v.re)) continue;
      rules.push({ id: String(d._id), re: v.re, targetField: d.targetField, category: d.category });
    }
    cache = { rules, loadedAt: now };
    return rules;
  } catch (e) {
    console.warn(`[mail-regex] rule load failed: ${e.message}`);
    return cache.rules || [];
  }
}

/**
 * Apply learned exclusions to one rules-classification. Returns the (possibly
 * downgraded) classification. Fail-soft: any error returns the input untouched.
 *
 * @param {Object} classification - output of classifyMailByRules()
 * @param {Object} mail - { subject, from, bodyText }
 */
// Every category the learner may write an exclusion for. Rejection joined in
// Sept 2026 when rejections started reaching the ops channel.
export const LEARNABLE_CATEGORIES = new Set(["interview", "assessment", "offer", "rejection"]);

export async function applyLearnedExclusions(classification, mail) {
  const cat = classification?.category;
  if (!LEARNABLE_CATEGORIES.has(cat)) return classification;
  try {
    const rules = await loadActiveRules();
    for (const rule of rules) {
      if (rule.category !== "any" && rule.category !== cat) continue;
      if (!rule.re.test(fieldText(mail, rule.targetField))) continue;
      // Effectiveness bump — fire-and-forget.
      MailClassifierRule.updateOne(
        { _id: rule.id },
        { $inc: { timesMatched: 1 }, $set: { lastMatchedAt: new Date() } }
      ).catch(() => {});
      return {
        ...classification,
        category: "learned-excluded",
        priority: "low",
        actionRequired: "",
        excludedByRule: rule.id
      };
    }
  } catch (e) {
    console.warn(`[mail-regex] exclusion apply failed: ${e.message}`);
  }
  return classification;
}

/**
 * Self-correction: a learned exclusion hid a mail that AI triage found and the
 * verifier then confirmed genuine. The rule is wrong, so it is switched off for
 * every mailbox at once and the evidence is kept on it. Only "ai" rules are
 * retired automatically; a hand-written ("manual") rule is left to a human.
 * Never throws.
 *
 * @returns {Promise<{retired:boolean, reason:string}>}
 */
export async function retireExclusionRule(ruleId, { subject = "", reason = "" } = {}) {
  if (!ruleId) return { retired: false, reason: "no rule id" };
  try {
    const res = await MailClassifierRule.updateOne(
      { _id: ruleId, status: "active", source: { $ne: "manual" } },
      {
        $set: {
          status: "disabled",
          disabledAt: new Date(),
          disabledReason: clamp(`hid a mail the verifier confirmed genuine: ${reason}`, 300),
          wrongExampleSubject: clamp(subject, 200)
        }
      }
    );
    if (res.modifiedCount) invalidateRuleCache();
    return { retired: Boolean(res.modifiedCount), reason: res.modifiedCount ? "" : "already disabled, manual or missing" };
  } catch (e) {
    console.warn(`[mail-regex] could not retire rule ${ruleId}: ${e?.message || e}`);
    return { retired: false, reason: e?.message || String(e) };
  }
}

// ── Proposal pipeline (AI writes, gauntlet decides) ──────────────────

const MILESTONE_BRIEF = `A mail was WRONGLY flagged as a career milestone (an interview invitation, an assessment, or a job offer); the human-facing alert was stopped by a second AI check, and now you must write ONE exclusion pattern so this kind of mail is filtered out at the regex stage in future.`;

const REJECTION_BRIEF = `A mail was WRONGLY flagged as a REJECTION of the candidate's job application; a second AI check found it was nothing of the kind, and now you must write ONE exclusion pattern so this kind of mail is filtered out at the regex stage in future.`;

const SYSTEM_PROMPT = `You maintain the keyword filter of a job-search email classifier. {{BRIEF}}

Return ONLY a JSON object:
{
  "pattern": "a JavaScript-compatible regular expression SOURCE (no slashes, no flags; it will be compiled case-insensitive)",
  "targetField": "subject" | "from" | "body",
  "explanation": "one sentence: what kind of mail this excludes and why it can't hit real recruiting mail"
}

Hard requirements for the pattern:
- It must match THIS mail's chosen field.
- It must NEVER match genuine recruiting mail from a real employer: interview invitations, assessment invitations, job offers, or genuine rejection letters. Target what makes this mail promotional/automated: a distinctive marketing phrase, a product/brand name, a bulk-sender address pattern. Do not target generic recruiting vocabulary like "interview", "offer", "schedule a call", "next step", "unfortunately" or "other candidates" on their own.
- Prefer "subject"/"body" for a distinctive phrase. Use "from" only for a sender that never sends hiring mail (e.g. a marketing subdomain). Never target a generic no-reply address, or an applicant-tracking, scheduling or assessment system (Workday, iCIMS, Greenhouse, Lever, Ashby, Calendly, HireVue, Codility...): they send real interviews too, and such a pattern is refused.
- 8 to 200 characters. No lookbehind, no backreferences, no nested quantifiers like (x+)+.
- Escape regex metacharacters that should be literal.
Output raw JSON only.`;

function clamp(s, n) {
  const t = String(s || "").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}

/** Recent AI-confirmed genuine mails, to regression-test proposals against. */
async function loadGenuineExamples(limit = 50) {
  try {
    const docs = await MailVerifierFeedback.find({ genuineCount: { $gt: 0 } })
      .select("examples")
      .limit(40)
      .lean();
    const out = [];
    for (const d of docs) {
      for (const ex of d.examples || []) {
        if (ex.genuine && ex.subject) out.push({ subject: ex.subject, from: "", body: "" });
        if (out.length >= limit) return out;
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Ask the AI to write an exclusion rule for one verified false positive,
 * validate it, and store it. Never throws.
 *
 * @param {Object} a
 * @param {Object} a.mail          - { subject, from, bodyText }
 * @param {string} a.rulesCategory - what the regexes wrongly said (interview|assessment|offer)
 * @param {Object} a.verdict       - the verifier's rejection (ok:true, genuine:false)
 * @returns {Promise<{stored:boolean, reason:string, ruleId?:string, pattern?:string}>}
 */
export async function proposeAndStoreExclusion({ mail, rulesCategory, verdict }) {
  if (verdict?.ok !== true || verdict?.genuine === true) return { stored: false, reason: "not a verified false positive" };
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { stored: false, reason: "OPENAI_API_KEY not configured" };

  try {
    const activeCount = await MailClassifierRule.countDocuments({ status: "active" });
    if (activeCount >= MAX_ACTIVE_RULES) {
      console.warn(`[mail-regex] rule cap reached (${activeCount}/${MAX_ACTIVE_RULES}) — not proposing; prune via /gmail/mail-verify/rules`);
      return { stored: false, reason: "rule cap reached" };
    }
  } catch { /* cap check is best-effort */ }

  const userPrompt = [
    `Wrongly flagged as: ${rulesCategory}`,
    `Verifier's rejection reason: ${verdict.reason || "(none)"}`,
    `From: ${mail.from || "unknown"}`,
    `Subject: ${mail.subject || "(no subject)"}`,
    "",
    "--- EMAIL BODY (truncated) ---",
    clamp(mail.bodyText, BODY_TEST_CHARS) || "(empty)"
  ].join("\n");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let proposal;
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT.replace(
              "{{BRIEF}}",
              rulesCategory === "rejection" ? REJECTION_BRIEF : MILESTONE_BRIEF
            )
          },
          { role: "user", content: userPrompt }
        ],
        response_format: { type: "json_object" },
        temperature: 0
      }),
      signal: ctrl.signal
    });
    if (!res.ok) return { stored: false, reason: `OpenAI HTTP ${res.status}` };
    const data = await res.json();
    recordAiUsage({ source: AI_USAGE_SOURCES.MAIL_REGEX, model: data?.model || MODEL, usage: data?.usage });
    proposal = JSON.parse(data?.choices?.[0]?.message?.content || "null");
  } catch (e) {
    return { stored: false, reason: e?.name === "AbortError" ? "timeout" : `proposal failed: ${e?.message}` };
  } finally {
    clearTimeout(timer);
  }

  if (!proposal?.pattern || !proposal?.targetField) return { stored: false, reason: "AI returned no usable proposal" };

  const genuineExamples = await loadGenuineExamples();
  const check = acceptProposal({
    pattern: proposal.pattern,
    targetField: proposal.targetField,
    offendingMail: mail,
    genuineExamples,
    // Protect the category this rule will guard, not the other one.
    fixtures: rulesCategory === "rejection" ? GENUINE_REJECTION_FIXTURES : GENUINE_FIXTURES
  });
  if (!check.ok) {
    console.log(`[mail-regex] proposal REJECTED (${check.reason}): /${proposal.pattern}/i on ${proposal.targetField}`);
    return { stored: false, reason: check.reason };
  }

  try {
    const doc = await MailClassifierRule.findOneAndUpdate(
      { pattern: proposal.pattern, targetField: proposal.targetField },
      {
        $setOnInsert: {
          category: LEARNABLE_CATEGORIES.has(rulesCategory) ? rulesCategory : "any",
          status: "active",
          source: "ai",
          explanation: clamp(proposal.explanation, 300),
          verifierReason: clamp(verdict.reason, 300),
          exampleSubject: clamp(mail.subject, 200),
          exampleFrom: clamp(mail.from, 200),
          createdByModel: MODEL
        }
      },
      { upsert: true, new: true }
    );
    invalidateRuleCache();
    console.log(`[mail-regex] learned exclusion stored: /${proposal.pattern}/i on ${proposal.targetField} (${doc._id})`);
    return { stored: true, reason: "", ruleId: String(doc._id), pattern: proposal.pattern };
  } catch (e) {
    return { stored: false, reason: `store failed: ${e.message}` };
  }
}

export const __config = { MAX_ACTIVE_RULES, MIN_PATTERN_LEN, MAX_PATTERN_LEN, MODEL, LEARNABLE_CATEGORIES };
