/**
 * Analytics queries — pass rate trends, flaky test detection, scenario history.
 */

import { query } from "../client.mjs";

const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";

/**
 * Daily pass rate trend over the last N days.
 */
export async function getPassRateTrend(tenantId, opts = {}) {
  const tid = tenantId || DEFAULT_TENANT;
  const days = parseInt(opts.days) || 30;
  const params = [tid, days];
  let suiteFilter = "";

  if (opts.suiteName) {
    suiteFilter = "AND suite_name ILIKE $3";
    params.push(`%${opts.suiteName}%`);
  }

  const { rows } = await query(
    `SELECT
       DATE(started_at AT TIME ZONE 'UTC') AS date,
       COUNT(*) AS total_runs,
       COUNT(*) FILTER (WHERE status = 'passed') AS passed_runs,
       ROUND(
         COUNT(*) FILTER (WHERE status = 'passed')::numeric / NULLIF(COUNT(*), 0) * 100,
         1
       ) AS pass_rate
     FROM runs
     WHERE tenant_id = $1
       AND started_at > now() - ($2 || ' days')::interval
       AND status IN ('passed', 'failed')
       ${suiteFilter}
     GROUP BY DATE(started_at AT TIME ZONE 'UTC')
     ORDER BY date`,
    params
  );

  // Overall stats
  const totalRuns = rows.reduce((sum, r) => sum + parseInt(r.total_runs), 0);
  const totalPassed = rows.reduce((sum, r) => sum + parseInt(r.passed_runs), 0);
  const overallPassRate = totalRuns > 0 ? Math.round((totalPassed / totalRuns) * 1000) / 10 : 0;

  // Average duration
  const durationResult = await query(
    `SELECT ROUND(AVG(duration_sec)::numeric, 1) AS avg_duration
     FROM runs
     WHERE tenant_id = $1
       AND started_at > now() - ($2 || ' days')::interval
       AND status IN ('passed', 'failed')`,
    [tid, days]
  );

  return {
    dailyPassRate: rows.map((r) => ({
      date: r.date.toISOString().split("T")[0],
      totalRuns: parseInt(r.total_runs),
      passedRuns: parseInt(r.passed_runs),
      passRate: parseFloat(r.pass_rate),
    })),
    overallPassRate,
    totalRuns,
    avgDurationSec: parseFloat(durationResult.rows[0]?.avg_duration || 0),
  };
}

/**
 * Find flaky scenarios — those that flip between pass and fail frequently.
 */
export async function getFlakyScenarios(tenantId, opts = {}) {
  const tid = tenantId || DEFAULT_TENANT;
  const minRuns = parseInt(opts.minRuns) || 5;
  const days = parseInt(opts.days) || 30;

  const { rows } = await query(
    `WITH recent AS (
       SELECT
         scenario_id,
         status,
         started_at,
         LAG(status) OVER (PARTITION BY scenario_id ORDER BY started_at) AS prev_status
       FROM scenario_results
       WHERE tenant_id = $1
         AND started_at > now() - ($3 || ' days')::interval
         AND status IN ('passed', 'failed')
     ),
     flips AS (
       SELECT scenario_id, COUNT(*) AS flip_count
       FROM recent
       WHERE status != prev_status AND prev_status IS NOT NULL
       GROUP BY scenario_id
     ),
     totals AS (
       SELECT scenario_id, COUNT(*) AS run_count,
              MAX(started_at) AS last_run_at,
              (array_agg(status ORDER BY started_at DESC))[1] AS last_status
       FROM recent
       GROUP BY scenario_id
     )
     SELECT f.scenario_id, f.flip_count, t.run_count,
            ROUND(f.flip_count::numeric / t.run_count * 100, 1) AS flake_rate,
            t.last_status, t.last_run_at
     FROM flips f
     JOIN totals t ON t.scenario_id = f.scenario_id
     WHERE t.run_count >= $2
     ORDER BY flake_rate DESC`,
    [tid, minRuns, days]
  );

  return {
    flakyScenarios: rows.map((r) => ({
      scenarioId: r.scenario_id,
      flipCount: parseInt(r.flip_count),
      runCount: parseInt(r.run_count),
      flakeRate: parseFloat(r.flake_rate),
      lastStatus: r.last_status,
      lastRunAt: r.last_run_at,
    })),
  };
}

/**
 * Get recent history for a specific scenario ID across runs.
 */
export async function getScenarioHistory(tenantId, scenarioId, opts = {}) {
  const tid = tenantId || DEFAULT_TENANT;
  const limit = Math.min(50, parseInt(opts.limit) || 20);

  const { rows } = await query(
    `SELECT sr.id, sr.status, sr.reason, sr.started_at, sr.duration_sec,
            r.id AS run_id, r.suite_name, r.status AS run_status
     FROM scenario_results sr
     JOIN runs r ON r.id = sr.run_id
     WHERE sr.tenant_id = $1
       AND sr.scenario_id = $2
     ORDER BY sr.started_at DESC
     LIMIT $3`,
    [tid, scenarioId, limit]
  );

  return { scenarioId, history: rows };
}
