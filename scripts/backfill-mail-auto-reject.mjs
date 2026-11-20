/**
 * Backfill: move job cards to Rejected for genuine rejection mails that arrived
 * before the live auto-reject existed (or while MAIL_AUTO_REJECT was off).
 *
 *   node scripts/backfill-mail-auto-reject.mjs                       # dry run, writes NOTHING
 *   node scripts/backfill-mail-auto-reject.mjs --since=2026-10-01    # only digests from that day on
 *   node scripts/backfill-mail-auto-reject.mjs --client=a@b.com      # one client
 *   node scripts/backfill-mail-auto-reject.mjs --limit=500 --sample=20 [--random] [--verbose]
 *   node scripts/backfill-mail-auto-reject.mjs --apply               # actually move cards
 *
 * Uses the same gate, matcher and atomic apply as the live poller
 * (src/services/mailAutoReject.js), so a backfill and the poller can run side by
 * side without double-applying: each digest is claimed once.
 *
 * Digests written before the verifier returned company/jobTitle have no such
 * fields. They are NOT sent back to GPT: the digest keeps no mail body, so a
 * second call would only re-read the same stored summary, and it would cost
 * money and send client mail text to a third party for no new information. The
 * matcher instead extracts company and role from sender, subject and summary
 * with patterns, and cross-checks them against each job's own company name.
 *
 * Reads MONGODB_URI from the environment. Prints no email addresses.
 */

import mongoose from "mongoose";
import { MailDigest } from "../Schema_Models/MailDigest.js";
import { autoRejectForDigest, loadCandidateJobs, autoRejectGate } from "../src/services/mailAutoReject.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  })
);
const APPLY = args.apply === true;
const since = args.since ? new Date(`${args.since}T00:00:00.000Z`) : null;
const client = args.client ? String(args.client).trim().toLowerCase() : null;
const limit = args.limit ? Number(args.limit) : 0;
const sampleSize = args.sample ? Number(args.sample) : 12;

if (since && Number.isNaN(since.getTime())) {
  console.error("--since must be YYYY-MM-DD");
  process.exit(1);
}
const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set. Try:\n  export $(grep -m1 ^MONGODB_URI .env)");
  process.exit(1);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
console.log(APPLY ? "-- APPLYING --\n" : "-- DRY RUN (nothing will be written) --\n");

const filter = {
  category: "rejection",
  verifyGenuine: true,
  verifyConfidence: { $in: ["high", "medium"] },
  autoRejectStatus: { $in: ["", null] }
};
if (since) filter.date = { $gte: since };
if (client) filter.ownerEmail = client;

let q = MailDigest.find(filter)
  .select("ownerEmail from subject summary snippet urls date internalDate category verifyRan verifyGenuine verifyCategory verifyConfidence verifyCompany verifyJobTitle autoRejectStatus")
  .sort({ ownerEmail: 1, date: 1 }) // oldest first within a client: the first rejection takes the card
  .lean();
if (limit) q = q.limit(limit);
const digests = await q;

const counts = { matched: 0, applied: 0, ambiguous: 0, no_match: 0, skipped: 0, already_handled: 0, error: 0 };
const seen = {};
const samples = { matched: [], ambiguous: [], no_match: [] };
const clientIds = new Map();
const owners = new Set();
const cid = (e) => {
  if (!clientIds.has(e)) clientIds.set(e, `client#${clientIds.size + 1}`);
  return clientIds.get(e);
};

let jobsCache = { owner: null, jobs: [] };
for (const d of digests) {
  if (!autoRejectGate(d).ok) {
    counts.skipped++;
    continue;
  }
  owners.add(d.ownerEmail);
  if (jobsCache.owner !== d.ownerEmail) jobsCache = { owner: d.ownerEmail, jobs: await loadCandidateJobs(d.ownerEmail) };
  const jobs = jobsCache.jobs;

  const r = await autoRejectForDigest(d, { dryRun: !APPLY, jobs });
  const key = r.outcome === "applied" ? "applied" : r.outcome;
  counts[key] = (counts[key] || 0) + 1;

  const hit = r.outcome === "matched" || r.outcome === "applied";
  if (hit) {
    counts.matched += r.outcome === "applied" ? 1 : 0; // dry run already counted as "matched"
    // Reflect the move in the cached cards (a dry run too), so a later mail from
    // the same employer sees it as recently rejected, exactly as the live poller would.
    const idx = jobsCache.jobs.findIndex((j) => j.jobID === r.match.jobId);
    if (idx >= 0) {
      const when = d.date ? new Date(d.date).toISOString() : new Date().toISOString();
      jobsCache.jobs[idx] = { ...jobsCache.jobs[idx], currentStatus: "rejected by Mail", updatedAt: when };
    }
  }
  const bucket = hit ? "matched" : r.outcome;
  if (samples[bucket]) {
    seen[bucket] = (seen[bucket] || 0) + 1;
    // Reservoir sampling with --random (an unbiased sample to judge precision by);
    // otherwise the first N.
    const slot = samples[bucket].length < sampleSize ? samples[bucket].length : args.random ? Math.floor(Math.random() * seen[bucket]) : -1;
    if (slot >= 0 && slot < sampleSize) samples[bucket][slot] =({
      who: cid(d.ownerEmail),
      subject: String(d.subject || "").slice(0, 90),
      job: r.match?.job ? `${r.match.job.companyName} | ${r.match.job.jobTitle} | ${r.match.job.currentStatus}` : null,
      reason: r.reason,
      candidates: (r.match?.candidates || []).slice(0, 4).map((c) => `${c.companyName} | ${c.jobTitle} (${c.companyLevel}, role ${c.roleScore})`),
      summary: args.verbose ? String(d.summary || "").slice(0, 220) : ""
    });
  }
}

console.log(`Digests considered: ${digests.length}${since ? ` since ${args.since}` : ""}${client ? " (one client)" : ""}`);
console.log(`Clients: ${owners.size}`);
console.log(APPLY ? "Outcome counts:" : "Outcome counts (dry run; 'matched' = would be moved):");
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(16)} ${v}`);

for (const bucket of ["matched", "ambiguous", "no_match"]) {
  if (!samples[bucket].length) continue;
  console.log(`\nSample ${bucket} (${samples[bucket].length}):`);
  for (const s of samples[bucket]) {
    console.log(`  [${s.who}] mail: "${s.subject}"`);
    if (s.job) console.log(`      job:  ${s.job}`);
    console.log(`      why:  ${s.reason}`);
    if (s.summary) console.log(`      mail summary: ${s.summary}`);
    if (!s.job && s.candidates.length) console.log(`      cands: ${s.candidates.join("  ;  ")}`);
  }
}

await mongoose.disconnect();
