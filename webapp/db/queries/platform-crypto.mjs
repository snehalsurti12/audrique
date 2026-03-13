/**
 * AES-256-GCM encryption for Vault tokens at rest.
 *
 * Uses PLATFORM_ENCRYPTION_KEY env var. In dev mode (no key set),
 * stores tokens as base64 with a warning prefix — NOT secure.
 */

import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;       // 96-bit IV recommended for GCM
const TAG_LENGTH = 16;      // 128-bit auth tag
const KEY_LENGTH = 32;      // 256-bit key

/**
 * Derive a 256-bit key from the env var (may be arbitrary length passphrase).
 */
function getKey() {
  const raw = process.env.PLATFORM_ENCRYPTION_KEY;
  if (!raw) return null;
  // SHA-256 hash ensures exactly 32 bytes regardless of input length
  return crypto.createHash("sha256").update(raw).digest();
}

/**
 * Encrypt a plaintext string. Returns a combined string: iv:tag:ciphertext (all hex).
 *
 * @param {string} plaintext
 * @returns {string} encrypted payload
 */
export function encrypt(plaintext) {
  const key = getKey();
  if (!key) {
    // Dev mode — base64 encode with prefix so we can detect it on decrypt
    return `DEV_UNENCRYPTED:${Buffer.from(plaintext).toString("base64")}`;
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${tag}:${encrypted}`;
}

/**
 * Decrypt a payload produced by encrypt().
 *
 * @param {string} payload - iv:tag:ciphertext (hex) or DEV_UNENCRYPTED:base64
 * @returns {string} plaintext
 */
export function decrypt(payload) {
  if (!payload) return "";

  // Dev mode — base64 decode
  if (payload.startsWith("DEV_UNENCRYPTED:")) {
    return Buffer.from(payload.slice(16), "base64").toString("utf8");
  }

  const key = getKey();
  if (!key) {
    throw new Error("PLATFORM_ENCRYPTION_KEY required to decrypt vault tokens");
  }

  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted payload format");
  }

  const [ivHex, tagHex, cipherHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(cipherHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}
