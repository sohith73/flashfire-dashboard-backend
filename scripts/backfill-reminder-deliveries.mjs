/**
 * Copy the reminder history embedded in each ClientReminderConfig (newest 50
 * rows per client) into the ReminderDelivery log, so Operations > Reminders >
 * Delivery history shows the weeks before the log existed.
 *
 *   node scripts/backfill-reminder-deliveries.mjs           # dry run
 *   node scripts/backfill-reminder-deliveries.mjs --apply   # write
 *
 * Idempotent: rows are upserted on (clientEmail, itemKey, at), the log's
 * unique key, so running it twice, or after the worker has started writing,
 * never duplicates a row. Reads MONGODB_URI from the environment:
 *   export $(grep -E "^MONGODB_URI=" .env | xargs)
 */

import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");
const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI must be set. Try:\n  export $(grep -E "^MONGODB_URI=" .env | xargs)');
  process.exit(1);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
const db = mongoose.connection.db;
console.log(APPLY ? "── APPLYING ──\n" : "── DRY RUN (nothing will be written) ──\n");

const configs = await db
  .collection("clientreminderconfigs")
  .find({ "history.0": { $exists: true } }, { projection: { clientEmail: 1, clientName: 1, history: 1 } })
  .toArray();

const ops = [];
for (const c of configs) {
  const clientEmail = String(c.clientEmail || "").toLowerCase().trim();
  for (const h of c.history || []) {
    const at = h?.at ? new Date(h.at) : null;
    if (!clientEmail || !h?.itemKey || !h?.status || !at || Number.isNaN(at.getTime())) continue;
    ops.push({
      updateOne: {
        filter: { clientEmail, itemKey: h.itemKey, at },
        update: {
          $setOnInsert: {
            clientEmail,
            clientName: String(c.clientName || ""),
            itemKey: h.itemKey,
            periodKey: String(h.periodKey || ""),
            trigger: String(h.trigger || "cron"),
            status: h.status,
            // The embedded rows never stored the reason or the subject.
            reason: "",
            subject: "",
            email: {
              attempted: h.email?.attempted === true,
              ok: h.email?.ok === true,
              to: String(h.email?.to || ""),
              error: String(h.email?.error || "")
            },
            mattermost: {
              attempted: h.mattermost?.attempted === true,
              ok: h.mattermost?.ok === true,
              error: String(h.mattermost?.error || "")
            },
            stats: { added: Number(h.stats?.added) || 0, applied: Number(h.stats?.applied) || 0 },
            at
          }
        },
        upsert: true
      }
    });
  }
}

console.log(`${configs.length} config(s) with history, ${ops.length} row(s) to copy.`);

if (APPLY && ops.length) {
  // The unique index has to exist before the upserts, or a re-run could race
  // itself into duplicates. createIndex is a no-op when it is already there.
  await db.collection("reminderdeliveries").createIndex({ clientEmail: 1, itemKey: 1, at: 1 }, { unique: true });
  let inserted = 0;
  for (let i = 0; i < ops.length; i += 500) {
    const res = await db.collection("reminderdeliveries").bulkWrite(ops.slice(i, i + 500), { ordered: false });
    inserted += res.upsertedCount || 0;
  }
  console.log(`${inserted} row(s) inserted, ${ops.length - inserted} already present.`);
} else if (!APPLY) {
  console.log("Re-run with --apply to write.");
}

await mongoose.disconnect();
