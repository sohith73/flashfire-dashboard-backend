// OnboardingMailStatus — per-client visibility + manual control for the
// onboarding email sequence (base résumé → cover letter → LinkedIn).
//
// The sequence itself is owned by src/services/onboardingMailWorker.js and
// fires automatically when a client's FIRST job reaches "Applied". Operators
// in clients-tracking need to answer two questions per client that the worker
// alone can't surface:
//   1. Did this client's résumé / cover letter / LinkedIn email actually go out?
//   2. If not, why not — and can I send it by hand right now?
//
// GET  /admin/onboarding-mail/status?email=  → the answer to (1) + (2)
// POST /admin/onboarding-mail/send-step      → the escape hatch for (2)
//
// The GET is deliberately tolerant: a client with NO OnboardingMailState doc
// still gets a full three-row answer (their plan's expected steps, each marked
// not-scheduled with the reason) so the UI never renders an empty panel.

import { JobModel } from "../Schema_Models/JobModel.js";
import { ClientPaymentLookup } from "../Schema_Models/ClientPaymentLookup.js";
import { OnboardingMailState } from "../Schema_Models/OnboardingMailState.js";
import { stepsForPlan, planIncludesStep } from "../src/services/onboardingMailWorker.js";
import { renderOnboardingEmail, isOnboardingStep } from "../Utils/onboardingMailTemplates.js";
import {
  sendViaSmtp,
  isSmtpConfigured,
  isMailCategoryPaused,
  MAIL_CATEGORY,
} from "../Utils/smtpSender.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const APPLIED_RE = /appl/i;
const lc = (s) => String(s || "").toLowerCase().trim();

// Operator-facing labels. Keys must match OnboardingMailState.steps[].key.
const STEP_LABEL = {
  base_resume: "Base résumé ready",
  cover_letter: "Cover letter ready",
  linkedin: "LinkedIn optimisation done",
};

// Mirrors onboardingMailWorker's ENABLED gate so the UI can explain a silent
// worker instead of leaving the operator guessing.
function workerEnabled() {
  const raw = process.env.ONBOARDING_MAIL_ENABLED;
  if (raw === "1") return { enabled: true, reason: "forced on" };
  if (raw === "0") return { enabled: false, reason: "forced off (ONBOARDING_MAIL_ENABLED=0)" };
  return process.env.RENDER
    ? { enabled: true, reason: "auto-on (Render)" }
    : { enabled: false, reason: "off (not running on Render)" };
}

// resolveClient — the tracking doc that owns planType + paymentEmail. Same
// collection the worker reads, so status can never disagree with behaviour.
async function resolveClient(email) {
  const e = lc(email);
  const doc = await ClientPaymentLookup.findOne({ email: e })
    .select("email name planType paymentEmail")
    .lean()
    .catch(() => null);
  if (doc) return doc;
  const esc = e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return ClientPaymentLookup.findOne({ email: { $regex: new RegExp(`^${esc}$`, "i") } })
    .select("email name planType paymentEmail")
    .lean()
    .catch(() => null);
}

/**
 * GET /admin/onboarding-mail/status?email=<client email>
 *
 * Always 200 for a well-formed email, even when nothing is scheduled — the
 * payload explains why. Never throws to the caller.
 */
export async function OnboardingMailStatus(req, res) {
  try {
    const email = lc(req.query?.email);
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "valid email query param is required" });
    }

    // JobModel.userID is a plain String with no lowercase enforcement, and the
    // worker's detector lowercases the values it compares — so an exact match
    // here would report "no applied jobs" for a client the worker WOULD
    // schedule. Match case-insensitively to stay consistent with the worker.
    const userIdRe = new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    const [client, state, appliedCount] = await Promise.all([
      resolveClient(email),
      OnboardingMailState.findOne({ clientEmail: email }).lean().catch(() => null),
      JobModel.countDocuments({ userID: userIdRe, currentStatus: APPLIED_RE }).catch(() => 0),
    ]);

    const planType = lc(client?.planType);
    const paymentEmail = lc(client?.paymentEmail || state?.paymentEmail);
    const expectedKeys = stepsForPlan(planType);
    const worker = workerEnabled();
    const paused = isMailCategoryPaused(MAIL_CATEGORY.ONBOARDING);
    const smtpReady = isSmtpConfigured();

    // Why is nothing scheduled? Answer once, reuse for every row.
    let notScheduledReason = "";
    if (!state) {
      if (!client) notScheduledReason = "client not found in tracking (dashboardtrackings)";
      else if (!EMAIL_RE.test(paymentEmail)) notScheduledReason = "no payment email on the tracking record";
      else if (!appliedCount) notScheduledReason = "no job has reached Applied yet — the sequence starts on the first one";
      else notScheduledReason = "not picked up yet — the worker schedules on its next 15-minute tick";
    } else if (state.status === "skipped") {
      notScheduledReason =
        state.skipReason === "backfill_existing"
          ? "existing client at feature launch — deliberately never auto-emailed"
          : state.skipReason || "skipped";
    }

    // One row per step the client's PLAN entitles them to, in send order.
    const byKey = new Map((state?.steps || []).map((s) => [s.key, s]));
    const steps = expectedKeys.map((key) => {
      const s = byKey.get(key);
      const sent = !!s?.sentAt;
      return {
        key,
        label: STEP_LABEL[key] || key,
        // The client's plan entitles them to this email. Drives the "Not in
        // plan" tag in clients-tracking, which also hides the send button.
        inPlan: true,
        scheduled: !!s,
        sent,
        sentAt: s?.sentAt || null,
        sendAt: s?.sendAt || null,
        attempts: s?.attempts || 0,
        error: s?.error || "",
        messageId: s?.messageId || "",
        // What the operator should read on the row.
        state: sent
          ? "sent"
          : !s
            ? "not-scheduled"
            : (s.attempts || 0) >= 4
              ? "failed"
              : "pending",
        reason: s ? "" : notScheduledReason,
      };
    });

    // Steps recorded on the doc that the client's CURRENT plan no longer
    // includes (plan changed after scheduling). Surfaced so a sent cover-letter
    // email doesn't vanish from the UI when the plan is downgraded.
    const extraSteps = (state?.steps || [])
      .filter((s) => !expectedKeys.includes(s.key))
      .map((s) => ({
        key: s.key,
        label: STEP_LABEL[s.key] || s.key,
        inPlan: false,
        scheduled: true,
        sent: !!s.sentAt,
        sentAt: s.sentAt || null,
        sendAt: s.sendAt || null,
        attempts: s.attempts || 0,
        error: s.error || "",
        messageId: s.messageId || "",
        // Never "pending": the worker drops an unsent out-of-plan step from the
        // sequence, so one that is still here and unsent is not going anywhere.
        state: s.sentAt ? "sent" : "not-scheduled",
        reason: "not in the client's current plan",
      }));

    return res.json({
      email,
      clientName: client?.name || state?.clientName || "",
      planType,
      paymentEmail,
      appliedCount,
      // Sequence-level state.
      status: state?.status || "not-scheduled",
      skipReason: state?.skipReason || "",
      firstAppliedAt: state?.firstAppliedAt || null,
      notScheduledReason,
      steps: [...steps, ...extraSteps],
      // Delivery preconditions — the UI disables "Send now" and explains why.
      delivery: {
        workerEnabled: worker.enabled,
        workerReason: worker.reason,
        paused,
        smtpConfigured: smtpReady,
        canSend: smtpReady && !paused && EMAIL_RE.test(paymentEmail),
      },
    });
  } catch (err) {
    console.error("[onboarding-mail/status] failed:", err);
    return res.status(500).json({ error: err?.message || "status_failed" });
  }
}

/**
 * POST /admin/onboarding-mail/send-step
 * body: { email, key }   key ∈ base_resume | cover_letter | linkedin
 *
 * Sends ONE step immediately, ignoring its schedule. Records the send on the
 * client's OnboardingMailState (creating the doc if the client was never
 * scheduled — a backfilled client whose résumé really is ready is exactly the
 * case this exists for), so the automatic sender will not send it again.
 */
export async function SendOnboardingMailStep(req, res) {
  try {
    const email = lc(req.body?.email);
    const key = String(req.body?.key || "").trim();
    const force = req.body?.force === true;

    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "valid email is required" });
    }
    if (!isOnboardingStep(key)) {
      return res.status(400).json({ error: `unknown step '${key}'` });
    }
    if (isMailCategoryPaused(MAIL_CATEGORY.ONBOARDING)) {
      return res.status(409).json({ error: "onboarding emails are paused in Utils/smtpSender.js" });
    }
    if (!isSmtpConfigured()) {
      return res.status(503).json({ error: "smtp_not_configured — set SMTP_USER and SMTP_PASS" });
    }

    const [client, state] = await Promise.all([
      resolveClient(email),
      OnboardingMailState.findOne({ clientEmail: email }),
    ]);

    const paymentEmail = lc(client?.paymentEmail || state?.paymentEmail);
    if (!EMAIL_RE.test(paymentEmail)) {
      return res.status(400).json({
        error: "no payment email on file — onboarding mail is only ever sent to the payment email",
      });
    }

    // Plan gate, same rule the worker applies at send time. Without it the
    // "Send again" button is a hole straight through the gating: an operator
    // could hand-send "LinkedIn optimisation done" to a Prime client, who never
    // bought a LinkedIn optimisation. `force` is the deliberate override.
    const planType = lc(client?.planType || state?.planType);
    if (!planIncludesStep(planType, key) && !force) {
      return res.status(409).json({
        error: `'${key}' is not part of the ${planType || "client's"} plan`,
        planType,
        hint: "pass force:true to send it anyway",
      });
    }

    // Already delivered? Require an explicit force so a double-click can't
    // re-mail a client.
    const existing = state?.steps?.find((s) => s.key === key);
    if (existing?.sentAt && !force) {
      return res.status(409).json({
        error: "already sent",
        sentAt: existing.sentAt,
        hint: "pass force:true to send it again",
      });
    }

    const clientName = client?.name || state?.clientName || "";
    const rendered = renderOnboardingEmail({ key, clientName, clientEmail: paymentEmail });
    if (!rendered) return res.status(500).json({ error: "template_render_failed" });

    const result = await sendViaSmtp({
      to: paymentEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      category: MAIL_CATEGORY.ONBOARDING,
    });

    if (!result.ok) {
      // Record the failure on the step when we have one, so attempts/error
      // stay in sync with what the automatic sender would have written.
      if (state && existing) {
        existing.attempts = (existing.attempts || 0) + 1;
        existing.error = String(result.error || "send_failed").slice(0, 300);
        await state.save().catch(() => {});
      }
      console.warn(`[onboarding-mail] MANUAL send '${key}' to ${paymentEmail} failed: ${result.error}`);
      return res.status(502).json({ ok: false, error: result.error || "send_failed" });
    }

    const now = new Date();
    if (state) {
      const step = state.steps.find((s) => s.key === key);
      if (step) {
        step.sentAt = now;
        step.messageId = result.messageId || "";
        step.subject = rendered.subject;
        step.error = "";
        step.attempts = (step.attempts || 0) + 1;
      } else {
        // Step missing from the doc (plan changed, or a skipped client). Add it
        // as already-sent so the automatic sender treats it as done.
        state.steps.push({
          key,
          subject: rendered.subject,
          sendAt: now,
          sentAt: now,
          attempts: 1,
          error: "",
          messageId: result.messageId || "",
        });
      }
      // A manual send on a skipped client must NOT flip the doc to "scheduled"
      // — that would let the worker start auto-sending the remaining steps to a
      // client who was deliberately excluded. Only close out a live sequence.
      if (state.status === "scheduled" && state.steps.every((s) => s.sentAt)) {
        state.status = "done";
      }
      if (!state.paymentEmail) state.paymentEmail = paymentEmail;
      await state.save().catch((e) => console.error("[onboarding-mail] manual save failed:", e?.message || e));
    } else {
      // Never scheduled. Record the manual send as a skipped sequence so the
      // detector never schedules this client afterwards and re-sends the rest.
      await OnboardingMailState.create({
        clientEmail: email,
        clientName,
        planType: lc(client?.planType),
        paymentEmail,
        status: "skipped",
        skipReason: "manual_send_only",
        steps: [{
          key,
          subject: rendered.subject,
          sendAt: now,
          sentAt: now,
          attempts: 1,
          error: "",
          messageId: result.messageId || "",
        }],
      }).catch((e) => console.error("[onboarding-mail] manual create failed:", e?.message || e));
    }

    console.log(`[onboarding-mail] MANUAL sent '${key}' to ${paymentEmail} (${email})`);
    return res.json({
      ok: true,
      key,
      to: paymentEmail,
      subject: rendered.subject,
      messageId: result.messageId || "",
      sentAt: now.toISOString(),
    });
  } catch (err) {
    console.error("[onboarding-mail/send-step] failed:", err);
    return res.status(500).json({ error: err?.message || "send_failed" });
  }
}
