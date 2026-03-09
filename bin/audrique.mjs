#!/usr/bin/env node

/**
 * Audrique CLI — Entry point for all framework commands.
 *
 * Usage:
 *   audrique run [suite-file]        Run a declarative test suite
 *   audrique run --refresh-auth       Refresh expired sessions before running
 *   audrique run --dry-run            Validate suite without executing
 *   audrique auth                    Capture both SF and Connect sessions
 *   audrique auth:sf                 Capture Salesforce session
 *   audrique auth:connect            Capture Connect CCP session
 *   audrique studio                  Start Scenario Studio at localhost:4200
 *   audrique discover                Run org auto-discovery
 *   audrique merge                   Merge video recordings
 *   audrique highlight               Generate highlight reel
 *   audrique ingest                  Backfill test results into PostgreSQL
 *   audrique help                    Show this help message
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const [, , command, ...args] = process.argv;

const COMMANDS = {
  run: {
    desc: "Run a declarative test suite",
    usage: "audrique run [suite-file] [--dry-run] [--refresh-auth] [--instance <name>]",
  },
  auth: {
    desc: "Capture both SF and Connect sessions (headless with vault creds)",
    usage: "audrique auth [--force] [--sf-only] [--connect-only] [--instance <name>]",
  },
  studio: {
    desc: "Start Scenario Studio (visual scenario builder)",
    usage: "audrique studio [--port <port>]",
  },
  "auth:sf": {
    desc: "Capture Salesforce authentication session",
    usage: "audrique auth:sf --instance <name>",
  },
  "auth:connect": {
    desc: "Capture Amazon Connect CCP session",
    usage: "audrique auth:connect --instance <name>",
  },
  discover: {
    desc: "Run org auto-discovery (presence statuses, queues, skills, hours)",
    usage: "audrique discover --instance <name>",
  },
  merge: {
    desc: "Merge parallel video recordings into evidence video",
    usage: "audrique merge [results-dir]",
  },
  highlight: {
    desc: "Generate highlight reel from suite run",
    usage: "audrique highlight [results-dir]",
  },
  doctor: {
    desc: "Pre-flight check — validate tools, network, and credentials",
    usage: "audrique doctor",
  },
  ingest: {
    desc: "Backfill existing test results into PostgreSQL",
    usage: "audrique ingest [results-dir]",
  },
};

function showHelp() {
  console.log(`
  Audrique — End-to-end testing for contact centers

  Usage: audrique <command> [options]

  Commands:
`);
  for (const [name, info] of Object.entries(COMMANDS)) {
    console.log(`    ${name.padEnd(18)} ${info.desc}`);
  }
  console.log(`    ${"help".padEnd(18)} Show this help message`);
  console.log(`
  Examples:

    audrique run                                    # Run default suite (full-suite-v2.json)
    audrique run --refresh-auth                      # Auto-refresh expired sessions, then run
    audrique run scenarios/e2e/my-suite.json        # Run specific suite
    audrique run --dry-run                           # Validate without executing
    audrique auth                                    # Capture both SF and Connect sessions
    audrique auth --sf-only --force                  # Force refresh SF session only
    audrique studio                                  # Open Scenario Studio
    INSTANCE=myorg audrique run --refresh-auth       # Full autonomous run with auth

  Environment:

    INSTANCE=<name>          Instance profile to use (from instances/<name>.env)
    E2E_SUITE_DRY_RUN=true   Validate suite without running tests
    PW_VIDEO_MODE=on         Enable video recording

  Documentation: https://github.com/your-org/audrique
`);
}

function parseArgs(args) {
  const parsed = { positional: [], flags: {} };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].replace(/^--/, "");
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        parsed.flags[key] = next;
        i++;
      } else {
        parsed.flags[key] = true;
      }
    } else {
      parsed.positional.push(args[i]);
    }
  }
  return parsed;
}

function exec(script, env = {}) {
  const fullEnv = { ...process.env, ...env };
  const child = spawn("node", [path.join(ROOT, script)], {
    cwd: ROOT,
    env: fullEnv,
    stdio: "inherit",
  });
  child.on("close", (code) => process.exit(code ?? 0));
}

function execAsync(script, env = {}, extraArgs = []) {
  return new Promise((resolve) => {
    const fullEnv = { ...process.env, ...env };
    const child = spawn("node", [path.join(ROOT, script), ...extraArgs], {
      cwd: ROOT,
      env: fullEnv,
      stdio: "inherit",
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

// ── Command dispatch ──────────────────────────────────────────────────────

if (!command || command === "help" || command === "--help" || command === "-h") {
  showHelp();
  process.exit(0);
}

const { positional, flags } = parseArgs(args);

void (async () => {
switch (command) {
  case "run": {
    const env = {};
    const suiteFile = positional[0] || process.env.E2E_SUITE_FILE || "scenarios/e2e/full-suite-v2.json";
    env.E2E_SUITE_FILE = suiteFile;
    if (flags["dry-run"]) env.E2E_SUITE_DRY_RUN = "true";
    if (flags.instance) env.INSTANCE = flags.instance;

    if (flags["refresh-auth"]) {
      // Run auth refresh first (via run-instance.mjs for vault resolution), then suite
      const authExtraArgs = ["refresh-auth"];
      if (flags.force) authExtraArgs.push("--", "--force");
      const authCode = await execAsync("scripts/run-instance.mjs", env, authExtraArgs);
      if (authCode !== 0) {
        console.error("Auth refresh failed. Aborting suite run.");
        process.exit(authCode);
      }
    }

    exec("scripts/run-instance-e2e-suite.mjs", env);
    break;
  }

  case "studio": {
    const env = {};
    if (flags.port) env.PORT = flags.port;
    exec("webapp/server.mjs", env);
    break;
  }

  case "auth:sf": {
    const env = {};
    if (flags.instance) env.INSTANCE = flags.instance;
    const sfChild = spawn("node", [path.join(ROOT, "scripts/run-instance.mjs"), "auth:state"], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    sfChild.on("close", (code) => process.exit(code ?? 0));
    break;
  }

  case "auth:connect": {
    const env = {};
    if (flags.instance) env.INSTANCE = flags.instance;
    const ccpChild = spawn("node", [path.join(ROOT, "scripts/run-instance.mjs"), "auth:connect-state"], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    ccpChild.on("close", (code) => process.exit(code ?? 0));
    break;
  }

  case "auth": {
    const env = {};
    if (flags.instance) env.INSTANCE = flags.instance;
    const authArgs = [];
    if (flags.force) authArgs.push("--force");
    if (flags["sf-only"]) authArgs.push("--sf-only");
    if (flags["connect-only"]) authArgs.push("--connect-only");
    // run-instance.mjs expects extra args after "--" separator
    const spawnArgs = [path.join(ROOT, "scripts/run-instance.mjs"), "refresh-auth"];
    if (authArgs.length > 0) spawnArgs.push("--", ...authArgs);
    const refreshChild = spawn("node", spawnArgs, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    refreshChild.on("close", (code) => process.exit(code ?? 0));
    break;
  }

  case "discover": {
    console.log("Org discovery is currently integrated into the preflight step.");
    console.log("Run a suite with preflight to trigger auto-discovery:");
    console.log("  audrique run --dry-run");
    process.exit(0);
    break;
  }

  case "merge": {
    exec("scripts/merge-e2e-videos.mjs");
    break;
  }

  case "highlight": {
    exec("scripts/merge-e2e-highlight.mjs");
    break;
  }

  case "doctor": {
    exec("scripts/doctor.mjs");
    break;
  }

  case "ingest": {
    const ingestArgs = positional.length > 0 ? positional : [];
    const ingestChild = spawn("node", [path.join(ROOT, "scripts/ingest-results.mjs"), ...ingestArgs], {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit",
    });
    ingestChild.on("close", (code) => process.exit(code ?? 0));
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run "audrique help" for available commands.');
    process.exit(1);
}
})();
