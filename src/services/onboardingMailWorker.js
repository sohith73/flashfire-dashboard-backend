// onboardingMailWorker — fires a short email sequence to a client's PAYMENT email
// once they have MORE THAN 3 job cards in the "Applied" column.
//
// Sequence (spaced ~90 min apart, sent over the App-Password SMTP account):
//   1. base résumé is ready       → check WhatsApp group
//   2. cover letter is ready      → check WhatsApp group   (executive/prime only)
//   3. LinkedIn optimization done → check WhatsApp group
//
// Plan gating — a client is only ever told about work their plan actually
// includes. LinkedIn optimisation is sold with Professional and Executive only
// (the same rule clients-tracking applies in src/utils/planFeatures.js), so
// Prime and Ignite clients must never receive the LinkedIn email:
//   executive    → base résumé + cover letter + LinkedIn (only plan with the cover letter)
//   professional → base résumé + LinkedIn
//   prime        → base résumé
//   ignite       → base résumé
// The gate is applied twice: at schedule time (stepsForPlan) and again at send
// time, because a sequence scheduled under the old rules — or before a plan
// change — still carries the step in its OnboardingMailState doc.
//
// SAFETY — the big one: many existing clients are already past 3 applied cards,
// so on first run we BACKFILL those (marker-guarded, one time) as "skipped" and
// never email them. Only a client who crosses from ≤3 to >3 applied cards AFTER
// this ships is scheduled.
//
// Idempotent: one OnboardingMailState per client; a step sends at most once
// (sentAt guard); steps go out in order, one per client per tick, and each step
// waits SPACING_MIN after the PREVIOUS step's actual sentAt — so the 90-minute
// gap survives restarts, deploy gaps and pauses alike. Nothing here throws to
// the caller.

import cron from "node-cron";
import { JobModel } from "../../Schema_Models/JobModel.js";
import { ClientPaymentLookup } from "../../Schema_Models/ClientPaymentLookup.js";
import { OnboardingMailState, ONBOARDING_BACKFILL_MARKER } from "../../Schema_Models/OnboardingMailState.js";
import { sendViaSmtp, isSmtpConfigured, isMailCategoryPaused, MAIL_CATEGORY } from "../../Utils/smtpSender.js";
import { renderOnboardingEmail } from "../../Utils/onboardingMailTemplates.js";
import { unsubscribeHeaders, UNSUB_STREAMS } from "../../Utils/unsubscribe.js";

// ── Fixed config (hard-coded; no env sprawl) ──
const CRON_EXPR = "*/15 * * * *"; // every 15 min
const SPACING_MIN = 90; // gap between emails (within the 1–2h ask)
const MAX_ATTEMPTS = 4; // per step, before giving up
const APPLIED_RE = /appl/i; // currentStatus for an applied job
const APPLIED_THRESHOLD = 3; // fire once a client has MORE THAN this many applied cards
// Ceiling on sends per tick. Bounds the burst when a backlog drains (a pause, a
// long deploy gap) and keeps us well under the Gmail App-Password daily cap.
const MAX_SENDS_PER_TICK = 25;

// Which steps each plan receives, in order.
const PLAN_STEPS = {
  executive: ["base_resume", "cover_letter", "linkedin"],
  professional: ["base_resume", "linkedin"],
  prime: ["base_resume"],
  "free trial": ["base_resume"], // legacy alias for prime — see Utils/dailyCapGuard.js
  ignite: ["base_resume"]
};
// Unknown or missing plan: base résumé only. Claiming a LinkedIn optimisation
// the client may not have bought is the expensive mistake here; a missing email
// is recoverable from the Onboarding Emails panel in clients-tracking.
const DEFAULT_STEPS = ["base_resume"];

// Enable only on the real Render deploy (or forced), and only with SMTP — a
// laptop sharing the prod DB must never fire onboarding mail to real clients.
const _raw = process.env.ONBOARDING_MAIL_ENABLED;
const ENABLED = _raw === "1" ? true : _raw === "0" ? false : Boolean(process.env.RENDER);
const ENABLED_REASON =
  _raw === "1" ? "forced on" : _raw === "0" ? "forced off" : Boolean(process.env.RENDER) ? "auto-on (Render)" : "off (not Render)";

let running = false;
let task = null;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const lc = (s) => String(s || "").toLowerCase().trim();

export function stepsForPlan(planType) {
  return PLAN_STEPS[lc(planType)] || DEFAULT_STEPS;
}

// planIncludesStep — is this step part of what `planType` bought?
export function planIncludesStep(planType, key) {
  return stepsForPlan(planType).includes(key);
}

// livePlanType — the client's plan RIGHT NOW, not the one stamped on the
// sequence when it was scheduled. A plan downgrade (or a rule change like
// dropping LinkedIn from Prime) has to be able to stop a step that is already
// queued, so the send-time gate reads the tracking record and only falls back
// to the doc when the client can't be resolved.
async function livePlanType(doc) {
  const email = lc(doc.clientEmail);
  const row = await ClientPaymentLookup.findOne({ email })
    .select("planType")
    .lean()
    .catch(() => null);
  return lc(row?.planType || doc.planType);
}

// Emails (lowercased) of every client with MORE THAN APPLIED_THRESHOLD applied
// job cards. One aggregation, grouped case-insensitively on userID (the client's
// email). Shared by the backfill and the live detector so both use one rule.
async function emailsOverAppliedThreshold() {
  const rows = await JobModel.aggregate([
    { $match: { currentStatus: APPLIED_RE } },
    { $group: { _id: { $toLower: "$userID" }, n: { $sum: 1 } } },
    { $match: { n: { $gt: APPLIED_THRESHOLD } } }
  ]).catch(() => []);
  return rows.map((r) => lc(r._id)).filter((e) => EMAIL_RE.test(e));
}

// ── One-time backfill: mark every client ALREADY past the applied threshold as
// skipped, so the sequence only ever fires for clients who cross >3 later. ──
async function backfillOnce() {
  const marker = await OnboardingMailState.findOne({ clientEmail: ONBOARDING_BACKFILL_MARKER }).lean();
  if (marker) return { alreadyDone: true };

  const emails = [...new Set(await emailsOverAppliedThreshold())];

  if (emails.length) {
    // Insert a 'skipped' doc for each, ignoring any that already exist.
    const ops = emails.map((clientEmail) => ({
      updateOne: {
        filter: { clientEmail },
        update: { $setOnInsert: { clientEmail, status: "skipped", skipReason: "backfill_existing", steps: [] } },
        upsert: true
      }
    }));
    try {
      await OnboardingMailState.bulkWrite(ops, { ordered: false });
    } catch (e) {
      // Duplicate-key races are expected under concurrency; ignore them.
      if (e?.code !== 11000) console.error("[onboarding-mail] backfill bulkWrite:", e?.message || e);
    }
  }

  await OnboardingMailState.updateOne(
    { clientEmail: ONBOARDING_BACKFILL_MARKER },
    { $setOnInsert: { clientEmail: ONBOARDING_BACKFILL_MARKER, status: "skipped", skipReason: "marker", steps: [] } },
    { upsert: true }
  ).catch(() => {});

  console.log(`[onboarding-mail] backfill complete — ${emails.length} existing applied-client(s) marked skipped`);
  return { backfilled: emails.length };
}

// ── Detect clients who have just crossed >3 applied cards, and schedule them. ──
async function detectAndSchedule() {
  // Candidate clients = tracked clients with a valid payment email, not already
  // handled (no OnboardingMailState doc).
  const clients = await ClientPaymentLookup.find({})
    .select("email name planType paymentEmail")
    .lean()
    .catch(() => []);

  const known = new Set(
    (await OnboardingMailState.find({}).select("clientEmail").lean().catch(() => [])).map((d) => lc(d.clientEmail))
  );

  const candidates = clients
    .map((c) => ({
      email: lc(c.email),
      name: c.name || "",
      planType: lc(c.planType),
      paymentEmail: lc(c.paymentEmail)
    }))
    .filter((c) => c.email && !known.has(c.email) && EMAIL_RE.test(c.paymentEmail));

  if (!candidates.length) return { scheduled: 0 };

  // Which candidates have MORE THAN 3 applied job cards right now.
  const overThreshold = new Set(await emailsOverAppliedThreshold());

  let scheduled = 0;
  const now = Date.now();
  for (const c of candidates) {
    if (!overThreshold.has(c.email)) continue; // not past 3 applied yet → check again next tick

    const keys = stepsForPlan(c.planType);
    const steps = keys.map((key, i) => ({
      key,
      subject: "",
      sendAt: new Date(now + i * SPACING_MIN * 60 * 1000),
      sentAt: null,
      attempts: 0,
      error: ""
    }));

    try {
      await OnboardingMailState.create({
        clientEmail: c.email,
        clientName: c.name,
        planType: c.planType,
        paymentEmail: c.paymentEmail,
        firstAppliedAt: new Date(),
        status: "scheduled",
        steps
      });
      scheduled++;
      console.log(`[onboarding-mail] scheduled ${keys.length}-step sequence for ${c.email} (${c.planType || "?"})`);
    } catch (e) {
      if (e?.code !== 11000) console.error(`[onboarding-mail] schedule failed for ${c.email}: ${e?.message || e}`);
    }
  }
  return { scheduled };
}

// ── Send due steps — one step per client per tick, in order, honouring spacing. ──
export async function sendDue() {
  // This stream is live; the pause set in Utils/smtpSender.js covers the
  // classifier-driven milestone alerts only. Guard anyway so re-pausing
  // 'onboarding' there stops us here WITHOUT burning attempt counters.
  if (isMailCategoryPaused(MAIL_CATEGORY.ONBOARDING)) return { sent: 0, skipped: "emails_paused" };
  if (!isSmtpConfigured()) return { sent: 0, skipped: "smtp_not_configured" };

  const docs = await OnboardingMailState.find({ status: "scheduled" }).catch(() => []);
  let sent = 0;

  for (const doc of docs) {
    if (sent >= MAX_SENDS_PER_TICK) break; // drain the rest on the next tick
    // First not-yet-sent step, in order.
    const idx = doc.steps.findIndex((s) => !s.sentAt);
    if (idx === -1) {
      doc.status = "done";
      await doc.save().catch(() => {});
      continue;
    }
    const step = doc.steps[idx];

    // Send-time plan gate. base_resume is in every plan, so only the gated
    // steps pay for a lookup. A step the client's CURRENT plan doesn't include
    // is dropped from the sequence outright — it was never sent, and leaving it
    // queued would either mail it later or block the steps behind it. This is
    // what stops a Prime client who was scheduled under the old rules (base
    // résumé + LinkedIn) from still receiving the LinkedIn email.
    if (step.key !== "base_resume") {
      const plan = await livePlanType(doc);
      if (!planIncludesStep(plan, step.key)) {
        console.log(`[onboarding-mail] dropped '${step.key}' for ${doc.clientEmail} — not in plan '${plan || "(none)"}'`);
        doc.steps.splice(idx, 1);
        if (!doc.steps.length || doc.steps.every((s) => s.sentAt)) doc.status = "done";
        await doc.save().catch((e) => console.error("[onboarding-mail] prune save failed:", e?.message || e));
        continue; // the next step, if any, goes out on a later tick
      }
    }

    if (new Date(step.sendAt).getTime() > Date.now()) continue; // not due yet
    if ((step.attempts || 0) >= MAX_ATTEMPTS) continue; // give up on this step (blocks the rest by design)

    // Spacing is measured from the PREVIOUS step's ACTUAL delivery, not from the
    // sendAt stamped at schedule time. Without this, any sequence that sat idle
    // longer than the schedule (a pause, a deploy gap, an SMTP outage) comes
    // back with every step already past its sendAt and fires them one per tick
    // — 15 minutes apart instead of 90.
    if (idx > 0) {
      const prevSentAt = doc.steps[idx - 1].sentAt;
      if (prevSentAt && Date.now() - new Date(prevSentAt).getTime() < SPACING_MIN * 60 * 1000) continue;
    }

    const rendered = renderOnboardingEmail({ key: step.key, clientName: doc.clientName, clientEmail: doc.paymentEmail });
    if (!rendered) {
      step.attempts = MAX_ATTEMPTS; // unknown step key — don't spin on it
      step.error = "unknown_step";
      await doc.save().catch(() => {});
      continue;
    }

    const result = await sendViaSmtp({
      to: doc.paymentEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      category: MAIL_CATEGORY.ONBOARDING,
      headers: unsubscribeHeaders(doc.clientEmail || doc.paymentEmail, UNSUB_STREAMS.ONBOARDING)
    });
    step.attempts = (step.attempts || 0) + 1;
    if (result.ok) {
      step.sentAt = new Date();
      step.messageId = result.messageId || "";
      step.subject = rendered.subject;
      step.error = "";
      sent++;
      // If that was the last step, close out the sequence.
      if (doc.steps.every((s) => s.sentAt)) doc.status = "done";
      console.log(`[onboarding-mail] sent '${step.key}' to ${doc.paymentEmail} (${doc.clientEmail})`);
    } else {
      step.error = String(result.error || "send_failed").slice(0, 300);
      console.warn(`[onboarding-mail] send '${step.key}' to ${doc.paymentEmail} failed: ${step.error}`);
    }
    await doc.save().catch((e) => console.error("[onboarding-mail] save failed:", e?.message || e));
  }
  return { sent };
}

export async function onboardingTick({ trigger = "cron" } = {}) {
  if (!ENABLED) return { disabled: true, reason: ENABLED_REASON };
  if (running) return { skipped: "already_running" };
  running = true;
  const startedAt = Date.now();
  try {
    // Order matters: backfill (skip existing) BEFORE detect, so pre-existing
    // clients can never be scheduled. Detect ONLY after the marker is confirmed
    // set — if backfill was interrupted, we'd rather wait a tick than risk
    // scheduling an existing client before their skip-doc exists.
    await backfillOnce();
    const backfillConfirmed = await OnboardingMailState.exists({ clientEmail: ONBOARDING_BACKFILL_MARKER });
    let d = { scheduled: 0 };
    if (backfillConfirmed) {
      d = await detectAndSchedule();
    } else {
      console.warn("[onboarding-mail] backfill not confirmed — skipping detect this tick (safety)");
    }
    const s = await sendDue();
    const out = { trigger, scheduled: d.scheduled || 0, sent: s.sent || 0, tookMs: Date.now() - startedAt };
    if (out.scheduled || out.sent) console.log(`[onboarding-mail] tick — scheduled=${out.scheduled} sent=${out.sent}`);
    return out;
  } catch (err) {
    console.error("[onboarding-mail] tick crashed:", err);
    return { error: err.message };
  } finally {
    running = false;
  }
}

export function startOnboardingMailWorker() {
  if (!ENABLED) {
    console.log(`[onboarding-mail] disabled (${ENABLED_REASON})`);
    return null;
  }
  if (task) return task;
  task = cron.schedule(CRON_EXPR, () => onboardingTick({ trigger: "cron" }), { timezone: "Asia/Kolkata" });
  console.log(`[onboarding-mail] worker registered (${ENABLED_REASON}, cron='${CRON_EXPR}', spacing=${SPACING_MIN}m)`);
  return task;
}
