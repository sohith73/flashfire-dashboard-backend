#!/usr/bin/env node
// Re-resolve activity_logs.location through the consensus resolver.
//
//   npm run backfill:location -- --dry-run          # report only
//   npm run backfill:location                       # fill rows with no geo
//   npm run backfill:location -- --force            # re-resolve EVERY row
//   npm run backfill:location -- --since 2026-07-01 # bound by date
//   npm run backfill:location -- --throttle 2000    # ms between NEW lookups
//
// Identical to POST /admin/geo/backfill — both call runLocationBackfill().
// Prefer the route in production; Render has no shell.

import dotenv from "dotenv";
import mongoose from "mongoose";
import { runLocationBackfill } from "../Utils/locationBackfill.js";
import { refreshOverrides } from "../Utils/ipGeoOverrides.js";
import { geoStats } from "../Utils/ipGeo.js";

dotenv.config();

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i !== -1 ? argv[i + 1] : undefined;
};

function log(...a) {
  console.log("[backfill:location]", ...a);
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("[backfill:location] MONGODB_URI is not set");
    process.exit(1);
  }
  await mongoose.connect(uri);
  log("connected to mongo");
  await refreshOverrides();

  let lastScanned = 0;
  const result = await runLocationBackfill({
    dryRun: has("--dry-run"),
    force: has("--force"),
    since: valueOf("--since"),
    throttleMs: valueOf("--throttle") === undefined ? undefined : Number(valueOf("--throttle")),
    batch: Number(valueOf("--batch")) || undefined,
    limit: Number(valueOf("--limit")) || undefined,
    onProgress: (p) => {
      if (p.scanned - lastScanned >= 500 && !p.done) {
        lastScanned = p.scanned;
        log(`  …${p.scanned}/${p.total} (${p.distinctIps} distinct IPs)`);
      }
    },
  });

  for (const s of result.samples) {
    log(`  ${s.ip}: "${s.from}" → "${s.to}" [${s.confidence}]`);
  }
  log(
    `done — scanned ${result.scanned}, resolved ${result.resolved}, ` +
      `unresolvable ${result.unresolvable}, display string changed on ${result.changed}, ` +
      `distinct IPs ${result.distinctIps}, rows written ${result.written}` +
      (result.dryRun ? " (dry run — nothing written)" : "")
  );
  log(`resolver: ${JSON.stringify(geoStats())}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("[backfill:location]", err?.stack || err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
