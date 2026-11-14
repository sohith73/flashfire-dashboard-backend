/**
 * Copy the European sponsor list (IND register + Irish permit holders) into
 * the `euvisasponsors` collection (Schema_Models/EuVisaSponsorModel.js), for
 * querying from Mongo. The push gate reads the same file in memory instead.
 *
 *   node scripts/import-eu-visa-sponsors.mjs            # dry run, writes nothing
 *   node scripts/import-eu-visa-sponsors.mjs --apply    # upsert + prune + indexes
 *   node scripts/import-eu-visa-sponsors.mjs --apply --file=/path/eu-visa-sponsors.json.gz
 *
 * The file is data/eu-visa-sponsors.json.gz, built by DASH/eu-visa-sponsors/refresh.sh.
 * --apply builds the indexes first, upserts every sponsor by country + nameKey stamped
 * with the file's builtAt, then deletes rows from older builds (an employer
 * that fell off its list). The prune is skipped if fewer rows were written
 * than the file holds, so a half-finished import never empties the table.
 *
 * Reads MONGODB_URI from the environment, or --uri-file=<path>.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { EuVisaSponsorModel } from "../Schema_Models/EuVisaSponsorModel.js";
import { euNameKeys } from "../Utils/euVisaSponsor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const APPLY = process.argv.includes("--apply");
const FILE = arg("file") || path.resolve(here, "../data/eu-visa-sponsors.json.gz");
const BATCH = 2000;

const uriFile = arg("uri-file");
const uri = uriFile ? fs.readFileSync(uriFile, "utf8").trim() : process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set (or pass --uri-file=<path>).");
  process.exit(1);
}
if (!fs.existsSync(FILE)) {
  console.error(`No sponsor file at ${FILE}. Build it with DASH/eu-visa-sponsors/refresh.sh`);
  process.exit(1);
}

const { meta, rows } = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)).toString("utf8"));
if (!meta?.builtAt || !Array.isArray(rows) || rows.length < 1000) {
  console.error(`Refusing ${FILE}: no builtAt or only ${rows?.length ?? 0} rows - looks truncated.`);
  process.exit(1);
}

const importedAt = new Date();
const byKey = new Map();
for (const [name, country, kvk, permits = {}] of rows) {
  const nameKey = String(name).trim().toLowerCase().replace(/\s+/g, " ");
  byKey.set(`${country}|${nameKey}`, {
    nameKey,
    name,
    country,
    matchKeys: euNameKeys(name),
    kvk: kvk || null,
    permits,
    permitsTotal: Object.values(permits).reduce((a, b) => a + (Number(b) || 0), 0),
    buildId: meta.builtAt,
    importedAt,
  });
}
const docs = [...byKey.values()];

console.log(`file:      ${FILE}`);
console.log(`built:     ${meta.builtAt}  sponsors: ${docs.length}`);
for (const [code, s] of Object.entries(meta.countries || {})) console.log(`  ${code.padEnd(4)} ${s.sponsors} as at ${s.asOf}  ${s.label}`);

await mongoose.connect(uri, { serverSelectionTimeoutMS: 25000 });
const db = mongoose.connection.db;
console.log(`database:  ${db.databaseName}`);
console.log(`existing:  ${await EuVisaSponsorModel.estimatedDocumentCount()} rows`);

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to write.");
  await mongoose.disconnect();
  process.exit(0);
}

const t0 = Date.now();
await EuVisaSponsorModel.createIndexes();
let upserted = 0, modified = 0, written = 0;
for (let i = 0; i < docs.length; i += BATCH) {
  const batch = docs.slice(i, i + BATCH);
  const r = await EuVisaSponsorModel.bulkWrite(batch.map((d) => ({
    updateOne: { filter: { country: d.country, nameKey: d.nameKey }, update: { $set: d }, upsert: true },
  })), { ordered: false });
  upserted += r.upsertedCount; modified += r.modifiedCount; written += batch.length;
  console.log(`  written   ${written}/${docs.length}`);
}
console.log(`  upserted ${upserted}, updated ${modified}`);

const current = await EuVisaSponsorModel.countDocuments({ buildId: meta.builtAt });
if (current >= docs.length) {
  const pruned = await EuVisaSponsorModel.deleteMany({ buildId: { $ne: meta.builtAt } });
  console.log(`  pruned ${pruned.deletedCount} rows from older builds`);
} else {
  console.warn(`  NOT pruning: only ${current}/${docs.length} rows carry this build`);
}
console.log(`done:      ${await EuVisaSponsorModel.estimatedDocumentCount()} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await mongoose.disconnect();
