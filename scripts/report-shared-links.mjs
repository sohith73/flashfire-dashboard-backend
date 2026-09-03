/**
 * READ ONLY. Finds job links that are generic application forms rather than
 * specific postings, and per-client duplicate links.
 *
 *   node scripts/report-shared-links.mjs [days]     # default 120
 *
 * A URL recorded under many unrelated employer names is a shared form that
 * dozens of fake listings funnel into. One such form (tally.so/r/dWpXxd) had
 * been recorded under 48 companies across 27 clients and consumed 139 real
 * applications before anyone noticed.
 *
 * Nothing is deleted. Which card to remove depends on whether an operator
 * already applied through it, so that is an ops decision.
 */
import mongoose from 'mongoose';
import { jobLinkKey, SHARED_FORM_COMPANY_LIMIT } from '../Utils/jobLinkKey.js';

const DAYS = Math.min(Math.max(parseInt(process.argv[2], 10) || 120, 1), 3650);
const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is not set. Try:\n  export $(grep -m1 ^MONGODB_URI .env)');
  process.exit(1);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 25000 });
const jobs = mongoose.connection.db.collection('jobdbs');

const since = mongoose.Types.ObjectId.createFromTime(Math.floor(Date.now() / 1000) - DAYS * 86400);
const rows = await jobs.find(
  { _id: { $gte: since } },
  { projection: { userID: 1, joblink: 1, companyName: 1, jobTitle: 1, currentStatus: 1 } }
).toArray();
console.log(`Scanned ${rows.length} jobs added in the last ${DAYS} days.\n`);

const byKey = new Map();
for (const j of rows) {
  const k = jobLinkKey(j.joblink);
  if (!k) continue;
  let e = byKey.get(k);
  if (!e) e = { n: 0, sample: j.joblink, companies: new Set(), clients: new Set(), perClient: new Map(), applied: 0 };
  e.n += 1;
  e.companies.add(String(j.companyName || '').trim().toLowerCase());
  const u = String(j.userID || '').toLowerCase();
  e.clients.add(u);
  e.perClient.set(u, (e.perClient.get(u) || 0) + 1);
  if (/appl/i.test(j.currentStatus || '')) e.applied += 1;
  byKey.set(k, e);
}

console.log(`── Shared application forms (${SHARED_FORM_COMPANY_LIMIT}+ distinct employers on one link) ──\n`);
const shared = [...byKey.values()].filter((e) => e.companies.size >= SHARED_FORM_COMPANY_LIMIT)
  .sort((a, b) => b.companies.size - a.companies.size);
if (!shared.length) {
  console.log('  none.\n');
} else {
  for (const e of shared) {
    console.log(`  ${e.companies.size} companies | ${e.n} cards | ${e.clients.size} clients | ${e.applied} ALREADY APPLIED`);
    console.log(`     ${e.sample}`);
    console.log(`     ${[...e.companies].slice(0, 10).join(' / ')}${e.companies.size > 10 ? ` (+${e.companies.size - 10})` : ''}\n`);
  }
  const wasted = shared.reduce((n, e) => n + e.applied, 0);
  console.log(`  ${shared.reduce((n, e) => n + e.n, 0)} cards on these links, ${wasted} of them already applied.\n`);
}

console.log('── Same link twice for the same client ──\n');
let groups = 0, extra = 0;
const worst = [];
for (const e of byKey.values()) {
  for (const [u, n] of e.perClient) {
    if (n > 1) { groups += 1; extra += n - 1; worst.push({ u, n, link: e.sample }); }
  }
}
console.log(`  ${groups} client+link pair(s), ${extra} redundant card(s).`);
worst.sort((a, b) => b.n - a.n);
for (const w of worst.slice(0, 15)) console.log(`    ${String(w.n).padStart(3)}x  ${w.u.padEnd(36)} ${w.link.slice(0, 60)}`);

console.log('\nNothing was deleted. Removing a card an operator already applied through');
console.log('loses that application record, so the cleanup is an ops decision.');
await mongoose.disconnect();
