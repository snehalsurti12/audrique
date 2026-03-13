/**
 * Auth token queries — refresh tokens, email verification, password reset, invitations.
 * All tokens use parameterized queries. Refresh tokens store only SHA-256 hashes.
 */

import crypto from "node:crypto";
import { query, getPool } from "../client.mjs";
import { setTenantContext } from "../security.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random token (hex string).
 */
export function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * SHA-256 hash a token for safe storage.
 */
export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ── Refresh Tokens ───────────────────────────────────────────────────────────

/**
 * Store a refresh token (hashed). Lifetime: 7 days.
 */
export async function createRefreshToken(userId, rawToken, { ipAddress = null, userAgent = null } = {}) {
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, tokenHash, expiresAt, ipAddress, userAgent]
  );
}

/**
 * Find a valid (non-expired, non-revoked) refresh token by its raw value.
 * Returns the token row with user_id, or null.
 */
export async function findRefreshToken(rawToken) {
  const tokenHash = hashToken(rawToken);
  const { rows } = await query(
    `SELECT id, user_id, expires_at FROM refresh_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash]
  );
  return rows[0] || null;
}

/**
 * Revoke a specific refresh token by ID.
 */
export async function revokeRefreshToken(tokenId) {
  await query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`,
    [tokenId]
  );
}

/**
 * Revoke ALL refresh tokens for a user (force logout everywhere).
 */
export async function revokeAllUserRefreshTokens(userId) {
  await query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

// ── Email Verification Tokens ────────────────────────────────────────────────

/**
 * Create an email verification token. Lifetime: 24 hours.
 */
export async function createEmailVerifyToken(userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
  await query(
    `INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );
  return token;
}

/**
 * Verify an email token. Returns user_id if valid, null otherwise. Marks as used.
 */
export async function verifyEmailToken(token) {
  const { rows } = await query(
    `UPDATE email_verification_tokens
     SET used_at = now()
     WHERE token = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [token]
  );
  return rows[0]?.user_id || null;
}

// ── Password Reset Tokens ────────────────────────────────────────────────────

/**
 * Create a password reset token. Lifetime: 1 hour.
 */
export async function createPasswordResetToken(userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h
  await query(
    `INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );
  return token;
}

/**
 * Use a password reset token. Returns user_id if valid, null otherwise.
 */
export async function usePasswordResetToken(token) {
  const { rows } = await query(
    `UPDATE password_reset_tokens
     SET used_at = now()
     WHERE token = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [token]
  );
  return rows[0]?.user_id || null;
}

// ── Invitations ──────────────────────────────────────────────────────────────

/**
 * Create an invitation. Lifetime: 7 days.
 */
export async function createInvitation({ tenantId, email, role, invitedBy }) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  const { rows } = await query(
    `INSERT INTO invitations (tenant_id, email, role, invited_by, token, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, token, expires_at`,
    [tenantId, email.toLowerCase().trim(), role, invitedBy, token, expiresAt]
  );
  return rows[0];
}

/**
 * Find a valid (non-expired, non-accepted) invitation by token.
 */
export async function getInvitation(token) {
  const { rows } = await query(
    `SELECT id, tenant_id, email, role, invited_by, expires_at
     FROM invitations
     WHERE token = $1 AND accepted_at IS NULL AND expires_at > now()`,
    [token]
  );
  return rows[0] || null;
}

/**
 * Mark an invitation as accepted.
 */
export async function acceptInvitation(invitationId) {
  await query(
    `UPDATE invitations SET accepted_at = now() WHERE id = $1`,
    [invitationId]
  );
}

/**
 * List all invitations for a tenant (admin view).
 */
export async function listTenantInvitations(tenantId) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setTenantContext(client, tenantId);
    const { rows } = await client.query(
      `SELECT i.id, i.email, i.role, i.expires_at, i.accepted_at, i.created_at,
              u.display_name AS invited_by_name
       FROM invitations i
       LEFT JOIN users u ON u.id = i.invited_by
       ORDER BY i.created_at DESC`
    );
    await client.query("COMMIT");
    return rows;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
