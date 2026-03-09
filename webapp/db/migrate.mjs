/**
 * Simple SQL migration runner.
 * Reads numbered .sql files from webapp/migrations/ and applies them in order.
 * Tracks applied migrations in a _migrations table.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAvailable, query, getPool } from "./client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

/**
 * Run all pending migrations.
 * Safe to call multiple times — already-applied migrations are skipped.
 */
export async function runMigrations() {
  if (!isAvailable()) {
    console.log("[migrate] No database configured — skipping migrations");
    return;
  }

  // Create migrations tracking table if it doesn't exist
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          SERIAL PRIMARY KEY,
      filename    TEXT NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Get already-applied migrations
  const { rows: applied } = await query("SELECT filename FROM _migrations ORDER BY filename");
  const appliedSet = new Set(applied.map((r) => r.filename));

  // Read migration files
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.log("[migrate] No migrations directory found");
    return;
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let appliedCount = 0;

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`[migrate] Applied: ${file}`);
      appliedCount++;
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`[migrate] Failed to apply ${file}:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  if (appliedCount === 0) {
    console.log("[migrate] All migrations up to date");
  } else {
    console.log(`[migrate] Applied ${appliedCount} migration(s)`);
  }
}
