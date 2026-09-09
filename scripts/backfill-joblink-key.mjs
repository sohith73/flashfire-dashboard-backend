/**
 * Backfill `joblinkKey` on existing jobs, and report the duplicates already in
 * the collection.
 *
 *   node scripts/backfill-joblink-key.mjs            # dry run, writes nothing
 *   node scripts/backfill-joblink-key.mjs --apply    # writes the keys
 *
 * The duplicate check added to the four add paths compares `joblinkKey`, and
 * every row created before this change has none. Until they are stamped the
 * check finds nothing and duplicates keep getting through, so this is required
 * for the fix to work on existing data, not an optional cleanup.
 *
 * Writing the key is safe on its own: it only adds a derived field and never
 * deletes or merges a job. The duplicate GROUPS it reports are left alone
 * deliberately. Deciding which of five copies to keep depends on which one an
 * operator already worked, and that is an ops call, not a script's.
 *
 * Reads MONGODB_URI from the environment.
 */

import mongoose from 'mongoose';
import { jobLinkKey } from '../Utils/jobLinkKey.js';

const APPLY = process.argv.includes('--apply');
const BATCH = 1000;

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is not set. Try:\n  export $(grep -m1 ^MONGODB_URI .env)');
  process.exit(1);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
const jobs = mongoose.connection.db.collection('jobdbs');

console.log(APPLY ? '── APPLYING ──\n' : '── DRY RUN (nothing will be written) ──\n');

// ── 1. Stamp the key ────────────────────────────────────────────────────────
const total = await jobs.countDocuments({});
const missing = await jobs.countDocuments({ joblinkKey: { $in: [null, ''] } });
console.log(`${total} jobs total, ${missing} without a joblinkKey.`);

let scanned = 0, stamped = 0, noIdentity = 0;
const cursor = jobs.find(
  { joblinkKey: { $in: [null, ''] } },
  { projection: { _id: 1, joblink: 1 } }
);

let ops = [];
const flush = async () => {
  if (!ops.length) return;
  if (APPLY) await jobs.bulkWrite(ops, { ordered: false });
  ops = [];
};

while (await cursor.hasNext()) {
  const doc = await cursor.next();
  scanned += 1;
  const key = jobLinkKey(doc.joblink);
  if (!key) { noIdentity += 1; continue; }
  stamped += 1;
  ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { joblinkKey: key } } } });
  if (ops.length >= BATCH) {
    await flush();
    process.stdout.write(`\r  scanned ${scanned}/${missing}…`);
  }
}
await flush();
console.log(`\r  scanned ${scanned}, ${stamped} would get a key, ${noIdentity} have no usable link.`);

// ── 2. Report duplicates that already exist ─────────────────────────────────
// Grouped per client, because the same posting for two different clients is
// normal and must not be counted.
console.log('\n── Existing duplicate links (per client) ──');
const dupes = await jobs.aggregate([
  { $match: { joblinkKey: { $nin: [null, ''] } } },
  {
    $group: {
      _id: { user: { $toLower: '$userID' }, key: '$joblinkKey' },
      n: { $sum: 1 },
      titles: { $addToSet: '$jobTitle' },
      link: { $first: '$joblink' },
    },
  },
  { $match: { n: { $gt: 1 } } },
  { $sort: { n: -1 } },
  { $limit: 40 },
], { allowDiskUse: true }).toArray();

if (!dupes.length) {
  console.log('  none found.');
} else {
  const affected = await jobs.aggregate([
    { $match: { joblinkKey: { $nin: [null, ''] } } },
    { $group: { _id: { user: { $toLower: '$userID' }, key: '$joblinkKey' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $group: { _id: null, groups: { $sum: 1 }, extra: { $sum: { $subtract: ['$n', 1] } } } },
  ], { allowDiskUse: true }).toArray();

  const a = affected[0] || { groups: 0, extra: 0 };
  console.log(`  ${a.groups} link(s) duplicated, ${a.extra} redundant card(s). Worst 40:\n`);
  for (const d of dupes) {
    console.log(`  ${String(d.n).padStart(3)}x  ${d._id.user}`);
    console.log(`        ${d.link}`);
    console.log(`        titles: ${d.titles.slice(0, 5).join(' | ')}${d.titles.length > 5 ? ` (+${d.titles.length - 5})` : ''}`);
  }
  console.log('\n  Not removed on purpose. Which copy to keep depends on which one an');
  console.log('  operator already worked, so an operator has to make that call.');
}

if (!APPLY) console.log('\nDry run. Re-run with --apply to write the keys.');
await mongoose.disconnect();
