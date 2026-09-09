#!/usr/bin/env node
// Show exactly how an IP resolves and why.
//
//   npm run geo:inspect -- 24.168.231.87
//   npm run geo:inspect -- 24.168.231.87 --refresh   # ignore the cached row
//   npm run geo:inspect -- --top 20                  # busiest IPs in the logs
//
// Use this when someone says "that location is wrong": it prints every
// provider's raw answer next to the consensus, so you can see whether the
// providers disagreed or all agreed on something wrong.
//
// Same data as GET /admin/geo/inspect/:ip — prefer the route in production,
// Render has no shell.

import dotenv from "dotenv";
import mongoose from "mongoose";
import { resolveGeo, geoStats } from "../Utils/ipGeo.js";
import { lookupOverride } from "../Utils/ipGeoOverrides.js";
import { IpGeoCache } from "../Schema_Models/IpGeoCache.js";
import { ActivityLog } from "../Schema_Models/ActivityLog.js";
import { isPublicIp } from "../Utils/clientIp.js";

dotenv.config();

const argv = process.argv.slice(2);
const REFRESH = argv.includes("--refresh");
const topIdx = argv.indexOf("--top");
const TOP = topIdx !== -1 ? Math.max(1, parseInt(argv[topIdx + 1] || "10", 10)) : 0;
// Skip the value consumed by --top, otherwise "--top 5" reads 5 as an address.
// Guard on topIdx !== -1: without it, topIdx + 1 === 0 drops the first IP.
const topValueIdx = topIdx === -1 ? -1 : topIdx + 1;
const ips = argv.filter(
  (a, i) => i !== topValueIdx && !a.startsWith("--") && /^[0-9a-f.:]+$/i.test(a) && /[.:]/.test(a)
);

async function showTop() {
  const rows = await ActivityLog.aggregate([
    { $match: { ip: { $nin: ["", null] } } },
    {
      $group: {
        _id: "$ip",
        events: { $sum: 1 },
        actors: { $addToSet: "$actor.email" },
        location: { $last: "$location" },
        confidence: { $last: "$geo.confidence" },
      },
    },
    { $sort: { events: -1 } },
    { $limit: TOP },
  ]);
  console.log(`\nBusiest IPs in activity_logs (top ${TOP}):\n`);
  for (const r of rows) {
    // Several distinct people behind one address is the signature of an office,
    // a VPN or a shared operator machine — not a client's home city.
    const shared = r.actors.length > 1 ? `  ⚠ ${r.actors.length} distinct accounts` : "";
    console.log(
      `  ${String(r._id).padEnd(40)} ${String(r.events).padStart(6)} events  ` +
        `${r.location || "(unresolved)"} [${r.confidence || "?"}]${shared}`
    );
  }
  console.log("");
}

async function showIp(ip) {
  console.log(`\n─── ${ip} ${"─".repeat(Math.max(0, 56 - ip.length))}`);
  if (!isPublicIp(ip)) {
    console.log("  not a routable public address — never geolocated");
    return;
  }

  const pinned = await lookupOverride(ip);
  if (pinned) {
    console.log(`  PINNED by override ${pinned.cidr}`);
    console.log(`    → ${pinned.label || [pinned.city, pinned.region, pinned.country].filter(Boolean).join(", ")}`);
    return;
  }

  const cached = await IpGeoCache.findOne({ ip }).lean();
  if (cached) {
    console.log(
      `  cached  ${new Date(cached.resolvedAt).toISOString()}  ` +
        `hits=${cached.lookupCount}${cached.locked ? "  LOCKED" : ""}`
    );
  } else {
    console.log("  not cached yet");
  }

  const geo = await resolveGeo(ip, { refresh: REFRESH });
  if (!geo) {
    console.log("  no provider could resolve this address");
    return;
  }

  console.log(`  result      ${geo.location}`);
  console.log(`  confidence  ${geo.confidence}  (source: ${geo.source})`);
  if (geo.confidence === "medium") {
    console.log("              providers agreed on the region but not the city,");
    console.log("              so the city is deliberately omitted");
  }
  if (geo.confidence === "low") {
    console.log("              only one provider answered — treat as a guess");
  }

  const votes = geo.votes?.length ? geo.votes : cached?.votes || [];
  if (votes.length) {
    console.log("  provider answers:");
    for (const v of votes) {
      console.log(`    ${v.provider.padEnd(10)} ${[v.city, v.region, v.countryCode].filter(Boolean).join(", ")}`);
    }
  }
  if (geo.confidence !== "high") {
    console.log("");
    console.log("  To pin this network:");
    console.log(`    POST /admin/geo/overrides`);
    console.log(
      `    ${JSON.stringify({ cidr: `${ip}/32`, city: "", region: geo.region, country: geo.country, countryCode: geo.countryCode, label: "" })}`
    );
  }
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set");
    process.exit(1);
  }
  await mongoose.connect(uri);

  if (TOP) await showTop();
  for (const ip of ips) await showIp(ip);
  if (!TOP && !ips.length) {
    console.log("usage: npm run geo:inspect -- <ip> [<ip>...] [--refresh] [--top N]");
  }

  if (ips.length) console.log(`\nresolver stats: ${JSON.stringify(geoStats())}\n`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err?.stack || err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
