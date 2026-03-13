/**
 * Login attempt tracking — brute force protection.
 *
 * Limits:
 * - Per email: max 5 failed attempts in 15 minutes
 * - Per IP: max 20 failed attempts in 15 minutes
 */

import { query } from "../client.mjs";

const MAX_FAILED_PER_EMAIL = 5;
const MAX_FAILED_PER_IP = 20;
const WINDOW_MINUTES = 15;

/**
 * Log a login attempt (success or failure).
 */
export async function logAttempt(email, ipAddress, success) {
  await query(
    `INSERT INTO login_attempts (email, ip_address, success) VALUES ($1, $2::inet, $3)`,
    [email.toLowerCase().trim(), ipAddress, success]
  );
}

/**
 * Check if login should be blocked due to too many failed attempts.
 * Returns { blocked: boolean, reason: string | null }.
 */
export async function checkBruteForce(email, ipAddress) {
  const normalizedEmail = email.toLowerCase().trim();

  // Check per-email failures
  const { rows: emailRows } = await query(
    `SELECT COUNT(*)::int AS cnt FROM login_attempts
     WHERE email = $1 AND success = false
       AND created_at > now() - INTERVAL '${WINDOW_MINUTES} minutes'`,
    [normalizedEmail]
  );
  if (emailRows[0].cnt >= MAX_FAILED_PER_EMAIL) {
    return { blocked: true, reason: "Too many failed login attempts. Please try again later or reset your password." };
  }

  // Check per-IP failures
  const { rows: ipRows } = await query(
    `SELECT COUNT(*)::int AS cnt FROM login_attempts
     WHERE ip_address = $1::inet AND success = false
       AND created_at > now() - INTERVAL '${WINDOW_MINUTES} minutes'`,
    [ipAddress]
  );
  if (ipRows[0].cnt >= MAX_FAILED_PER_IP) {
    return { blocked: true, reason: "Too many failed login attempts from this location. Please try again later." };
  }

  return { blocked: false, reason: null };
}

/**
 * Clean up login attempts older than 24 hours.
 * Call periodically (e.g., daily) to keep the table small.
 */
export async function cleanupOldAttempts() {
  await query(`DELETE FROM login_attempts WHERE created_at < now() - INTERVAL '24 hours'`);
}
