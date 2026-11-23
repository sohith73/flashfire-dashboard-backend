// A client's keys for the FlashFire MCP server.
//
//   GET    /mcp-keys        list this client's live keys (never the key itself)
//   POST   /mcp-keys        { name } -> the new key, shown this once
//   DELETE /mcp-keys/:id    revoke one; Claude loses access on its next call
//
// All three sit behind LocalTokenValidator and take the client from the
// verified token only. An operator viewing a client from Operations gets 403:
// a key is the client's own login to their data, so only the client makes one.

import mongoose from "mongoose";
import { McpApiKey } from "../Schema_Models/McpApiKey.js";
import { findClientUser } from "../src/mcp/clientUser.js";
import { isOperatorView, normalizeEmail } from "../Utils/AuthToken.js";
import {
  MAX_ACTIVE_KEYS,
  generateMcpKey,
  hashMcpKey,
  displayPrefix,
  cleanKeyName,
} from "../Utils/mcpApiKey.js";

const publicKey = (doc) => ({
  id: String(doc._id),
  name: doc.name,
  prefix: doc.prefix,
  createdAt: doc.createdAt,
  lastUsedAt: doc.lastUsedAt || null,
});

// The client's email when the caller is the client themself, else sends the
// refusal and returns null.
async function clientEmail(req, res) {
  const email = normalizeEmail(req.authEmail || req.user?.email);
  if (!email) {
    res.status(401).json({ error: "unauthorized", message: "Sign in again." });
    return null;
  }
  if (isOperatorView(req.user)) {
    res.status(403).json({
      error: "client_only",
      message: "Only the client can create Claude keys, from their own login.",
    });
    return null;
  }
  const user = await findClientUser(email, "_id");
  if (!user) {
    res.status(403).json({ error: "client_only", message: "This account is not a client account." });
    return null;
  }
  return email;
}

export async function listMcpKeys(req, res) {
  try {
    const email = await clientEmail(req, res);
    if (!email) return;
    const keys = await McpApiKey.find({ email, revokedAt: null }).sort({ createdAt: -1 }).lean();
    res.set("Cache-Control", "no-store");
    return res.status(200).json({ keys: keys.map(publicKey), max: MAX_ACTIVE_KEYS });
  } catch (err) {
    console.error("[mcp-keys] list failed:", err?.message || err);
    return res.status(500).json({ error: "mcp_keys_failed", message: "Could not load your keys." });
  }
}

export async function createMcpKey(req, res) {
  try {
    const email = await clientEmail(req, res);
    if (!email) return;

    const active = await McpApiKey.countDocuments({ email, revokedAt: null });
    if (active >= MAX_ACTIVE_KEYS) {
      return res.status(409).json({
        error: "too_many_keys",
        message: `You already have ${MAX_ACTIVE_KEYS} keys. Revoke one you no longer use, then try again.`,
      });
    }

    const key = generateMcpKey();
    const doc = await McpApiKey.create({
      email,
      name: cleanKeyName(req.body?.name),
      prefix: displayPrefix(key),
      keyHash: hashMcpKey(key),
    });

    // Two tabs creating at once can both pass the count above. Re-count after
    // the insert and take back our own key if it went over the limit.
    const after = await McpApiKey.countDocuments({ email, revokedAt: null });
    if (after > MAX_ACTIVE_KEYS) {
      await McpApiKey.deleteOne({ _id: doc._id });
      return res.status(409).json({
        error: "too_many_keys",
        message: `You already have ${MAX_ACTIVE_KEYS} keys. Revoke one you no longer use, then try again.`,
      });
    }

    res.set("Cache-Control", "no-store");
    return res.status(201).json({ ...publicKey(doc.toObject()), key });
  } catch (err) {
    console.error("[mcp-keys] create failed:", err?.message || err);
    return res.status(500).json({ error: "mcp_keys_failed", message: "Could not create a key." });
  }
}

export async function revokeMcpKey(req, res) {
  try {
    const email = await clientEmail(req, res);
    if (!email) return;
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: "not_found", message: "Key not found." });
    }
    const doc = await McpApiKey.findOneAndUpdate(
      { _id: id, email, revokedAt: null },
      { $set: { revokedAt: new Date() } },
      { new: true }
    ).lean();
    if (!doc) {
      return res.status(404).json({ error: "not_found", message: "Key not found." });
    }
    return res.status(200).json({ ok: true, id: String(doc._id) });
  } catch (err) {
    console.error("[mcp-keys] revoke failed:", err?.message || err);
    return res.status(500).json({ error: "mcp_keys_failed", message: "Could not revoke the key." });
  }
}
