// mailAutoReject - move a client's job card to Rejected when their inbox gets a
// genuine rejection mail that singles out exactly that card.
//
// Nothing else in the mail pipeline writes JobModel (interview and offer mail do
// not move cards either), so this is the one place a mail touches a job. Because
// of that it is deliberately conservative and fully auditable:
//
//   - Utils/rejectionJobMatcher.js decides WHICH card, and only ever says
//     "matched" for a single confident candidate (precision over recall).
//   - The digest is CLAIMED first with an atomic conditional update, so one mail
//     can never be applied twice, even across racing workers, retries or a
//     backfill running alongside the poller. A crash after the claim leaves the
//     digest on "claimed" and nothing is retried: a missed rejection is cheap,
//     a duplicate or wrong one is not.
//   - The job write is an atomic conditional update whose filter re-checks that
//     the card still has the exact status the matcher read, so a client moving
//     the card meanwhile wins.
//   - Every outcome, including no_match, is written to the digest
//     (autoReject* fields) with the previous card status for a manual revert.
//   - FAIL-SOFT: nothing here throws. The poll must never break on this.
//
// Kill switch: MAIL_AUTO_REJECT=off (also 0, false, no, disabled). Default ON.

import { JobModel } from "../../Schema_Models/JobModel.js";
import { MailDigest } from "../../Schema_Models/MailDigest.js";
import { matchRejectionToJob, MATCH_STATUS } from "../../Utils/rejectionJobMatcher.js";

/** Actor suffix on the card, in the same "<status> by <who>" shape as manual moves. */
export const AUTO_REJECT_STATUS = "rejected by Mail";
const TIMEZONE = "Asia/Kolkata";

export function isAutoRejectEnabled(env = process.env) {
  const v = String(env.MAIL_AUTO_REJECT ?? "").trim().toLowerCase();
  return !["off", "0", "false", "no", "disabled"].includes(v);
}

/**
 * Gate: only a verified, at-least-medium-confidence genuine rejection may move a card.
 * @returns {{ok:boolean, reason:string}}
 */
export function autoRejectGate(digest) {
  if (!digest) return { ok: false, reason: "no digest" };
  if (digest.category !== "rejection") return { ok: false, reason: "not a rejection digest" };
  if (digest.verifyRan !== true || digest.verifyGenuine !== true) return { ok: false, reason: "rejection not verified genuine" };
  if (digest.verifyCategory && digest.verifyCategory !== "rejection") return { ok: false, reason: "verifier category is not rejection" };
  if (digest.verifyConfidence === "low" || !digest.verifyConfidence) return { ok: false, reason: "verifier confidence is low" };
  if (!digest.ownerEmail) return { ok: false, reason: "digest has no client" };
  return { ok: true, reason: "" };
}

/** Facts the matcher reads off a digest (stored fields only; no body is kept). */
export function mailFactsFromDigest(d) {
  return {
    from: d.from,
    subject: d.subject,
    summary: d.summary,
    snippet: d.snippet,
    urls: d.urls,
    date: d.date || (d.internalDate ? new Date(d.internalDate) : null),
    company: d.verifyCompany,
    jobTitle: d.verifyJobTitle
  };
}

const JOB_FIELDS = "jobID jobTitle companyName currentStatus appliedDate updatedAt _id";

/** The client's live-ish cards. Eligibility (applied / interview only) is decided in the matcher. */
export async function loadCandidateJobs(ownerEmail) {
  return JobModel.find({
    userID: ownerEmail,
    // Rejected cards are loaded too: the matcher uses recent ones as a guard.
    currentStatus: { $not: /^\s*(deleted|removed|saved)/i }
  })
    .select(JOB_FIELDS)
    .lean();
}

const nowIST = () => new Date().toLocaleString("en-IN", { timeZone: TIMEZONE });

async function record(digestId, fields) {
  await MailDigest.updateOne({ _id: digestId }, { $set: { ...fields, autoRejectAt: new Date() } });
}

/**
 * Evaluate one digest and (unless dryRun) apply the move.
 *
 * @param {Object} digest  MailDigest doc or lean object
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun]  match only; write nothing (no claim, no job update)
 * @param {Array}  [opts.jobs]     pre-loaded candidate jobs (backfill batches them per client)
 * @returns {Promise<{outcome:string, reason:string, match?:Object}>}
 *   outcome: applied | matched (dry run) | ambiguous | no_match | skipped | already_handled | error
 */
export async function autoRejectForDigest(digest, { dryRun = false, jobs } = {}) {
  try {
    if (!isAutoRejectEnabled()) return { outcome: "skipped", reason: "MAIL_AUTO_REJECT is off" };
    const gate = autoRejectGate(digest);
    if (!gate.ok) return { outcome: "skipped", reason: gate.reason };
    if (digest.autoRejectStatus) return { outcome: "already_handled", reason: digest.autoRejectStatus };

    const candidateJobs = jobs ?? (await loadCandidateJobs(digest.ownerEmail));
    const match = matchRejectionToJob(mailFactsFromDigest(digest), candidateJobs);

    if (dryRun) {
      return { outcome: match.status === MATCH_STATUS.MATCHED ? "matched" : match.status, reason: match.reason, match };
    }

    // Claim the digest. Whoever flips "" -> "claimed" owns this mail forever.
    const claim = await MailDigest.updateOne(
      { _id: digest._id, $or: [{ autoRejectStatus: "" }, { autoRejectStatus: { $exists: false } }] },
      { $set: { autoRejectStatus: "claimed" } }
    );
    if (!claim.modifiedCount) return { outcome: "already_handled", reason: "claimed elsewhere" };

    if (match.status !== MATCH_STATUS.MATCHED) {
      await record(digest._id, { autoRejectStatus: match.status, autoRejectReason: match.reason.slice(0, 300) });
      return { outcome: match.status, reason: match.reason, match };
    }

    const job = match.job;
    const at = nowIST();
    // The filter pins the exact status the matcher read: if the client (or an
    // operator) moved the card in the meantime, nothing is written.
    const res = await JobModel.updateOne(
      { jobID: job.jobID, userID: digest.ownerEmail, currentStatus: job.currentStatus },
      { $set: { currentStatus: AUTO_REJECT_STATUS, updatedAt: at }, $push: { timeline: AUTO_REJECT_STATUS } }
    );
    if (!res.modifiedCount) {
      await record(digest._id, {
        autoRejectStatus: "skipped",
        autoRejectJobId: job.jobID,
        autoRejectReason: "card changed before the update; left alone"
      });
      return { outcome: "skipped", reason: "card changed before the update", match };
    }
    await record(digest._id, {
      autoRejectStatus: "applied",
      autoRejectJobId: job.jobID,
      autoRejectPreviousStatus: job.currentStatus,
      autoRejectReason: match.reason.slice(0, 300)
    });
    return { outcome: "applied", reason: match.reason, match };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 300);
    console.warn(`[mail-auto-reject] digest ${digest?._id}: ${msg}`);
    if (!dryRun && digest?._id) {
      try {
        await MailDigest.updateOne({ _id: digest._id }, { $set: { autoRejectStatus: "error", autoRejectReason: msg, autoRejectAt: new Date() } });
      } catch (e2) {
        console.warn(`[mail-auto-reject] could not record error for ${digest._id}: ${e2?.message || e2}`);
      }
    }
    return { outcome: "error", reason: msg };
  }
}
