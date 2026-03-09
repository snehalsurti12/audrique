#!/usr/bin/env node

/**
 * Backfill existing test results into PostgreSQL.
 *
 * Usage:
 *   node scripts/ingest-results.mjs [results-dir]
 *
 * Scans test-results/e2e-suite/ for existing suite-summary.json files
 * and ingests them into the database.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initPool, isAvailable, shutdown } from "../webapp/db/client.mjs";
import { runMigrations } from "../webapp/db/migrate.mjs";
import { ingestSuiteSummary } from "../webapp/db/queries/ingest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_RESULTS_DIR = path.join(ROOT, "test-results", "e2e-suite");

async function main() {
  const resultsDir = process.argv[2] || DEFAULT_RESULTS_DIR;

  // Initialize database
  await initPool();

  if (!isAvailable()) {
    console.error("[ingest] No DATABASE_URL configured. Set DATABASE_URL env var or configure in Scenario Studio settings.");
    process.exit(1);
  }

  // Run migrations first
  await runMigrations();

  // Find all suite-summary.json files
  if (!fs.existsSync(resultsDir)) {
    console.error(`[ingest] Results directory not found: ${resultsDir}`);
    process.exit(1);
  }

  const runDirs = fs
    .readdirSync(resultsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(resultsDir, d.name))
    .sort();

  let ingested = 0;
  let skipped = 0;
  let failed = 0;

  for (const runDir of runDirs) {
    const summaryPath = path.join(runDir, "suite-summary.json");
    if (!fs.existsSync(summaryPath)) {
      skipped++;
      continue;
    }

    try {
      await ingestSuiteSummary(null, summaryPath);
      ingested++;
    } catch (err) {
      console.error(`[ingest] Failed: ${path.basename(runDir)} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\n[ingest] Done: ${ingested} ingested, ${skipped} skipped (no summary), ${failed} failed`);

  await shutdown();
}

main().catch((err) => {
  console.error("[ingest] Fatal:", err);
  process.exit(1);
});
