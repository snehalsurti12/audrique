/**
 * Password hashing and verification — bcrypt wrapper.
 *
 * Cost factor 12 (~250ms on modern hardware).
 * Includes password strength validation.
 */

import bcrypt from "bcrypt";

const BCRYPT_ROUNDS = 12;

// Minimum 10 chars, at least 1 uppercase, 1 lowercase, 1 digit
const MIN_LENGTH = 10;
const HAS_UPPER = /[A-Z]/;
const HAS_LOWER = /[a-z]/;
const HAS_DIGIT = /[0-9]/;

/**
 * Hash a plaintext password.
 * @param {string} plain
 * @returns {Promise<string>} bcrypt hash
 */
export async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/**
 * Compare a plaintext password against a bcrypt hash.
 * @param {string} plain
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/**
 * Validate password strength. Returns null if OK, or an error message.
 * @param {string} password
 * @returns {string | null}
 */
export function validatePasswordStrength(password) {
  if (!password || password.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters`;
  }
  if (!HAS_UPPER.test(password)) {
    return "Password must contain at least one uppercase letter";
  }
  if (!HAS_LOWER.test(password)) {
    return "Password must contain at least one lowercase letter";
  }
  if (!HAS_DIGIT.test(password)) {
    return "Password must contain at least one digit";
  }
  return null;
}
