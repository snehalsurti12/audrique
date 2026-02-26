import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { isDeclarativeSuite, scenarioToEnv, printBridgeMapping } from "./scenario-bridge.mjs";

const DEFAULT_SUITE_FILE = "scenarios/e2e/full-suite.json";
const DEFAULT_RESULTS_ROOT = path.resolve(process.cwd(), "test-results", "e2e-suite");

async function main() {
  const suiteFile = path.resolve(
    process.cwd(),
    process.env.E2E_SUITE_FILE?.trim() || DEFAULT_SUITE_FILE
  );
  if (!fs.existsSync(suiteFile)) {
    throw new Error(`Suite file not found: ${suiteFile}`);
  }

  const suite = JSON.parse(fs.readFileSync(suiteFile, "utf8"));
  if (!Array.isArray(suite?.scenarios) || suite.scenarios.length === 0) {
    throw new Error(`Suite file has no scenarios: ${suiteFile}`);
  }

  const suiteName = String(suite.name || "scv-e2e-suite");
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(
    DEFAULT_RESULTS_ROOT,
    `${slugify(suiteName)}-${runStamp}`
  );
  fs.mkdirSync(runDir, { recursive: true });

  const stopOnFailure = toBool(suite.stopOnFailure, true);
  const dryRun = /^(1|true|yes|on)$/i.test((process.env.E2E_SUITE_DRY_RUN ?? "").trim());

  const scenarioResults = [];
  const suiteStartedAt = Date.now();

  const suiteIsV2 = isDeclarativeSuite(suite);
  console.log(`E2E suite: ${suiteName}`);
  console.log(`Suite config: ${suiteFile}`);
  console.log(`Suite format: ${suiteIsV2 ? "v2 (declarative steps)" : "v1 (env overrides)"}`);
  console.log(`Results root: ${runDir}`);
  if (dryRun) {
    console.log("Dry-run mode enabled (E2E_SUITE_DRY_RUN=true).");
    if (suiteIsV2) {
      console.log("\n--- Declarative Bridge Mapping ---");
      for (const s of suite.scenarios) {
        console.log(printBridgeMapping(s, suite.defaults));
        console.log("");
      }
      console.log("--- End Bridge Mapping ---\n");
    }
  }

  for (let index = 0; index < suite.scenarios.length; index += 1) {
    const scenario = suite.scenarios[index] ?? {};
    const id = String(scenario.id || `scenario-${index + 1}`);
    const description = String(scenario.description || "").trim();
    const enabled = toBool(scenario.enabled, true);
    const allowFailure = toBool(scenario.allowFailure, false);
    const mergeVideo = toBool(scenario.mergeVideo, true);
    const missingEnv = findMissingEnv(scenario.requiresEnv ?? [], process.env);
    const scenarioDir = path.join(
      runDir,
      `${String(index + 1).padStart(2, "0")}-${slugify(id)}`
    );
    const outputDir = path.join(scenarioDir, "pw-output");
    fs.mkdirSync(outputDir, { recursive: true });

    if (!enabled) {
      const skipped = {
        id,
        description,
        status: "skipped",
        reason: "Scenario disabled",
        allowFailure
      };
      scenarioResults.push(skipped);
      writeJson(path.join(scenarioDir, "summary.json"), skipped);
      continue;
    }

    if (missingEnv.length > 0) {
      const skipped = {
        id,
        description,
        status: "skipped",
        reason: `Missing required env: ${missingEnv.join(", ")}`,
        allowFailure
      };
      console.log(`- ${id}: skipped (${skipped.reason})`);
      scenarioResults.push(skipped);
      writeJson(path.join(scenarioDir, "summary.json"), skipped);
      continue;
    }

    // Auto-detect v2 declarative format vs v1 env-var format.
    const isV2 = isDeclarativeSuite(suite);
    const expandedEnv = isV2
      ? scenarioToEnv(scenario, suite.defaults)
      : expandScenarioEnv(scenario.env ?? {}, process.env);
    const playwrightArgs = Array.isArray(scenario.playwrightArgs)
      ? scenario.playwrightArgs.map((value) => String(value))
      : [];

    const runLabel = `${index + 1}/${suite.scenarios.length} ${id}`;
    console.log(`- ${runLabel}: started`);
    if (description) {
      console.log(`  ${description}`);
    }

    const startedAt = Date.now();
    let testExitCode = 0;
    let mergeExitCode = null;
    let status = dryRun ? "dry_run" : "passed";
    let reason = dryRun ? "Scenario not executed (dry-run mode)." : "";

    if (!dryRun) {
      const testEnv = {
        ...process.env,
        ...expandedEnv,
        PW_VIDEO_MODE: process.env.PW_VIDEO_MODE || "on"
      };

      const args = [
        "scripts/run-instance.mjs",
        "test:ui:state",
        "--",
        "--output",
        outputDir,
        ...playwrightArgs
      ];
      testExitCode = await runNode(args, testEnv);

      if (mergeVideo) {
        mergeExitCode = await runNode(
          ["scripts/merge-e2e-videos.mjs"],
          {
            ...testEnv,
            TEST_RESULTS_ROOT: outputDir
          }
        );
      }
    }

    if (testExitCode !== 0) {
      status = allowFailure ? "allowed_failure" : "failed";
      reason = `Playwright exited with code ${testExitCode}`;
    } else if (mergeExitCode != null && mergeExitCode !== 0) {
      status = allowFailure ? "allowed_failure" : "failed";
      reason = `Video merge exited with code ${mergeExitCode}`;
    }

    const artifacts = discoverArtifacts(outputDir);
    const finishedAt = Date.now();
    const scenarioSummary = {
      id,
      description,
      status,
      reason,
      allowFailure,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationSec: Number(((finishedAt - startedAt) / 1000).toFixed(3)),
      outputDir,
      appliedEnv: redactSensitive(expandedEnv),
      playwrightArgs,
      artifacts
    };
    scenarioResults.push(scenarioSummary);
    writeJson(path.join(scenarioDir, "summary.json"), scenarioSummary);

    console.log(`  ${id}: ${status}${reason ? ` (${reason})` : ""}`);
    if (status === "failed" && stopOnFailure) {
      console.log("Suite stopping on first failure (stopOnFailure=true).");
      break;
    }
  }

  const hardFailures = scenarioResults.filter(
    (item) => item.status === "failed"
  ).length;
  const suiteFinishedAt = Date.now();
  const suiteSummary = {
    name: suiteName,
    suiteFile,
    runDir,
    startedAt: new Date(suiteStartedAt).toISOString(),
    finishedAt: new Date(suiteFinishedAt).toISOString(),
    durationSec: Number(((suiteFinishedAt - suiteStartedAt) / 1000).toFixed(3)),
    stopOnFailure,
    dryRun,
    totals: {
      scenarios: scenarioResults.length,
      passed: scenarioResults.filter((item) => item.status === "passed").length,
      failed: hardFailures,
      skipped: scenarioResults.filter((item) => item.status === "skipped").length,
      allowedFailure: scenarioResults.filter((item) => item.status === "allowed_failure").length,
      dryRun: scenarioResults.filter((item) => item.status === "dry_run").length
    },
    scenarios: scenarioResults
  };
  writeJson(path.join(runDir, "suite-summary.json"), suiteSummary);

  console.log(JSON.stringify(suiteSummary, null, 2));

  // Build highlight reel from all scenario videos.
  if (process.env.PW_VIDEO_MODE !== "off") {
    console.log("\n=== Building highlight reel ===");
    const hlCode = await runNode(
      ["scripts/merge-e2e-highlight.mjs", runDir],
      { ...process.env }
    );
    if (hlCode !== 0) {
      console.warn("Highlight reel build failed (non-fatal).");
    }
  }

  if (hardFailures > 0) {
    process.exitCode = 1;
  }
}

function findMissingEnv(keys, env) {
  return keys
    .map((key) => String(key).trim())
    .filter(Boolean)
    .filter((key) => !hasValue(env[key]));
}

function expandScenarioEnv(envOverrides, env) {
  const expanded = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    expanded[key] = expandTemplate(String(value ?? ""), env);
  }
  return expanded;
}

function expandTemplate(input, env) {
  return input.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g,
    (_, name, _defaultToken, fallback = "") => {
      const value = env[name];
      if (hasValue(value)) {
        return String(value);
      }
      return fallback;
    }
  );
}

function discoverArtifacts(outputDir) {
  const dirs = findCandidateResultDirs(outputDir);
  const artifacts = [];
  for (const dir of dirs) {
    const entry = {
      dir,
      salesforceVideo: null,
      mergedVideo: null,
      ccpVideo: null,
      timeline: null,
      screenshotOnFailure: null
    };
    const salesforceVideo = path.join(dir, "video.webm");
    if (fs.existsSync(salesforceVideo)) {
      entry.salesforceVideo = salesforceVideo;
    }
    const merged = path.join(dir, "merged-e2e.webm");
    if (fs.existsSync(merged)) {
      entry.mergedVideo = merged;
    }
    const timeline = path.join(dir, "e2e-timeline.json");
    if (fs.existsSync(timeline)) {
      entry.timeline = timeline;
    }
    const screenshot = path.join(dir, "test-failed-1.png");
    if (fs.existsSync(screenshot)) {
      entry.screenshotOnFailure = screenshot;
    }
    const attachmentDir = path.join(dir, "attachments");
    if (fs.existsSync(attachmentDir)) {
      const ccpVideo = fs
        .readdirSync(attachmentDir)
        .filter((name) => /^connect-ccp-dial-video-.*\.webm$/i.test(name))
        .sort((a, b) => fs.statSync(path.join(attachmentDir, b)).mtimeMs - fs.statSync(path.join(attachmentDir, a)).mtimeMs)[0];
      if (ccpVideo) {
        entry.ccpVideo = path.join(attachmentDir, ccpVideo);
      }
    }
    artifacts.push(entry);
  }
  return artifacts;
}

function findCandidateResultDirs(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const out = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.shift();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    const hasMarker = entries.some(
      (entry) =>
        !entry.isDirectory() &&
        (entry.name === "video.webm" || entry.name === "e2e-timeline.json" || entry.name === "test-failed-1.png")
    );
    if (hasMarker && current !== rootDir) {
      out.push(current);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      queue.push(path.join(current, entry.name));
    }
  }
  return out;
}

function redactSensitive(values) {
  const output = {};
  for (const [key, value] of Object.entries(values)) {
    output[key] = isSensitiveKey(key) ? "<redacted>" : value;
  }
  return output;
}

function isSensitiveKey(key) {
  return /password|token|secret|account_sid|auth|mfa/i.test(key);
}

function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function toBool(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return /^(1|true|yes|on)$/i.test(value.trim());
  }
  return fallback;
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

void main();
