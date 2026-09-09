import test from "node:test";
import assert from "node:assert/strict";

import { extractClientIp, isPrivateIp, isPublicIp, normalizeIp } from "../clientIp.js";
import { clearGeoCache, formatLocation, reachConsensus, resolveGeo } from "../ipGeo.js";
import { __setRulesForTest, matchLoaded, maskFor, parseCidr } from "../ipGeoOverrides.js";

const req = (headers = {}, extra = {}) => ({ headers, ...extra });
const vote = (provider, city, region, countryCode, extra = {}) => ({
  provider, city, region, countryCode, country: "", lat: null, lon: null, timezone: "", ...extra,
});

// ---------------------------------------------------------------- normalizeIp

test("normalizeIp unwraps IPv6-mapped IPv4, brackets, zones and ports", () => {
  assert.equal(normalizeIp("::ffff:73.223.18.221"), "73.223.18.221");
  assert.equal(normalizeIp("  1.2.3.4  "), "1.2.3.4");
  assert.equal(normalizeIp("1.2.3.4:51820"), "1.2.3.4");
  assert.equal(normalizeIp("[2001:4860:4860::8888]"), "2001:4860:4860::8888");
  assert.equal(normalizeIp("fe80::1%eth0"), "fe80::1");
  assert.equal(normalizeIp(undefined), "");
});

// --------------------------------------------------------------- private space

test("isPrivateIp covers loopback, RFC1918 and reserved v4 ranges", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.5", "172.16.0.1", "172.31.255.254", "169.254.1.1", "0.0.0.0"]) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
  assert.equal(isPrivateIp("172.15.0.1"), false);
  assert.equal(isPrivateIp("172.32.0.1"), false);
});

test("isPrivateIp rejects carrier-grade NAT, which the old check let through", () => {
  // 100.64.0.0/10 — common on mobile carriers, geolocates to the carrier core.
  assert.equal(isPrivateIp("100.64.0.1"), true);
  assert.equal(isPrivateIp("100.127.255.254"), true);
  assert.equal(isPrivateIp("100.63.255.255"), false);
  assert.equal(isPrivateIp("100.128.0.1"), false);
});

test("isPrivateIp handles IPv6 loopback, ULA and link-local", () => {
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("fd00::1"), true);
  assert.equal(isPrivateIp("fe80::1"), true);
  assert.equal(isPublicIp("2001:4860:4860::8888"), true);
});

// ------------------------------------------------------------ extractClientIp

test("extractClientIp ignores a forged leftmost X-Forwarded-For entry", () => {
  const r = req(
    { "x-forwarded-for": "8.8.8.8, 73.223.18.221" },
    { ip: "73.223.18.221", socket: { remoteAddress: "10.0.0.7" } }
  );
  assert.equal(extractClientIp(r), "73.223.18.221");
});

test("extractClientIp falls back to the rightmost public hop when req.ip is private", () => {
  const r = req(
    { "x-forwarded-for": "8.8.8.8, 24.168.231.87, 10.0.0.9" },
    { ip: "10.0.0.9", socket: { remoteAddress: "10.0.0.9" } }
  );
  assert.equal(extractClientIp(r), "24.168.231.87");
});

test("extractClientIp uses TRUSTED_CLIENT_IP_HEADER when the edge sets one", () => {
  process.env.TRUSTED_CLIENT_IP_HEADER = "cf-connecting-ip";
  try {
    const r = req({ "cf-connecting-ip": "24.168.231.87", "x-forwarded-for": "8.8.8.8" }, { ip: "10.0.0.1" });
    assert.equal(extractClientIp(r), "24.168.231.87");
  } finally {
    delete process.env.TRUSTED_CLIENT_IP_HEADER;
  }
});

test("extractClientIp ignores CDN headers unless explicitly opted in", () => {
  const r = req({ "cf-connecting-ip": "8.8.8.8" }, { ip: "24.168.231.87" });
  assert.equal(extractClientIp(r), "24.168.231.87");
});

// -------------------------------------------------------------- consensus
//
// Vote sets below are the REAL answers the three providers returned for these
// addresses; see the comments for what each one actually said.

test("consensus keeps a city two providers agree on", () => {
  // 73.223.18.221 — ip-api said Sunnyvale, the other two said San Jose.
  const g = reachConsensus([
    vote("ip-api", "Sunnyvale", "California", "US"),
    vote("ipwho.is", "San Jose", "California", "US"),
    vote("ipinfo", "San Jose", "California", "US"),
  ]);
  assert.equal(g.city, "San Jose");
  assert.equal(g.region, "California");
  assert.equal(g.confidence, "high");
  assert.equal(g.source, "consensus");
});

test("consensus drops the city when providers name three different towns", () => {
  // 24.168.231.87 — Marion SC / Charlotte NC / North Myrtle Beach SC.
  // Region has a 2-1 majority; the city has none. Asserting any one of those
  // towns would be a coin flip, so the city is omitted rather than guessed.
  const g = reachConsensus([
    vote("ip-api", "Marion", "South Carolina", "US"),
    vote("ipwho.is", "Charlotte", "North Carolina", "US"),
    vote("ipinfo", "North Myrtle Beach", "South Carolina", "US"),
  ]);
  assert.equal(g.city, "");
  assert.equal(g.region, "South Carolina");
  assert.equal(g.confidence, "medium");
  assert.equal(formatLocation({ ...g, country: "United States" }), "South Carolina, United States");
});

test("consensus treats diacritic and suffix spellings as the same city", () => {
  // 175.111.137.138 — "Sānchor" and "Sanchor" are one place; ipinfo dissents
  // with Patiala, Punjab. Normalization is what lets the two agree.
  const g = reachConsensus([
    vote("ip-api", "Sānchor", "Rajasthan", "IN"),
    vote("ipwho.is", "Sanchor", "Rajasthan", "IN"),
    vote("ipinfo", "Patiāla", "Punjab", "IN"),
  ]);
  assert.equal(g.region, "Rajasthan");
  assert.equal(g.confidence, "high");
  assert.ok(/^S[āa]nchor$/.test(g.city), g.city);
});

test("consensus marks a lone answer low confidence", () => {
  const g = reachConsensus([vote("ip-api", "Reykjavik", "Capital Region", "IS")]);
  assert.equal(g.confidence, "low");
  assert.equal(g.source, "single");
  assert.equal(g.city, "Reykjavik"); // still reported, just flagged
});

test("consensus ignores providers that disagree on the country", () => {
  const g = reachConsensus([
    vote("ip-api", "Toronto", "Ontario", "CA"),
    vote("ipwho.is", "Toronto", "Ontario", "CA"),
    vote("ipinfo", "Buffalo", "New York", "US"),
  ]);
  assert.equal(g.countryCode, "CA");
  assert.equal(g.city, "Toronto");
  assert.ok(!g.votes.some((v) => v.city === "Toronto" && v.countryCode === "US"));
  assert.equal(g.votes.length, 3, "all raw answers are still recorded for review");
});

test("consensus anchors coordinates to a provider that backed the winner", () => {
  const g = reachConsensus([
    vote("ip-api", "Sunnyvale", "California", "US", { lat: 37.37, lon: -122.03 }),
    vote("ipwho.is", "San Jose", "California", "US", { lat: 37.33, lon: -121.89 }),
    vote("ipinfo", "San Jose", "California", "US", { lat: 37.34, lon: -121.89 }),
  ]);
  // Not the midpoint of three disagreeing providers — a real San Jose fix.
  assert.equal(g.city, "San Jose");
  assert.equal(g.lat, 37.33);
});

test("consensus returns null when no provider answered", () => {
  assert.equal(reachConsensus([]), null);
  assert.equal(reachConsensus([null, null]), null);
});

// ------------------------------------------------------------- formatLocation

test("formatLocation joins present parts and collapses repeats", () => {
  assert.equal(formatLocation({ city: "Patiala", region: "Punjab", country: "India" }), "Patiala, Punjab, India");
  assert.equal(formatLocation({ city: "", region: "", country: "Nepal" }), "Nepal");
  assert.equal(formatLocation({ city: "Singapore", region: "Singapore", country: "Singapore" }), "Singapore");
  assert.equal(formatLocation(null), "");
});

test("formatLocation prefers an override label over the city line", () => {
  assert.equal(
    formatLocation({ label: "FlashFire ops office", city: "Sānchor", region: "Rajasthan", country: "India" }),
    "FlashFire ops office"
  );
});

// ---------------------------------------------------------------- overrides

test("parseCidr canonicalizes to the network address so a block is unique", () => {
  // "203.0.113.7/24" and "203.0.113.0/24" name the same block; both must
  // normalize identically or the unique index lets duplicates in.
  assert.equal(parseCidr("203.0.113.7/24").cidr, "203.0.113.0/24");
  assert.equal(parseCidr("203.0.113.0/24").cidr, "203.0.113.0/24");
  // A bare address is an implicit /32.
  assert.equal(parseCidr("203.0.113.7").cidr, "203.0.113.7/32");
  assert.equal(parseCidr("10.0.0.0/8").cidr, "10.0.0.0/8");
});

test("parseCidr rejects malformed input instead of silently matching nothing", () => {
  assert.match(parseCidr("").error, /required/);
  assert.match(parseCidr("999.1.1.1").error, /not an IPv4/);
  assert.match(parseCidr("2001:db8::1/64").error, /not an IPv4/);
  assert.match(parseCidr("10.0.0.0/33").error, /prefix length/);
  assert.match(parseCidr("10.0.0.0/abc").error, /prefix length/);
});

test("maskFor handles the /0 and /32 edges that bit-shifting gets wrong", () => {
  // `0xffffffff << 32` is 0xffffffff in JS, not 0 — /0 must be special-cased.
  assert.equal(maskFor(0), 0);
  assert.equal(maskFor(32), 0xffffffff);
  assert.equal(maskFor(24), 0xffffff00);
});

test("overrides match by longest prefix", () => {
  __setRulesForTest([
    { cidr: "203.0.113.0/24", bits: 24, base: parseCidr("203.0.113.0/24").base, city: "Wide" },
    { cidr: "203.0.113.7/32", bits: 32, base: parseCidr("203.0.113.7/32").base, city: "Narrow" },
  ]);
  assert.equal(matchLoaded("203.0.113.7").city, "Narrow", "/32 must win over the /24 it sits in");
  assert.equal(matchLoaded("203.0.113.8").city, "Wide");
  assert.equal(matchLoaded("203.0.114.1"), null, "outside the block");
  assert.equal(matchLoaded("::1"), null, "IPv6 is never matched by IPv4 rules");
  __setRulesForTest([]);
});

test("a /0 override catches everything, including the last address", () => {
  __setRulesForTest([{ cidr: "0.0.0.0/0", bits: 0, base: 0, label: "catch-all" }]);
  assert.equal(matchLoaded("8.8.8.8").label, "catch-all");
  assert.equal(matchLoaded("255.255.255.255").label, "catch-all");
  __setRulesForTest([]);
});

// -------------------------------------------------------------- resolveGeo

test("resolveGeo returns null for non-routable input without touching the network", async () => {
  clearGeoCache();
  for (const ip of ["", "127.0.0.1", "::1", "10.1.2.3", "100.70.0.1"]) {
    assert.equal(await resolveGeo(ip), null, `${ip} must not resolve`);
  }
});
