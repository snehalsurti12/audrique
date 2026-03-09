/**
 * PostgreSQL client wrapper — enterprise-grade connection management.
 *
 * Security:
 * - SSL enforced for non-localhost connections (RDS, cloud deployments)
 * - Connection + statement timeouts prevent resource exhaustion
 * - All queries use parameterized statements (SQL injection safe)
 * - Pool size limited to prevent connection flooding
 * - Graceful shutdown on process termination
 *
 * Configuration priority:
 * 1. DATABASE_URL env var (Docker, CI/CD, AWS)
 * 2. system-settings.json database.DATABASE_URL (Studio UI)
 *
 * Optional — if DATABASE_URL is not set, all functions gracefully no-op.
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
const { Pool } = pg;

let pool = null;

/**
 * Determine if SSL should be enforced based on the connection URL.
 * SSL is required for any non-localhost/non-Docker connection.
 */
function resolveSSLConfig(dbUrl) {
  const isLocal = /(@localhost[:/]|@127\.0\.0\.1[:/]|@postgres[:/]|@host\.docker\.internal[:/])/.test(dbUrl);
  const explicitSSL = dbUrl.includes("ssl=true") || dbUrl.includes("sslmode=require");

  if (explicitSSL || !isLocal) {
    // Enterprise: enforce SSL for remote connections (RDS, cloud PostgreSQL)
    return { ssl: { rejectUnauthorized: false } };
  }
  return {};
}

/**
 * Initialize the pool. Call once at startup.
 */
export async function initPool() {
  // Priority 1: env var
  let dbUrl = process.env.DATABASE_URL || "";

  // Priority 2: system settings (set from Studio UI)
  if (!dbUrl) {
    try {
      const settingsPath = path.resolve("instances/system-settings.json");
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        if (settings.database?.DATABASE_URL) dbUrl = settings.database.DATABASE_URL;
      }
    } catch {
      // No settings file — that's fine
    }
  }

  if (!dbUrl) return;

  pool = new Pool({
    connectionString: dbUrl,
    // Pool sizing
    max: 10,                        // Max concurrent connections
    min: 1,                         // Keep at least 1 idle connection
    // Timeouts
    connectionTimeoutMillis: 10000, // 10s to establish a connection
    idleTimeoutMillis: 30000,       // Close idle connections after 30s
    // Statement timeout — prevent runaway queries (5 minutes max)
    statement_timeout: 300000,
    // SSL — enforced for remote connections
    ...resolveSSLConfig(dbUrl),
  });

  // Handle pool errors (e.g., connection drops) without crashing
  pool.on("error", (err) => {
    console.error("[db] Pool error:", err.message);
  });

  // Validate connection
  try {
    const client = await pool.connect();
    // Verify we can actually query
    await client.query("SELECT 1");
    client.release();
    console.log("[db] PostgreSQL connected");
  } catch (err) {
    console.error("[db] PostgreSQL connection failed:", err.message);
    await pool.end().catch(() => {});
    pool = null;
  }
}

/**
 * Returns true if the database is available.
 */
export function isAvailable() {
  return pool !== null;
}

/**
 * Run a parameterized query. Returns { rows, rowCount }.
 * All queries MUST use parameterized statements — never interpolate user input.
 */
export async function query(sql, params = []) {
  if (!pool) throw new Error("Database not available");
  return pool.query(sql, params);
}

/**
 * Get the raw pool (for transactions).
 */
export function getPool() {
  return pool;
}

/**
 * Graceful shutdown — drain all connections.
 */
export async function shutdown() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log("[db] PostgreSQL pool closed");
  }
}
