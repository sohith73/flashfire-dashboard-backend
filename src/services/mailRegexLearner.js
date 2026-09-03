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
    subject: "Interview confirmed: Thursday 2 PM ET",
    from: "scheduling@calendly.com",
    body: "Your interview with Hooli has been scheduled. A calendar invitation has been sent to your email."
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
 * @returns {{ok:true, re:RegExp} | {ok:false, reason:string}}
 */
export function acceptProposal({ pattern, targetField, offendingMail, genuineExamples = [] }) {
  if (!TARGET_FIELDS.has(targetField)) return { ok: false, reason: `bad targetField: ${targetField}` };
  const v = validatePatternSource(pattern);
  if (!v.ok) return v;

  // Must actually catch the mail that triggered the learning.
  if (!v.re.test(fieldText(offendingMail, targetField))) {
    return { ok: false, reason: "does not match the offending mail" };
  }

  // Must not catch ANY genuine milestone — fixtures first, then live examples.
  for (const g of [...GENUINE_FIXTURES, ...genuineExamples]) {
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
      if (v.ok) rules.push({ id: String(d._id), re: v.re, targetField: d.targetField, category: d.category });
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
export async function applyLearnedExclusions(classification, mail) {
  const cat = classification?.category;
  if (cat !== "interview" && cat !== "assessment" && cat !== "offer") return classification;
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

// ── Proposal pipeline (AI writes, gauntlet decides) ──────────────────

const SYSTEM_PROMPT = `You maintain the keyword filter of a job-search email classifier. A mail was WRONGLY flagged as a career milestone; the human-facing alert was stopped by a second AI check, and now you must write ONE exclusion pattern so this kind of mail is filtered out at the regex stage in future.

Return ONLY a JSON object:
{
  "pattern": "a JavaScript-compatible regular expression SOURCE (no slashes, no flags; it will be compiled case-insensitive)",
  "targetField": "subject" | "from" | "body",
  "explanation": "one sentence: what kind of mail this excludes and why it can't hit real recruiting mail"
}

Hard requirements for the pattern:
- It must match THIS mail's chosen field.
- It must NEVER match genuine interview invitations, assessment invitations, or job offers from real employers. Target what makes this mail promotional/automated: a distinctive marketing phrase, a product/brand name, a bulk-sender address pattern. Do not target generic recruiting vocabulary like "interview", "offer", "schedule a call", "next step" on their own.
- Prefer "from" when the sender address itself is the tell (e.g. a marketing subdomain); prefer "subject"/"body" for a distinctive phrase.
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
          { role: "system", content: SYSTEM_PROMPT },
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
    genuineExamples
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
          category: ["interview", "assessment", "offer"].includes(rulesCategory) ? rulesCategory : "any",
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

export const __config = { MAX_ACTIVE_RULES, MIN_PATTERN_LEN, MAX_PATTERN_LEN, MODEL };
