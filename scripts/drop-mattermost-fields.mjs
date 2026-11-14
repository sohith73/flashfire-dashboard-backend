/**
 * Mattermost was removed as a client channel on 2026-11-14. This clears what it
 * left behind in Mongo, so the stored webhook URLs (each one is a credential
 * that can post into a client's channel) stop sitting in the database.
 *
 *   node scripts/drop-mattermost-fields.mjs           # dry run: counts only
 *   node scripts/drop-mattermost-fields.mjs --apply   # write
 *
 * What it does, in order:
 *   1. clientreminderconfigs: an item that had Mattermost on gets email on
 *      first (the same rule mergeWithDefaults applies at read time), then
 *      items.channels.mattermost and mattermostWebhookUrl are unset.
 *   2. onboardingmailstates: steps[].mattermostAt / mattermostError unset.
 *   3. maildigests: clientMattermostAt / Error / Attempts unset.
 * History rows (configs' history[].mattermost, reminderdeliveries.mattermost)
 * are kept: they are the record of what was sent at the time.
 *
 * Safe to run twice. Run it after the backend that no longer reads these
 * fields is deployed. Reads MONGODB_URI from the environment:
 *   export $(grep -E "^MONGODB_URI=" .env | xargs)
 */

import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");
const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI must be set. Try:\n  export $(grep -E "^MONGODB_URI=" .env | xargs)');
  process.exit(1);
}

await mongoose.connect(uri);
const db = mongoose.connection.db;
console.log(`${APPLY ? "APPLY" : "DRY RUN"} on database ${db.databaseName}`);

const configs = db.collection("clientreminderconfigs");
const onboarding = db.collection("onboardingmailstates");
const digests = db.collection("maildigests");

const plan = [
  {
    what: "reminder items with Mattermost on but email off (email will be switched on)",
    count: () =>
      configs.countDocuments({ items: { $elemMatch: { "channels.mattermost": true, "channels.email": { $ne: true } } } }),
    run: () =>
      configs.updateMany(
        { items: { $elemMatch: { "channels.mattermost": true, "channels.email": { $ne: true } } } },
        { $set: { "items.$[it].channels.email": true } },
        { arrayFilters: [{ "it.channels.mattermost": true }] }
      )
  },
  {
    what: "reminder configs holding a Mattermost webhook or channel flag",
    count: () =>
      configs.countDocuments({
        $or: [{ mattermostWebhookUrl: { $exists: true } }, { "items.channels.mattermost": { $exists: true } }]
      }),
    run: () =>
      configs.updateMany(
        { $or: [{ mattermostWebhookUrl: { $exists: true } }, { "items.channels.mattermost": { $exists: true } }] },
        { $unset: { mattermostWebhookUrl: "", "items.$[].channels.mattermost": "" } }
      )
  },
  {
    what: "onboarding sequences with Mattermost mirror stamps",
    count: () =>
      onboarding.countDocuments({
        $or: [{ "steps.mattermostAt": { $exists: true } }, { "steps.mattermostError": { $exists: true } }]
      }),
    run: () =>
      onboarding.updateMany(
        { $or: [{ "steps.mattermostAt": { $exists: true } }, { "steps.mattermostError": { $exists: true } }] },
        { $unset: { "steps.$[].mattermostAt": "", "steps.$[].mattermostError": "" } }
      )
  },
  {
    what: "inbox digests with Mattermost alert state",
    count: () =>
      digests.countDocuments({
        $or: [
          { clientMattermostAt: { $exists: true } },
          { clientMattermostError: { $exists: true } },
          { clientMattermostAttempts: { $exists: true } }
        ]
      }),
    run: () =>
      digests.updateMany(
        {
          $or: [
            { clientMattermostAt: { $exists: true } },
            { clientMattermostError: { $exists: true } },
            { clientMattermostAttempts: { $exists: true } }
          ]
        },
        { $unset: { clientMattermostAt: "", clientMattermostError: "", clientMattermostAttempts: "" } }
      )
  }
];

let failed = false;
for (const step of plan) {
  try {
    const n = await step.count();
    if (!APPLY || n === 0) {
      console.log(`  ${n} ${step.what}`);
      continue;
    }
    const res = await step.run();
    console.log(`  ${step.what}: matched ${res.matchedCount}, modified ${res.modifiedCount}`);
  } catch (err) {
    failed = true;
    console.error(`  FAILED: ${step.what}: ${err?.message || err}`);
  }
}

if (!APPLY) console.log("Nothing written. Re-run with --apply to clear these fields.");
await mongoose.disconnect();
process.exit(failed ? 1 : 0);
