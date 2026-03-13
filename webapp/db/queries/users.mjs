/**
 * User CRUD queries — parameterized, tenant-scoped via RLS.
 */

import { query, getPool } from "../client.mjs";
import { setTenantContext } from "../security.mjs";

/**
 * Create a new user. Returns the created user row.
 */
export async function createUser({ tenantId, email, passwordHash, displayName, role = "viewer", emailVerified = false, invitedBy = null }) {
  const { rows } = await query(
    `INSERT INTO users (tenant_id, email, password_hash, display_name, role, email_verified, invited_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, tenant_id, email, email_verified, display_name, role, is_active, created_at`,
    [tenantId, email.toLowerCase().trim(), passwordHash, displayName.trim(), role, emailVerified, invitedBy]
  );
  return rows[0];
}

/**
 * Look up user by email (case-insensitive). Not tenant-scoped — emails are globally unique.
 */
export async function getUserByEmail(email) {
  const { rows } = await query(
    `SELECT id, tenant_id, email, email_verified, password_hash, display_name, role, is_active, last_login_at, created_at
     FROM users WHERE email = $1`,
    [email.toLowerCase().trim()]
  );
  return rows[0] || null;
}

/**
 * Look up user by ID. Not tenant-scoped — used during JWT verification.
 */
export async function getUserById(userId) {
  const { rows } = await query(
    `SELECT id, tenant_id, email, email_verified, display_name, role, is_active, last_login_at, created_at
     FROM users WHERE id = $1`,
    [userId]
  );
  return rows[0] || null;
}

/**
 * List all users for a tenant. Requires tenant context for RLS.
 */
export async function listTenantUsers(tenantId) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setTenantContext(client, tenantId);
    const { rows } = await client.query(
      `SELECT id, email, display_name, role, is_active, email_verified, last_login_at, created_at
       FROM users ORDER BY created_at ASC`
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

/**
 * Update user's last_login_at timestamp.
 */
export async function updateLastLogin(userId) {
  await query(
    `UPDATE users SET last_login_at = now() WHERE id = $1`,
    [userId]
  );
}

/**
 * Update user profile (display name and/or password).
 */
export async function updateUserProfile(userId, { displayName, passwordHash }) {
  const sets = [];
  const params = [];
  let idx = 1;

  if (displayName !== undefined) {
    sets.push(`display_name = $${idx++}`);
    params.push(displayName.trim());
  }
  if (passwordHash !== undefined) {
    sets.push(`password_hash = $${idx++}`);
    params.push(passwordHash);
  }
  if (sets.length === 0) return;

  sets.push(`updated_at = now()`);
  params.push(userId);

  await query(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${idx}`,
    params
  );
}

/**
 * Change a user's role. Admin-only operation.
 */
export async function updateUserRole(userId, role) {
  await query(
    `UPDATE users SET role = $1, updated_at = now() WHERE id = $2`,
    [role, userId]
  );
}

/**
 * Deactivate (soft-delete) a user. Prevents login, preserves data.
 */
export async function deactivateUser(userId) {
  await query(
    `UPDATE users SET is_active = false, updated_at = now() WHERE id = $1`,
    [userId]
  );
}

/**
 * Reactivate a user.
 */
export async function reactivateUser(userId) {
  await query(
    `UPDATE users SET is_active = true, updated_at = now() WHERE id = $1`,
    [userId]
  );
}

/**
 * Mark email as verified.
 */
export async function markEmailVerified(userId) {
  await query(
    `UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1`,
    [userId]
  );
}

/**
 * Count total users (no tenant filter). Used for bootstrap detection.
 */
export async function countAllUsers() {
  const { rows } = await query(`SELECT COUNT(*)::int AS count FROM users`);
  return rows[0].count;
}
