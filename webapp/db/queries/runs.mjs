/**
 * Run CRUD and listing queries.
 */

import { query } from "../client.mjs";

const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";

/**
 * Create a new run record.
 * @returns {string} The new run UUID
 */
export async function createRun(tenantId, data) {
  const tid = tenantId || DEFAULT_TENANT;
  const { rows } = await query(
    `INSERT INTO runs (tenant_id, suite_name, suite_file, status, started_at, stop_on_failure, dry_run, connection_set, suite_config, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      tid,
      data.suiteName,
      data.suiteFile,
      data.status || "running",
      data.startedAt || new Date().toISOString(),
      data.stopOnFailure || false,
      data.dryRun || false,
      data.connectionSet || null,
      data.suiteConfig ? JSON.stringify(data.suiteConfig) : null,
      data.metadata ? JSON.stringify(data.metadata) : "{}",
    ]
  );
  return rows[0].id;
}

/**
 * Update a run's status and final counts.
 */
export async function updateRunStatus(runId, data) {
  await query(
    `UPDATE runs SET
       status = $2,
       finished_at = $3,
       duration_sec = $4,
       run_dir = $5,
       total_scenarios = $6,
       passed_scenarios = $7,
       failed_scenarios = $8,
       skipped_scenarios = $9,
       allowed_failure_scenarios = $10
     WHERE id = $1`,
    [
      runId,
      data.status,
      data.finishedAt,
      data.durationSec,
      data.runDir || null,
      data.totalScenarios || 0,
      data.passedScenarios || 0,
      data.failedScenarios || 0,
      data.skippedScenarios || 0,
      data.allowedFailureScenarios || 0,
    ]
  );
}

/**
 * List runs with pagination and optional filters.
 */
export async function listRuns(tenantId, opts = {}) {
  const tid = tenantId || DEFAULT_TENANT;
  const page = Math.max(1, parseInt(opts.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(opts.limit) || 25));
  const offset = (page - 1) * limit;

  const conditions = ["tenant_id = $1"];
  const params = [tid];
  let paramIdx = 2;

  if (opts.status) {
    conditions.push(`status = $${paramIdx}`);
    params.push(opts.status);
    paramIdx++;
  }

  if (opts.suiteName) {
    conditions.push(`suite_name ILIKE $${paramIdx}`);
    params.push(`%${opts.suiteName}%`);
    paramIdx++;
  }

  const where = conditions.join(" AND ");

  const countResult = await query(
    `SELECT COUNT(*) AS total FROM runs WHERE ${where}`,
    params
  );
  const total = parseInt(countResult.rows[0].total);

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT id, suite_name, suite_file, status, started_at, finished_at,
            duration_sec, total_scenarios, passed_scenarios, failed_scenarios,
            skipped_scenarios, allowed_failure_scenarios, connection_set, dry_run
     FROM runs
     WHERE ${where}
     ORDER BY started_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    params
  );

  return { runs: rows, total, page, limit };
}

/**
 * Get a single run with all scenario results.
 */
export async function getRun(tenantId, runId) {
  const tid = tenantId || DEFAULT_TENANT;

  const { rows: runRows } = await query(
    `SELECT * FROM runs WHERE id = $1 AND tenant_id = $2`,
    [runId, tid]
  );
  if (runRows.length === 0) return null;

  const run = runRows[0];

  const { rows: scenarios } = await query(
    `SELECT sr.id, sr.scenario_id, sr.description, sr.status, sr.reason,
            sr.allow_failure, sr.started_at, sr.finished_at, sr.duration_sec,
            sr.call_trigger_mode, sr.sort_order,
            sr.error_log, sr.supervisor_observation,
            (SELECT COUNT(*) FROM assertions a WHERE a.scenario_result_id = sr.id) AS assertion_count,
            (SELECT COUNT(*) FROM assertions a WHERE a.scenario_result_id = sr.id AND a.passed = true) AS assertions_passed,
            (SELECT COUNT(*) FROM transcripts t WHERE t.scenario_result_id = sr.id) > 0 AS has_transcript,
            (SELECT COUNT(*) FROM artifacts art WHERE art.scenario_result_id = sr.id) AS artifact_count
     FROM scenario_results sr
     WHERE sr.run_id = $1 AND sr.tenant_id = $2
     ORDER BY sr.sort_order, sr.started_at`,
    [runId, tid]
  );

  return { ...run, scenarios };
}

/**
 * Delete a run and all its children (cascade).
 */
export async function deleteRun(tenantId, runId) {
  const tid = tenantId || DEFAULT_TENANT;
  const { rowCount } = await query(
    `DELETE FROM runs WHERE id = $1 AND tenant_id = $2`,
    [runId, tid]
  );
  return rowCount > 0;
}
