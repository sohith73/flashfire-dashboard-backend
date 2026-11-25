// Which job card an interview / assignment / offer mail is about, and where
// that card came from, for the Discord "useful mail" line.
//
// Reuses the auto-reject matcher (Utils/rejectionJobMatcher.js) read-only: it
// already pairs a mail with exactly one of the client's applied or interview
// cards, by company plus role, and says "no match" rather than guess. Nothing
// here writes. Fail-soft: any error means the line goes out without a source.

import { JobModel } from "../../Schema_Models/JobModel.js";
import { matchRejectionToJob, MATCH_STATUS } from "../../Utils/rejectionJobMatcher.js";
import { jobSourceLabel, JOB_SOURCE_FIELDS } from "../../Utils/jobSourceLabel.js";
import { mailFactsFromDigest } from "./mailAutoReject.js";

const FIELDS = `jobID jobTitle companyName currentStatus appliedDate updatedAt _id ${JOB_SOURCE_FIELDS}`;

/**
 * @param {Object} digest  MailDigest doc (lean is fine); needs ownerEmail
 * @param {Object} [opts]
 * @param {Array}  [opts.jobs]  pre-loaded cards for this client (the daily summary batches)
 * @returns {Promise<{jobTitle:string, companyName:string, source:string} | null>}
 */
export async function jobSourceForMail(digest, { jobs } = {}) {
  try {
    const owner = digest?.ownerEmail;
    if (!owner) return null;
    const cards = jobs ?? (await loadSourceCards(owner));
    const match = matchRejectionToJob(mailFactsFromDigest(digest), cards);
    if (match.status !== MATCH_STATUS.MATCHED || !match.job) return null;
    return {
      jobTitle: match.job.jobTitle || "",
      companyName: match.job.companyName || "",
      source: jobSourceLabel(match.job),
    };
  } catch (err) {
    console.warn(`[mail-job-source] digest ${digest?._id}: ${err?.message || err}`);
    return null;
  }
}

/** The client's cards the matcher can pick from, with the source fields. */
export async function loadSourceCards(ownerEmail) {
  return JobModel.find({
    userID: ownerEmail,
    currentStatus: { $not: /^\s*(deleted|removed|saved)/i },
  })
    .select(FIELDS)
    .lean();
}
