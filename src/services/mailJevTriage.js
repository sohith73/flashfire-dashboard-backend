// mailJevTriage - the AI second look on TypeSafe's Jev decision model.
//
// Jev is not a chat model: it answers typed questions about a piece of content
// (https://docs.typesafe.ai). One "choice" question with the five triage
// categories is exactly the second look, and it is cheap: $0.042 per 1M input
// tokens, output free (docs.typesafe.ai/models, Nov 2026), against $0.15 in +
// $0.60 out for gpt-4o-mini. Tested on synthetic mail before wiring: 10/10
// correct (interview, assessment reminder, offer, English and French
// rejection, auto-ack, job alert, course promo, OTP), ~0.4 s per call.
//
// Same contract as mailAiTriage.triageMail: always resolves, ok:false on any
// failure so the caller can fall back. Usage is recorded under mail-triage with
// the versioned model id Jev reports (e.g. jev-1.14.0), priced by aiRateCard.
//
// Env: TYPESAFE_API_KEY (on/off switch), TYPESAFE_API_URL, TYPESAFE_MODEL.

import { recordAiUsage, AI_USAGE_SOURCES } from "../../Utils/aiUsage.js";

export const JEV_DEFAULT_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-latest";
const TIMEOUT_MS = 15000;
const MAX_STATE_CHARS = 6000;

const INSTRUCTIONS =
  "This email is from a job seeker's inbox. Which hiring step does it announce for a role the candidate applied to? " +
  "Applicant-tracking systems (Workday, Greenhouse, iCIMS, Lever and others) send every kind, so judge the content, not the sender.";

// Wording tested against real misses from the Nov 2026 mail audit.
export const JEV_CRITERIA = Object.freeze({
  interview:
    "Invites the candidate to an interview, phone screen or call for a specific role, or confirms, reschedules or reminds them of one (calendar invites included)",
  assessment:
    "Asks the candidate to complete, or reminds them to complete, a named test, assessment, video interview, take-home or assignment for a specific employer",
  offer: "A job offer for a specific role",
  rejection: "Tells the candidate they are no longer being considered for a specific role they applied to",
  none:
    'Anything else: application acknowledgements and "we will review", job alerts and digests, newsletters, marketing and courses, recruiter cold outreach, account or security mail',
});

const trim = (v) => String(v ?? "").trim();

/** Jev is on when a key is set. */
export function jevConfig(env = process.env) {
  return {
    apiKey: trim(env.TYPESAFE_API_KEY),
    url: trim(env.TYPESAFE_API_URL) || JEV_DEFAULT_URL,
    model: trim(env.TYPESAFE_MODEL) || JEV_DEFAULT_MODEL,
  };
}

/** Jev's 0-1 confidence -> the high / medium / low the pipeline gates on. */
export function confidenceBand(p) {
  const n = Number(p);
  if (!(n >= 0)) return "low";
  if (n >= 0.8) return "high";
  if (n >= 0.6) return "medium";
  return "low";
}

function fail(error, model = JEV_DEFAULT_MODEL) {
  return { ok: false, category: "none", confidence: "", reason: "", model, error: String(error || "unknown").slice(0, 300) };
}

export async function jevTriage({ from, subject, bodyText, snippet }, { fetchImpl = fetch, env = process.env } = {}) {
  const cfg = jevConfig(env);
  if (!cfg.apiKey) return fail("TYPESAFE_API_KEY not configured", cfg.model);

  const body = trim(bodyText) || trim(snippet) || "(empty body)";
  const state = [`From: ${from || "unknown"}`, `Subject: ${subject || "(no subject)"}`, "", body.slice(0, MAX_STATE_CHARS)].join("\n");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        state,
        questions: { category: { type: "choice", instructions: INSTRUCTIONS, criteria: JEV_CRITERIA } },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return fail(`Jev HTTP ${res.status}: ${text.slice(0, 200)}`, cfg.model);
    }
    const data = await res.json();
    const model = trim(data?.model) || cfg.model;
    recordAiUsage({ source: AI_USAGE_SOURCES.MAIL_TRIAGE, model, usage: data?.usage });

    const a = data?.answers?.category;
    if (!a || typeof a.choice !== "string") return fail("Jev returned no answer", model);
    const category = Object.hasOwn(JEV_CRITERIA, a.choice) ? a.choice : "none";
    const p = Number(a.confidence);
    return {
      ok: true,
      category,
      confidence: confidenceBand(p),
      reason: `jev: ${category} (${Number.isFinite(p) ? p.toFixed(2) : "?"})`,
      model,
      error: "",
    };
  } catch (e) {
    return fail(e?.name === "AbortError" ? `Jev timeout after ${TIMEOUT_MS}ms` : e?.message, cfg.model);
  } finally {
    clearTimeout(timer);
  }
}
