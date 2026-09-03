import axios from "axios";
import { recordAiUsage, AI_USAGE_SOURCES } from "../Utils/aiUsage.js";
import { ProfileModel } from "../Schema_Models/ProfileModel.js";
import { UserModel } from "../Schema_Models/UserModel.js";
import { RecruiterEmailTemplate } from "../Schema_Models/RecruiterEmailTemplate.js";
import { RecruiterEmailAutomation } from "../Schema_Models/RecruiterEmailAutomation.js";
import { RecruiterEmailGroup } from "../Schema_Models/RecruiterEmailGroup.js";
import { getAppSettings } from "../Schema_Models/AppSettings.js";
import { callGemini, GEMINI_JUDGE_MODEL, HAS_GEMINI_CREDENTIALS } from "../Utils/vertexGeminiJudge.js";

const RESUME_API_URL = process.env.RESUME_API_URL || "http://localhost:5000";
// Default to gpt-4o-mini: gpt-4o cost ~16x more per token and drove a spend
// spike. Override via OPENAI_RECRUITER_MODEL if a stronger tier is ever needed.
const OPENAI_MODEL = process.env.OPENAI_RECRUITER_MODEL || "gpt-4o-mini";
const PREFER_GEMINI = process.env.FF_RECRUITER_PREFER_GEMINI !== "0";
// Recruiter emails benefit from a stronger Gemini tier than the cheap judge
// model. Override via env if needed.
const GEMINI_RECRUITER_MODEL = process.env.GEMINI_RECRUITER_MODEL || "gemini-2.5-flash";
const DEFAULT_AI_DAILY_LIMIT = 5;
// Hard ceiling — Gmail's free-tier bounces ("You have reached a limit for
// sending mail") fire around the 5-recipient mark when sending one-by-one
// through the workflow account. Clamp every read/write to MAX so an old
// doc with dailyLimit=20 in Mongo never floods the queue.
export const MAX_AI_DAILY_LIMIT = 5;
export const clampDailyLimit = (n) => {
  const v = Math.floor(Number(n) || 0);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_AI_DAILY_LIMIT;
  return Math.min(v, MAX_AI_DAILY_LIMIT);
};

async function findDefaultTechGroup() {
  return RecruiterEmailGroup.findOne({
    $or: [
      { category: /^tech$/i },
      { name: /^technical$/i },
      { name: /^tech$/i }
    ]
  }).sort({ updatedAt: -1, createdAt: -1 });
}

/**
 * Fetch resume from gemini-resume microservice. Returns the same payload shape
 * autoOptimizationWorker uses (personalInfo, workExperience[], skills[] etc.).
 */
async function fetchResumeForUser(email) {
  try {
    const res = await axios.post(
      `${RESUME_API_URL}/api/resume-by-email`,
      { email },
      { timeout: 25000 }
    );
    return res.data || null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    console.warn(`[AI Template] resume fetch failed for ${email}: ${err.message}`);
    return null;
  }
}

async function fetchProfile(email) {
  return ProfileModel.findOne({ email: String(email).toLowerCase() }).lean();
}

async function fetchUser(email) {
  return UserModel.findOne({ email }).lean();
}

async function resolveOpenAIKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  try {
    const settings = await getAppSettings();
    if (settings?.globalOpenaiKey) return String(settings.globalOpenaiKey).trim();
  } catch (_) {
    /* ignore */
  }
  return "";
}

// ---------- Resume / profile -> compact prompt context ----------
function compactResumeContext(resume) {
  if (!resume) return "Resume: (not found)";
  const personal = resume.personalInfo || {};
  const fullName =
    [personal.firstName, personal.lastName].filter(Boolean).join(" ") ||
    personal.name ||
    "";
  const phone = personal.phone || personal.contactNumber || "";
  const email = personal.email || "";
  const location = personal.location || personal.address || "";
  const linkedin = personal.linkedin || "";

  const exp = Array.isArray(resume.workExperience) ? resume.workExperience : [];
  const expSummary = exp
    .slice(0, 6)
    .map((e, i) => {
      const lines = [];
      lines.push(
        `${i + 1}. ${e.title || ""} | ${e.company || ""} | ${e.duration || ""} | ${e.location || ""}`.trim()
      );
      const bullets = Array.isArray(e.bulletPoints) ? e.bulletPoints : [];
      for (const b of bullets.slice(0, 6)) {
        const clean = String(b || "").trim();
        if (clean) lines.push(`   - ${clean}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");

  const skillsArr = Array.isArray(resume.skills) ? resume.skills : [];
  const skills = skillsArr
    .slice(0, 12)
    .map((s) => `${s.category || "Skills"}: ${s.skills || ""}`)
    .join("\n");

  const edu = Array.isArray(resume.education) ? resume.education : [];
  const educationLines = edu
    .slice(0, 4)
    .map(
      (e) =>
        `${e.degree || ""} ${e.field ? `in ${e.field}` : ""} - ${e.institution || ""} (${e.duration || ""})`
    )
    .join("\n");

  const summary = String(resume.summary || "").trim();

  return [
    "RESUME CONTEXT:",
    `Name: ${fullName}`,
    `Email: ${email}`,
    `Phone: ${phone}`,
    `Location: ${location}`,
    linkedin ? `LinkedIn: ${linkedin}` : null,
    summary ? `Resume summary: ${summary}` : null,
    "",
    "Work experience:",
    expSummary || "(none)",
    "",
    "Skills:",
    skills || "(none)",
    "",
    "Education:",
    educationLines || "(none)"
  ]
    .filter(Boolean)
    .join("\n");
}

function compactProfileContext(profile, user) {
  if (!profile && !user) return "Profile: (not found)";
  const lines = [];
  lines.push("PROFILE CONTEXT:");
  if (profile) {
    const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ");
    if (fullName) lines.push(`Name: ${fullName}`);
    if (profile.contactEmail) lines.push(`Contact email: ${profile.contactEmail}`);
    if (profile.contactNumber) lines.push(`Phone: ${profile.contactNumber}`);
    if (profile.address) lines.push(`Address: ${profile.address}`);
    if (profile.preferredRoles?.length)
      lines.push(`Preferred roles: ${profile.preferredRoles.join(", ")}`);
    if (profile.experienceLevel) lines.push(`Experience level: ${profile.experienceLevel}`);
    if (profile.visaStatus)
      lines.push(`Visa status: ${profile.visaStatus}${profile.otherVisaType ? ` (${profile.otherVisaType})` : ""}`);
    if (profile.mastersUniDegree)
      lines.push(`Masters: ${profile.mastersUniDegree} (${profile.mastersGradMonthYear || "?"})`);
    if (profile.bachelorsUniDegree)
      lines.push(`Bachelors: ${profile.bachelorsUniDegree} (${profile.bachelorsGradMonthYear || "?"})`);
  }
  if (user) {
    if (user.planType) lines.push(`Plan: ${user.planType}`);
  }
  return lines.join("\n");
}

// ---------- Prompts ----------
const SYSTEM_PROMPT = `You write professional recruiter outreach emails for software / data / engineering candidates who are actively looking for new roles. The email must read like a polished plain-text message a senior engineer would actually send to a recruiter.

STYLE RULES (strict — violation is failure):
- Plain text only. No markdown. No HTML. No bold. No headings.
- Never use em dashes ("—") or en dashes ("–"). If you need a pause, use a comma, period, or parentheses.
- No AI-language tells: do not use phrases like "I hope this email finds you well", "delve", "leverage", "spearhead", "synergy", "in today's fast-paced", "passionate about", "circle back", "moreover", "furthermore", "in conclusion".
- Warm but professional. Confident, not boastful. No exclamation marks.
- Do not invent metrics, employers, projects, technologies, or dates. Use ONLY facts present in the candidate's resume / profile context provided in the user message. If a fact is missing, leave it out — never fabricate.
- Match the candidate's actual stack and seniority. Do not generalize.
- Subject must communicate: target role + years of experience. Format: "Application <Role Title> | <N>+ Years Experience". Replace <Role> with the candidate's primary target role. Replace <N> with their actual experience years.
- Body structure (follow exactly, in this order):
  1. Greeting line: "Greetings,"
  2. Blank line, then a short pleasant line: "Hope you're doing well."
  3. Blank line, then the intro paragraph (3-4 sentences): full name, the role they target with seniority, their core stack, and a sentence on what they specialize in or focus on. Make this paragraph substantive, not a one-liner.
  4. Blank line, then the lead-in line exactly: "In my recent roles, I have:"
  5. Blank line, then 5 to 6 bullet points of concrete achievements pulled directly from the resume's work experience. Each bullet starts with a bullet character "•" followed by a single space. Each bullet should be a FULL, detailed sentence of 30 to 55 words: state the achievement AND the method / context / tools that produced it (e.g. "...through workflow optimization and automation initiatives", "...to support strategic decision-making and business planning"). Do not write terse bullets. The last bullet should describe cross-functional collaboration or stakeholder work if the resume supports it.
  6. Blank line, then a closing paragraph (1-2 sentences) about education and work authorization.
  7. Blank line, then a final line offering to connect, exactly in this spirit: "I would welcome the opportunity to discuss how my <discipline> experience can contribute to your team and business goals." DO NOT mention any attached resume, attachment, or file — the automated workflow does not attach resumes, so claiming an attachment misleads recipients.
- Signature block exactly:
  Best regards,
  <Full Name>
  <Phone> | <Email>
  <City, State, Country>
- Total body length should land around 220-320 words. Richer and fuller is better than terse, but never pad with fluff or invented facts.
- Prefer "approximately" over the "~" symbol. Write numbers naturally.

OUTPUT FORMAT:
Return STRICT JSON only, with two keys: subject (string) and body (string). No prose, no code fences, no commentary. The body must be plain text with real newline characters \\n between paragraphs and bullets.`;

const STYLE_REFERENCE = `STYLE REFERENCE EXAMPLE (do not copy verbatim — only follow tone, structure, length, and bullet richness):
Subject: Application Business Analyst | 3+ Years Experience
Body:
Greetings,

Hope you're doing well.

My name is Aaditi Jayesh Shah, and I am a Business Analyst with experience in strategy and operations analysis. I specialize in driving requirements discovery, process optimization, and KPI analytics using SQL, Tableau/Power BI, Advanced Excel, and Python.

In my recent roles, I have:

• Identified approximately $30K in improvement opportunities, reducing manual effort by 30% and eliminating 200+ weekly manual data entries through workflow optimization and automation initiatives.
• Improved CTR by 20% through A/B testing support while also reducing supplier lead times by 18% and cutting excess inventory by 1,200 units through operational analysis and process improvements.
• Built data-driven strategy deliverables, including $10B+ market sizing analyses and adoption/revenue scenario models to support strategic decision-making and business planning.
• Conducted a 5-stage funnel analysis on 8,000+ leads to identify MQL/SQL conversion drop-offs and define rollout KPIs for performance tracking and optimization.
• Collaborated cross-functionally with stakeholders to gather business requirements, develop analytical insights, and support data-backed operational and strategic initiatives.

I am currently pursuing a Master of Science in Engineering Management at the University of Southern California and am on F1 OPT status in the United States.

I would welcome the opportunity to discuss how my analytical and strategic experience can contribute to your team and business goals.

Best regards,
Aaditi Jayesh Shah
+1 213-574-5047 | aaditishah26@gmail.com
Los Angeles, CA, USA

NOTE ON LENGTH: every bullet above is a full, detailed sentence (30-55 words) that names the achievement AND the method/context behind it. Match that depth. Do not produce short or stripped-down bullets.`;

function buildUserPrompt({ resume, profile, user, ownerEmail }) {
  return [
    `OWNER EMAIL (the candidate): ${ownerEmail}`,
    "",
    compactResumeContext(resume),
    "",
    compactProfileContext(profile, user),
    "",
    STYLE_REFERENCE,
    "",
    "Now generate the subject and body for THIS candidate, strictly following the style rules. Output JSON only."
  ].join("\n");
}

// ---------- Quality post-processing ----------
function sanitizeBody(text) {
  if (!text) return "";
  let s = String(text);
  // Replace em / en dashes with comma so we don't fail the no-dash rule.
  s = s.replace(/[—–]/g, ",");
  // Normalize bullets: any line starting with -, *, ·, –, — → •
  s = s
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (/^[-*·]\s+/.test(trimmed)) {
        const indent = line.slice(0, line.length - trimmed.length);
        return `${indent}• ${trimmed.replace(/^[-*·]\s+/, "")}`;
      }
      return line;
    })
    .join("\n");
  // Collapse 3+ blank lines.
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function sanitizeSubject(s) {
  return String(s || "").replace(/[—–]/g, "-").trim();
}

// ---------- Core: call OpenAI ----------
export async function generateAiRecruiterTemplate(ownerEmail) {
  const owner = String(ownerEmail || "").toLowerCase().trim();
  if (!owner) throw new Error("ownerEmail required");

  // OpenAI key is now optional — only needed for fallback. If Gemini is the
  // only path available, no key is fine; if both fail to be configured, the
  // call below will throw.
  const apiKey = await resolveOpenAIKey();
  if (!apiKey && !(PREFER_GEMINI && HAS_GEMINI_CREDENTIALS)) {
    throw new Error("No AI provider configured (need OPENAI key or GCP credentials)");
  }

  const [resume, profile, user] = await Promise.all([
    fetchResumeForUser(owner),
    fetchProfile(owner),
    fetchUser(owner)
  ]);

  if (!resume || !resume.personalInfo) {
    throw new Error("no_resume_assigned");
  }

  const userPrompt = buildUserPrompt({ resume, profile, user, ownerEmail: owner });

  let raw = "";
  let usedModel = "";
  let usage = null;

  // Gemini-first.
  if (PREFER_GEMINI && HAS_GEMINI_CREDENTIALS) {
    const g = await callGemini({
      system: SYSTEM_PROMPT,
      user: userPrompt,
      temperature: 0.4,
      json: true,
      model: GEMINI_RECRUITER_MODEL,
    });
    if (g.ok) {
      raw = g.content || "";
      usedModel = g.model || GEMINI_RECRUITER_MODEL;
      usage = g.usage || null;
      recordAiUsage({ source: AI_USAGE_SOURCES.RECRUITER_TEMPLATE, model: usedModel, usage });
    } else {
      console.warn(`[RecruiterAiTemplate] Gemini failed (${g.error}: ${g.message}) — falling back to OpenAI`);
    }
  }

  if (!raw) {
    if (!apiKey) throw new Error("OPENAI key not configured (Gemini failed too)");
    const body = {
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.4,
      response_format: { type: "json_object" }
    };
    const res = await axios.post("https://api.openai.com/v1/chat/completions", body, {
      timeout: 90_000,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      }
    });
    raw = res.data?.choices?.[0]?.message?.content || "";
    usedModel = res.data?.model || OPENAI_MODEL;
    usage = res.data?.usage || null;
    recordAiUsage({ source: AI_USAGE_SOURCES.RECRUITER_TEMPLATE, model: usedModel, usage });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("ai_response_not_json");
  }
  const subject = sanitizeSubject(parsed.subject || "");
  const bodyText = sanitizeBody(parsed.body || "");
  if (!subject || !bodyText) throw new Error("ai_response_missing_fields");

  return {
    subject,
    text: bodyText,
    model: usedModel,
    usage
  };
}

/**
 * Generate + persist as RecruiterEmailTemplate. If the user already has an
 * AI-generated template, update it in place (one AI template per user).
 * Returns the saved template document.
 */
export async function aiGenerateAndSaveTemplate(ownerEmail) {
  const owner = String(ownerEmail || "").toLowerCase().trim();
  const generated = await generateAiRecruiterTemplate(owner);

  const filter = { aiGenerated: true, aiOwnerEmail: owner };
  const update = {
    name: `AI Outreach — ${owner}`,
    subject: generated.subject,
    text: generated.text,
    aiGenerated: true,
    aiOwnerEmail: owner,
    aiBuiltAt: new Date(),
    aiModel: generated.model,
    createdBy: owner
  };

  const tpl = await RecruiterEmailTemplate.findOneAndUpdate(filter, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true
  });
  return tpl;
}

/**
 * Ensure that an Executive client crossing the threshold has an AI template
 * linked to their automation row. Called by the daily cron pre-pass.
 *
 * Returns "linked" | "skip_no_group" | "skip_already_has_template" | "skip_no_resume" | "error"
 */
export async function ensureAiTemplateForOwner(ownerEmail) {
  const owner = String(ownerEmail || "").toLowerCase().trim();
  if (!owner) return "error";

  let auto = await RecruiterEmailAutomation.findOne({ ownerEmail: owner });
  let groupId = auto?.group || null;
  if (!groupId) {
    const techGroup = await findDefaultTechGroup();
    if (!techGroup) return "skip_no_group";
    groupId = techGroup._id;
  }
  if (auto?.template) return "skip_already_has_template";

  try {
    const tpl = await aiGenerateAndSaveTemplate(owner);
    auto = await RecruiterEmailAutomation.findOneAndUpdate(
      { ownerEmail: owner },
      {
        ownerEmail: owner,
        group: groupId,
        template: tpl._id,
        dailyLimit: clampDailyLimit(auto?.dailyLimit),
        enabled: true
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return "linked";
  } catch (err) {
    if (err.message === "no_resume_assigned") return "skip_no_resume";
    console.error(`[AI Template] generation failed for ${owner}: ${err.message}`);
    return "error";
  }
}

// ---------- HTTP handlers ----------
export async function aiGenerateTemplateHandler(req, res) {
  try {
    const { ownerEmail, linkToAutomation } = req.body || {};
    if (!ownerEmail) return res.status(400).json({ error: "ownerEmail required" });

    const owner = String(ownerEmail).toLowerCase().trim();
    const tpl = await aiGenerateAndSaveTemplate(ownerEmail);
    let automation = null;
    let automationWarning = null;

    if (linkToAutomation) {
      const existing = await RecruiterEmailAutomation.findOne({ ownerEmail: owner });
      const groupId = existing?.group || (await findDefaultTechGroup())?._id;
      if (groupId) {
        const doc = await RecruiterEmailAutomation.findOneAndUpdate(
          { ownerEmail: owner },
          {
            ownerEmail: owner,
            group: groupId,
            template: tpl._id,
            dailyLimit: clampDailyLimit(existing?.dailyLimit),
            enabled: true
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        automation = {
          id: String(doc._id),
          ownerEmail: doc.ownerEmail,
          groupId: String(doc.group),
          templateId: String(doc.template),
          dailyLimit: doc.dailyLimit,
          enabled: doc.enabled
        };
      } else {
        automationWarning = "No Technical/tech recruiter group found. Template was saved but automation was not linked.";
      }
    }

    res.json({
      template: {
        id: String(tpl._id),
        name: tpl.name,
        subject: tpl.subject,
        text: tpl.text,
        aiGenerated: tpl.aiGenerated,
        aiBuiltAt: tpl.aiBuiltAt,
        aiModel: tpl.aiModel
      },
      automation,
      warning: automationWarning
    });
  } catch (err) {
    const code = err.message;
    const message = err.message || "ai_generation_failed";
    const status = code === "no_resume_assigned" ? 422 : 500;
    res.status(status).json({ error: message });
  }
}
