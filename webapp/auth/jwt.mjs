/**
 * JWT sign/verify — HMAC-SHA256 using Node.js built-in crypto.
 * No external dependency (no jsonwebtoken npm package).
 *
 * Access tokens: 15-minute lifetime, stored in JS memory client-side.
 * JWT_SECRET must be a persistent env var in production.
 */

import crypto from "node:crypto";

const JWT_SECRET = process.env.JWT_SECRET || "";
const ACCESS_TOKEN_TTL_SEC = 15 * 60; // 15 minutes

if (!JWT_SECRET && process.env.AUTH_ENABLED === "true") {
  console.error("[auth] FATAL: JWT_SECRET is required when AUTH_ENABLED=true");
  process.exit(1);
}

function base64url(str) {
  return Buffer.from(str).toString("base64url");
}

/**
 * Sign an access token.
 * @param {{ sub: string, tid: string, role: string, email: string }} payload
 * @returns {string} JWT string
 */
export function signAccessToken(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = { ...payload, iat: now, exp: now + ACCESS_TOKEN_TTL_SEC };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(claims));
  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");

  return `${headerB64}.${payloadB64}.${signature}`;
}

/**
 * Verify and decode an access token.
 * @param {string} token
 * @returns {{ sub: string, tid: string, role: string, email: string, iat: number, exp: number }}
 * @throws {Error} if invalid or expired
 */
export function verifyAccessToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid token format");

  const [headerB64, payloadB64, signature] = parts;
  const expected = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");

  // Constant-time comparison to prevent timing attacks
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    throw new Error("Invalid token signature");
  }

  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());

  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Token expired");
  }

  return payload;
}
