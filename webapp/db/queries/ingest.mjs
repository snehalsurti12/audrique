/**
 * Ingestion module — reads suite-summary.json and related artifacts,
 * inserts everything into PostgreSQL.
 *
 * Enhanced to capture:
 * - Playwright error logs (stderr) for failure diagnosis
 * - NL Caller conversation transcripts + conversation assertions
 * - Supervisor observation data (queue routing, agent offer checks)
 * - Per-scenario summary.json for richer error context
 */

import fs from "node:fs";
import path from "node:path";
import { query, getPool } from "../client.mjs";
import { createRun, updateRunStatus } from "./runs.mjs";
import {
  createScenarioResult,
  createAssertions,
  createArtifacts,
  createTimelineEvents,
  createTranscript,
} from "./scenarios.mjs";

const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";

/**
 * Strip the /app/ prefix from Docker paths to store relative paths.
 */
function toRelativePath(absPath) {
  if (!absPath) return null;
  return absPath.replace(/^\/app\//, "");
}

/**
 * Safely read and parse a JSON file. Returns null if missing or invalid.
 * Tries the path as-is and with /app/ prefix stripped (Docker ↔ host portability).
 */
function readJsonSafe(filePath) {
  try {
    const candidates = [filePath, filePath.replace(/^\/app\//, "")];
    for (const fp of candidates) {
      if (fs.existsSync(fp)) {
        return JSON.parse(fs.readFileSync(fp, "utf8"));
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Safely read a text file. Returns null if missing.
 */
function readTextSafe(filePath) {
  try {
    const candidates = [filePath, filePath.replace(/^\/app\//, "")];
    for (const fp of candidates) {
      if (fs.existsSync(fp)) {
        return fs.readFileSync(fp, "utf8");
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Map artifact discovery entry to artifact rows.
 */
function mapArtifacts(artifactEntry) {
  const artifacts = [];
  if (!artifactEntry) return artifacts;

  const add = (type, filePath, mimeType) => {
    if (filePath) {
      artifacts.push({
        artifactType: type,
        filePath: toRelativePath(filePath),
        fileName: path.basename(filePath),
        mimeType,
      });
    }
  };

  add("salesforce_video", artifactEntry.salesforceVideo, "video/webm");
  add("merged_video", artifactEntry.mergedVideo, "video/webm");
  add("ccp_video", artifactEntry.ccpVideo, "video/webm");
  add("supervisor_video", artifactEntry.supervisorVideo, "video/webm");
  add("timeline", artifactEntry.timeline, "application/json");
  add("screenshot_failure", artifactEntry.screenshotOnFailure, "image/png");

  return artifacts;
}

/**
 * Find conversation-transcript.json for a scenario.
 *
 * Checks multiple locations because the NL Caller writes transcripts
 * to test-results/nl-caller/ (shared location), not inside each
 * per-run e2e-suite directory.
 *
 * @param {string} outputDir - Playwright output directory for the scenario
 * @param {string} runDir - Top-level run directory (e.g. test-results/e2e-suite/xxx)
 * @param {string} scenarioId - Scenario identifier
 */
function findTranscriptFile(outputDir, runDir, scenarioId) {
  try {
    // Build search candidates from most specific to least specific
    const candidates = [];

    // 1. Inside the pw-output dir or its subdirectories
    if (outputDir) {
      const relOut = outputDir.replace(/^\/app\//, "");
      candidates.push(path.join(relOut, "conversation-transcript.json"));
    }

    // 2. Inside the scenario dir (one level above pw-output)
    if (outputDir) {
      const relOut = outputDir.replace(/^\/app\//, "");
      candidates.push(path.join(relOut, "..", "conversation-transcript.json"));
    }

    // 3. Shared NL caller results dir (where the framework actually writes it)
    candidates.push("test-results/nl-caller/conversation-transcript.json");
    candidates.push(path.join("test-results", "nl-caller", `${scenarioId}`, "conversation-transcript.json"));

    // Check all candidates
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    // 4. Recursive search in the scenario output dir (up to 3 levels deep)
    if (outputDir) {
      const dirToSearch = outputDir.replace(/^\/app\//, "");
      const found = searchFileRecursive(dirToSearch, "conversation-transcript.json", 3);
      if (found) return found;
    }

    // 5. Recursive search in the run dir for any transcript
    if (runDir) {
      const relRunDir = runDir.replace(/^\/app\//, "");
      const found = searchFileRecursive(relRunDir, "conversation-transcript.json", 4);
      if (found) return found;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Search for a file by name recursively up to maxDepth.
 */
function searchFileRecursive(dir, fileName, maxDepth, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(dir)) return null;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === fileName && entry.isFile()) {
        return path.join(dir, entry.name);
      }
    }
    // Search subdirectories
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith(".")) {
        const found = searchFileRecursive(path.join(dir, entry.name), fileName, maxDepth, depth + 1);
        if (found) return found;
      }
    }
  } catch { /* ignore permission errors */ }
  return null;
}

/**
 * Find supervisor-observation.json in a Playwright output subdirectory.
 */
function findSupervisorObservation(outputDir) {
  if (!outputDir) return null;
  const relDir = outputDir.replace(/^\/app\//, "");
  return searchFileRecursive(relDir, "supervisor-observation.json", 3);
}

/**
 * Read the per-scenario summary.json which may contain the errorLog field.
 */
function findScenarioErrorLog(outputDir) {
  if (!outputDir) return null;
  try {
    const relDir = outputDir.replace(/^\/app\//, "");
    // summary.json is at the scenario level, one above pw-output
    const summaryPath = path.join(relDir, "..", "summary.json");
    if (fs.existsSync(summaryPath)) {
      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
      return summary.errorLog || null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ingest a complete suite-summary.json into the database.
 *
 * @param {string} tenantId - Tenant UUID
 * @param {string} summaryPath - Path to suite-summary.json
 * @param {string} [existingRunId] - If provided, updates this run instead of creating a new one
 * @returns {string} The run UUID
 */
export async function ingestSuiteSummary(tenantId, summaryPath, existingRunId) {
  const tid = tenantId || DEFAULT_TENANT;
  const summary = readJsonSafe(summaryPath);

  if (!summary) {
    throw new Error(`Cannot read suite summary at ${summaryPath}`);
  }

  // Create or update the run
  let runId = existingRunId;

  if (!runId) {
    runId = await createRun(tid, {
      suiteName: summary.name || "Unknown Suite",
      suiteFile: toRelativePath(summary.suiteFile) || "",
      status: summary.totals?.failed > 0 ? "failed" : "passed",
      startedAt: summary.startedAt,
      stopOnFailure: summary.stopOnFailure || false,
      dryRun: summary.dryRun || false,
    });
  }

  // Update run with final stats
  await updateRunStatus(runId, {
    status: summary.totals?.failed > 0 ? "failed" : "passed",
    finishedAt: summary.finishedAt,
    durationSec: summary.durationSec,
    runDir: toRelativePath(summary.runDir),
    totalScenarios: summary.totals?.scenarios || 0,
    passedScenarios: summary.totals?.passed || 0,
    failedScenarios: summary.totals?.failed || 0,
    skippedScenarios: summary.totals?.skipped || 0,
    allowedFailureScenarios: summary.totals?.allowedFailure || 0,
  });

  const runDir = toRelativePath(summary.runDir);

  // Ingest each scenario
  if (summary.scenarios) {
    for (let i = 0; i < summary.scenarios.length; i++) {
      const sc = summary.scenarios[i];

      // Collect error details from multiple sources
      const errorLog = sc.errorLog || findScenarioErrorLog(sc.outputDir) || null;

      // Find and read supervisor observation
      const supObsPath = findSupervisorObservation(sc.outputDir);
      const supervisorObservation = supObsPath ? readJsonSafe(supObsPath) : null;

      const scenarioResultId = await createScenarioResult(tid, runId, {
        scenarioId: sc.id,
        description: sc.description,
        status: sc.status,
        reason: sc.reason,
        allowFailure: sc.allowFailure,
        startedAt: sc.startedAt,
        finishedAt: sc.finishedAt,
        durationSec: sc.durationSec,
        outputDir: toRelativePath(sc.outputDir),
        sortOrder: i,
        appliedEnv: sc.appliedEnv || {},
        callTriggerMode: sc.appliedEnv?.CALL_TRIGGER_MODE || null,
        errorLog,
        supervisorObservation,
      });

      // Ingest artifacts
      if (sc.artifacts) {
        for (const artEntry of sc.artifacts) {
          const artifacts = mapArtifacts(artEntry);
          if (artifacts.length > 0) {
            await createArtifacts(tid, scenarioResultId, artifacts);
          }

          // Ingest timeline
          if (artEntry.timeline) {
            const timeline = readJsonSafe(artEntry.timeline);
            if (timeline) {
              const events = Object.entries(timeline)
                .filter(([, v]) => typeof v === "number")
                .map(([name, ms]) => ({ eventName: name, eventTimeMs: ms }));
              if (events.length > 0) {
                await createTimelineEvents(tid, scenarioResultId, events);
              }
            }
          }
        }
      }

      // Ingest NL Caller transcript — check multiple locations
      const transcriptPath = findTranscriptFile(sc.outputDir, summary.runDir, sc.id);
      if (transcriptPath) {
        const transcript = readJsonSafe(transcriptPath);
        if (transcript) {
          await createTranscript(tid, scenarioResultId, {
            mode: transcript.mode || "unknown",
            personaName: transcript.persona?.name,
            personaContext: transcript.persona?.context,
            durationSec: transcript.durationSec,
            totalTurns: transcript.totalTurns || 0,
            callerTurns: transcript.callerTurns || 0,
            agentTurns: transcript.agentTurns || 0,
            allAssertionsPassed: transcript.allAssertionsPassed,
            objective: transcript.persona?.objective,
            turns: transcript.turns || [],
          });

          // Insert conversation assertions
          if (transcript.assertions) {
            await createAssertions(tid, scenarioResultId, transcript.assertions);
          }
        }
      }
    }
  }

  console.log(`[ingest] Ingested run ${runId}: ${summary.name} (${summary.totals?.scenarios || 0} scenarios)`);
  return runId;
}
