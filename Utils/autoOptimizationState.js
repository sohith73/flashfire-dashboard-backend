// The autoOptimization state a new job card starts with.
//
// The background worker (src/services/autoOptimizationWorker.js) only claims
// jobs whose status is "pending". A card created without this field defaults
// to status null and is never optimized, which is what happened to every Job
// API push (Adzuna, hiring.cafe, Glassdoor, Indeed) from 2026-10-23 until this
// helper was used there too. Every path that creates a job must use it.

/**
 * @param {string|null|undefined} jobDescription
 * @returns {{ status: "pending"|"skipped", attempts: 0, error?: string }}
 */
export function initialAutoOptimization(jobDescription) {
  if (String(jobDescription ?? "").trim()) return { status: "pending", attempts: 0 };
  return { status: "skipped", attempts: 0, error: "Skipped: missing job description" };
}
