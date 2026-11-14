// Cover letter queue: the Mongo filters and updates behind
// JobModel.coverLetterOptimization, kept pure so the rules are unit-testable.
//
// It rides on the auto-optimization worker (src/services/autoOptimizationWorker.js):
// resume jobs are always claimed first, and a cover letter job is claimed only
// when no resume job is claimable. Same pattern as the resume path: atomic
// findOneAndUpdate claim, 3 attempts, backoff 1/2/4 min, stale recovery.
// Nothing here ever writes autoOptimization or optimizedResume.
//
// A job card is enqueued (status pending, attempts 0) when:
//   a) the worker saves its optimized resume, and the client is Executive with a base letter
//   b) an operator saves a new base letter: every saved card with an optimized
//      resume whose letter was written from a different base (newest 500)
//   c) an optimized resume is saved by hand (saveChangedSession), same rule as (a)

export const COVER_LETTER_MAX_ATTEMPTS = 3;
export const COVER_LETTER_STALE_MS = 5 * 60 * 1000;
export const REQUEUE_CAP = 500;

const P = "coverLetterOptimization";

/** $set that puts a card in the queue from scratch. */
export function enqueueUpdate() {
  return {
    $set: {
      [`${P}.status`]: "pending",
      [`${P}.attempts`]: 0,
      [`${P}.startedAt`]: null,
      [`${P}.completedAt`]: null,
      [`${P}.lastFailedAt`]: null,
      [`${P}.retryAfter`]: null,
      [`${P}.error`]: null,
    },
  };
}

/**
 * (b) Cards to requeue after a base letter save: this client's saved cards
 * with an optimized resume whose letter was not written from `hash`.
 * Run with sort {_id:-1} and limit REQUEUE_CAP.
 */
export function requeueFilter(emails, hash) {
  return {
    userID: { $in: emails },
    currentStatus: "saved",
    "optimizedResume.hasResume": true,
    "optimizedCoverLetter.baseHash": { $ne: hash },
  };
}

/** Claim filter: pending, attempts left, backoff over, resume present. */
export function claimFilter(now = new Date()) {
  return {
    [`${P}.status`]: "pending",
    [`${P}.attempts`]: { $lt: COVER_LETTER_MAX_ATTEMPTS },
    "optimizedResume.hasResume": true,
    // `null` also matches a missing field.
    $or: [{ [`${P}.retryAfter`]: null }, { [`${P}.retryAfter`]: { $lte: now } }],
  };
}

export function claimUpdate(now = new Date()) {
  return {
    $set: { [`${P}.status`]: "processing", [`${P}.startedAt`]: now },
    $inc: { [`${P}.attempts`]: 1 },
  };
}

// Newest cards first: those are the ones a client is about to apply to.
export const CLAIM_SORT = { _id: -1 };

/** $set after a failed attempt: retry with backoff, or failed for good. */
export function failureUpdate(errorMessage, attempts, now = new Date()) {
  const set = {
    [`${P}.error`]: String(errorMessage || "unknown error").slice(0, 500),
    [`${P}.lastFailedAt`]: now,
  };
  if (attempts >= COVER_LETTER_MAX_ATTEMPTS) {
    set[`${P}.status`] = "failed";
  } else {
    const backoffMinutes = Math.pow(2, Math.max(0, attempts - 1)); // 1, 2, 4 min
    set[`${P}.status`] = "pending";
    set[`${P}.retryAfter`] = new Date(now.getTime() + backoffMinutes * 60 * 1000);
  }
  return { $set: set };
}

export function skippedUpdate(reason, now = new Date()) {
  return {
    $set: {
      [`${P}.status`]: "skipped",
      [`${P}.error`]: String(reason || "").slice(0, 500),
      [`${P}.completedAt`]: now,
    },
  };
}

export function staleFilter(now = new Date()) {
  return {
    [`${P}.status`]: "processing",
    [`${P}.startedAt`]: { $lt: new Date(now.getTime() - COVER_LETTER_STALE_MS) },
  };
}

export function staleRecoveryUpdate() {
  return {
    $set: {
      [`${P}.status`]: "pending",
      [`${P}.error`]: "Recovered from stale processing state (worker restart)",
    },
  };
}

/**
 * $set after a letter is saved. `previousVersion` is the card's
 * optimizedCoverLetter.version at claim time.
 */
export function completedLetterSet({ dataKey, previousVersion, baseHash, model, now = new Date() }) {
  return {
    optimizedCoverLetter: {
      dataKey,
      hasLetter: true,
      version: (Number(previousVersion) || 0) + 1,
      createdAt: now,
      baseHash,
      model,
    },
  };
}

export function completedStatusSet(now = new Date()) {
  return {
    [`${P}.status`]: "completed",
    [`${P}.completedAt`]: now,
    [`${P}.error`]: null,
  };
}

/**
 * Which queue the worker takes from next. Resume jobs always win; a cover
 * letter job is claimed only when no resume job is claimable.
 * Resolves to { kind: "resume" | "cover-letter", job } or null.
 */
export async function claimNextWork({ claimResume, claimCoverLetter }) {
  const resume = await claimResume();
  if (resume) return { kind: "resume", job: resume };
  const letter = await claimCoverLetter();
  if (letter) return { kind: "cover-letter", job: letter };
  return null;
}

/** Stats for the Operations tab card, from three counts. */
export function statsFilters(emails) {
  const base = { userID: { $in: emails } };
  return {
    optimized: { ...base, "optimizedCoverLetter.hasLetter": true },
    pending: { ...base, [`${P}.status`]: { $in: ["pending", "processing"] } },
    failed: { ...base, [`${P}.status`]: "failed" },
  };
}
