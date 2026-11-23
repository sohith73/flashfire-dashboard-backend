import mongoose from "mongoose";

// A client's personal key for the FlashFire MCP server (src/mcp). The client
// makes it in Profile > Connect to Claude, pastes it into Claude, and every
// tool call made with it acts as that client and nobody else.
//
// Only a SHA-256 of the key is stored. The key is 256 random bits, so a plain
// hash is enough (no salt or slow hash needed: there is nothing to brute
// force), and it lets the MCP route find the key with one indexed lookup.
// The full key is shown once, at creation, and never again.
const mcpApiKeySchema = new mongoose.Schema(
  {
    // Lowercased account email. The key acts as this client only.
    email: { type: String, required: true, index: true },
    // The client's own label, e.g. "Claude on my laptop".
    name: { type: String, required: true, maxlength: 60 },
    // First characters of the key, shown in the list so the client can tell
    // keys apart without the key itself ever leaving the server again.
    prefix: { type: String, required: true },
    keyHash: { type: String, required: true, unique: true },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const McpApiKey = mongoose.model("mcpapikeys", mcpApiKeySchema);
