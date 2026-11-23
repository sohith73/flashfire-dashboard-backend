import crypto from "node:crypto";

// Key format: "ffmcp_" + 43 base64url characters (32 random bytes).
// The prefix makes a leaked key easy to recognise in a paste or a secret
// scanner, and lets the MCP route reject garbage before touching the database.
export const MCP_KEY_PREFIX = "ffmcp_";
const KEY_RE = /^ffmcp_[A-Za-z0-9_-]{43}$/;

// How many live keys one client may hold. Enough for "laptop, desktop,
// Claude Code", small enough that a forgotten key is easy to spot.
export const MAX_ACTIVE_KEYS = 5;

export function generateMcpKey() {
  return MCP_KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
}

export function isMcpKeyShape(value) {
  return typeof value === "string" && KEY_RE.test(value);
}

export function hashMcpKey(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex");
}

// What the key list shows: "ffmcp_AbCd1234…".
export function displayPrefix(key) {
  return String(key).slice(0, MCP_KEY_PREFIX.length + 8);
}

// Trim, collapse whitespace, cap length. Empty means "use the default".
export function cleanKeyName(raw) {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return name || "Claude";
}
