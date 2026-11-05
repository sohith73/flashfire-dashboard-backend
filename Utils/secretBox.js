// Authenticated encryption for secrets we must be able to read back, such as a
// client's Gmail app password (IMAP + SMTP need the plaintext at use time, so
// hashing is not an option).
//
// AES-256-GCM, not the CBC in CryptoHelper.js: GCM authenticates the
// ciphertext, so a tampered or truncated value fails loudly instead of
// decrypting to garbage.
//
// No new env var. The key is derived with HKDF from the existing
// CRYPTO_AES_SECRET_SECRET_KEY, under a purpose label, so it is a different key
// from the one CryptoHelper uses and the two can never be confused.
//
// Each value is bound to a context string (the owner's email) as additional
// authenticated data. A ciphertext copied onto another client's row will not
// decrypt there.
//
// Stored format: "v1:<iv>:<tag>:<ciphertext>", each part base64url.

import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

const keyCache = new Map();

function deriveKey(purpose) {
  if (keyCache.has(purpose)) return keyCache.get(purpose);
  const master = Buffer.from(String(process.env.CRYPTO_AES_SECRET_SECRET_KEY || ""), "hex");
  if (master.length !== 32) {
    throw new Error("CRYPTO_AES_SECRET_SECRET_KEY must be 32 bytes (64 hex characters)");
  }
  const key = Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), `flashfire/${purpose}/${VERSION}`, 32));
  keyCache.set(purpose, key);
  return key;
}

/** Test seam: forget derived keys after the master key changes. */
export function __resetSecretBoxKeys() {
  keyCache.clear();
}

/**
 * Encrypt a UTF-8 string.
 * @param {string} plaintext
 * @param {{purpose: string, context: string}} opts
 */
export function sealSecret(plaintext, { purpose, context }) {
  if (typeof plaintext !== "string" || !plaintext) throw new Error("sealSecret: plaintext required");
  if (!purpose || !context) throw new Error("sealSecret: purpose and context required");
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(purpose), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(String(context).toLowerCase(), "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
}

/**
 * Decrypt a value produced by sealSecret. Throws a SecretBoxError on any
 * mismatch (wrong key, wrong context, tampering, unknown format).
 */
export function openSecret(sealed, { purpose, context }) {
  const parts = String(sealed || "").split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretBoxError("unrecognised secret format");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const ct = Buffer.from(ctB64, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || !ct.length) {
    throw new SecretBoxError("corrupt secret");
  }
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(purpose), iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(String(context).toLowerCase(), "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    // Never include the ciphertext or key material in the message.
    throw new SecretBoxError("secret could not be decrypted (key changed or value tampered)");
  }
}

export class SecretBoxError extends Error {
  constructor(message) {
    super(message);
    this.name = "SecretBoxError";
    this.code = "SECRET_UNREADABLE";
  }
}
