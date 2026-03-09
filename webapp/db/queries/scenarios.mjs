/**
 * Scenario result queries — detail views with assertions, timeline, transcript, artifacts.
 */

import { query } from "../client.mjs";

const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";

/**
 * Create a scenario result record.
 * @returns {string} The new scenario result UUID
 */
export async function createScenarioResult(tenantId, runId, data) {
  const tid = tenantId || DEFAULT_TENANT;
  const { rows } = await query(
    `INSERT INTO scenario_results
       (tenant_id, run_id, scenario_id, description, status, reason,
        allow_failure, started_at, finished_at, duration_sec, output_dir,
        sort_order, applied_env, call_trigger_mode, metadata,
        error_log, supervisor_observation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING id`,
    [
      tid, runId, data.scenarioId, data.description || null,
      data.status, data.reason || null, data.allowFailure || false,
      data.startedAt || null, data.finishedAt || null,
      data.durationSec || null, data.outputDir || null,
      data.sortOrder || 0,
      data.appliedEnv ? JSON.stringify(data.appliedEnv) : "{}",
      data.callTriggerMode || null,
      data.metadata ? JSON.stringify(data.metadata) : "{}",
      data.errorLog || null,
      data.supervisorObservation ? JSON.stringify(data.supervisorObservation) : null,
    ]
  );
  return rows[0].id;
}

/**
 * Bulk insert assertions for a scenario.
 */
export async function createAssertions(tenantId, scenarioResultId, assertions) {
  if (!assertions || assertions.length === 0) return;
  const tid = tenantId || DEFAULT_TENANT;

  const values = [];
  const params = [];
  let idx = 1;

  for (let i = 0; i < assertions.length; i++) {
    const a = assertions[i];
    values.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5})`);
    params.push(tid, scenarioResultId, a.type || a.assertion_type, a.passed, a.detail || null, i);
    idx += 6;
  }

  await query(
    `INSERT INTO assertions (tenant_id, scenario_result_id, assertion_type, passed, detail, sort_order)
     VALUES ${values.join(", ")}`,
    params
  );
}

/**
 * Bulk insert artifacts for a scenario.
 */
export async function createArtifacts(tenantId, scenarioResultId, artifacts) {
  if (!artifacts || artifacts.length === 0) return;
  const tid = tenantId || DEFAULT_TENANT;

  const values = [];
  const params = [];
  let idx = 1;

  for (const art of artifacts) {
    values.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5})`);
    params.push(tid, scenarioResultId, art.artifactType, art.filePath, art.fileName || null, art.mimeType || null);
    idx += 6;
  }

  await query(
    `INSERT INTO artifacts (tenant_id, scenario_result_id, artifact_type, file_path, file_name, mime_type)
     VALUES ${values.join(", ")}`,
    params
  );
}

/**
 * Bulk insert timeline events for a scenario.
 */
export async function createTimelineEvents(tenantId, scenarioResultId, events) {
  if (!events || events.length === 0) return;
  const tid = tenantId || DEFAULT_TENANT;

  const values = [];
  const params = [];
  let idx = 1;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    values.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4})`);
    params.push(tid, scenarioResultId, e.eventName, e.eventTimeMs, i);
    idx += 5;
  }

  await query(
    `INSERT INTO timeline_events (tenant_id, scenario_result_id, event_name, event_time_ms, sort_order)
     VALUES ${values.join(", ")}`,
    params
  );
}

/**
 * Create a transcript with its turns.
 */
export async function createTranscript(tenantId, scenarioResultId, data) {
  const tid = tenantId || DEFAULT_TENANT;

  const { rows } = await query(
    `INSERT INTO transcripts
       (tenant_id, scenario_result_id, mode, persona_name, persona_context,
        duration_sec, total_turns, caller_turns, agent_turns,
        all_assertions_passed, objective)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      tid, scenarioResultId, data.mode, data.personaName || null,
      data.personaContext || null, data.durationSec || null,
      data.totalTurns || 0, data.callerTurns || 0, data.agentTurns || 0,
      data.allAssertionsPassed ?? null, data.objective || null,
    ]
  );

  const transcriptId = rows[0].id;

  // Insert turns
  if (data.turns && data.turns.length > 0) {
    const values = [];
    const params = [];
    let idx = 1;

    for (let i = 0; i < data.turns.length; i++) {
      const t = data.turns[i];
      values.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5})`);
      params.push(tid, transcriptId, t.speaker, t.text, i, t.timestamp || null);
      idx += 6;
    }

    await query(
      `INSERT INTO transcript_turns (tenant_id, transcript_id, speaker, text, turn_number, timestamp_ms)
       VALUES ${values.join(", ")}`,
      params
    );
  }

  return transcriptId;
}

/**
 * Get full scenario detail with all related data.
 */
export async function getScenarioResult(tenantId, scenarioResultId) {
  const tid = tenantId || DEFAULT_TENANT;

  const { rows: srRows } = await query(
    `SELECT * FROM scenario_results WHERE id = $1 AND tenant_id = $2`,
    [scenarioResultId, tid]
  );
  if (srRows.length === 0) return null;

  const scenario = srRows[0];

  // Fetch all related data in parallel
  const [assertionRes, artifactRes, timelineRes, transcriptRes] = await Promise.all([
    query(
      `SELECT assertion_type, passed, detail, sort_order
       FROM assertions WHERE scenario_result_id = $1 AND tenant_id = $2
       ORDER BY sort_order`,
      [scenarioResultId, tid]
    ),
    query(
      `SELECT artifact_type, file_path, file_name, mime_type
       FROM artifacts WHERE scenario_result_id = $1 AND tenant_id = $2
       ORDER BY created_at`,
      [scenarioResultId, tid]
    ),
    query(
      `SELECT event_name, event_time_ms
       FROM timeline_events WHERE scenario_result_id = $1 AND tenant_id = $2
       ORDER BY sort_order`,
      [scenarioResultId, tid]
    ),
    query(
      `SELECT * FROM transcripts WHERE scenario_result_id = $1 AND tenant_id = $2`,
      [scenarioResultId, tid]
    ),
  ]);

  let transcript = null;
  if (transcriptRes.rows.length > 0) {
    transcript = transcriptRes.rows[0];
    const { rows: turns } = await query(
      `SELECT speaker, text, turn_number, timestamp_ms
       FROM transcript_turns WHERE transcript_id = $1 AND tenant_id = $2
       ORDER BY turn_number`,
      [transcript.id, tid]
    );
    transcript.turns = turns;
  }

  return {
    ...scenario,
    assertions: assertionRes.rows,
    artifacts: artifactRes.rows,
    timeline: timelineRes.rows,
    transcript,
  };
}
