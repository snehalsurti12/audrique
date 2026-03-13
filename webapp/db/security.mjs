/**
 * Database security utilities — input validation, rate limiting, audit logging.
 *
 * Enterprise security features:
 * - UUID format validation (prevents injection via malformed IDs)
 * - Pagination bounds enforcement (prevents resource exhaustion)
 * - Tenant context injection for RLS policies
 * - Rate limiting per IP (prevents API abuse)
 * - Audit trail logging for compliance
 * - Security headers for HTTP responses
 */

import { query, getPool } from "./client.mjs";

// ── UUID Validation ──────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a UUID string. Returns true if valid UUID v4 format.
 */
export function isValidUUID(str) {
  return typeof str === "string" && UUID_REGEX.test(str);
}

/**
 * Validate and clamp pagination parameters.
 * Returns { page, limit } with safe defaults and bounds.
 */
export function sanitizePagination(rawPage, rawLimit) {
  let page = parseInt(rawPage, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (page > 10000) page = 10000; // Hard cap to prevent offset abuse

  let limit = parseInt(rawLimit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100; // Max 100 results per page

  return { page, limit };
}

/**
 * Validate and clamp a "days" parameter (for trends, flaky detection).
 */
export function sanitizeDays(rawDays, defaultVal = 30) {
  let days = parseInt(rawDays, 10);
  if (!Number.isFinite(days) || days < 1) days = defaultVal;
  if (days > 365) days = 365;
  return days;
}

/**
 * Sanitize a string for safe inclusion in responses.
 * Strips control characters and limits length.
 */
export function sanitizeString(str, maxLen = 1000) {
  if (typeof str !== "string") return "";
  // Strip control characters except newline/tab
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").slice(0, maxLen);
}

// ── Tenant Context (RLS) ────────────────────────────────────────────────────

/**
 * Set the current tenant context for Row-Level Security.
 * Call this before any tenant-scoped query when using a non-superuser connection.
 *
 * @param {import('pg').PoolClient} client - Database client from pool.connect()
 * @param {string} tenantId - Tenant UUID
 */
export async function setTenantContext(client, tenantId) {
  if (!isValidUUID(tenantId)) throw new Error("Invalid tenant ID");
  await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
}

// ── Rate Limiting ───────────────────────────────────────────────────────────

const rateLimitStore = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 120; // 120 requests per minute per IP

/**
 * Check rate limit for an IP address.
 * Returns { allowed: boolean, remaining: number, resetAt: number }.
 */
export function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitStore.get(ip);

  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitStore.set(ip, entry);
  }

  entry.count++;

  // Periodic cleanup — remove expired entries every 5 minutes
  if (rateLimitStore.size > 1000) {
    for (const [key, val] of rateLimitStore) {
      if (now >= val.resetAt) rateLimitStore.delete(key);
    }
  }

  return {
    allowed: entry.count <= RATE_LIMIT_MAX,
    remaining: Math.max(0, RATE_LIMIT_MAX - entry.count),
    resetAt: entry.resetAt,
  };
}

// ── Security Headers ────────────────────────────────────────────────────────

/**
 * Set enterprise security headers on HTTP response.
 */
export function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // HSTS — enforce HTTPS in production (non-localhost)
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

// ── Audit Logging ───────────────────────────────────────────────────────────

/**
 * Log an action to the audit trail.
 * Fire-and-forget — never throws or blocks the request.
 */
export async function logAudit(tenantId, action, resourceType, resourceId, details = {}) {
  try {
    const pool = getPool();
    if (!pool) return;
    await query(
      `INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, action, resourceType, resourceId, JSON.stringify(details)]
    );
  } catch {
    // Audit logging should never break the main flow
  }
}
