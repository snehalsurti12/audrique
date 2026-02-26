#!/usr/bin/env node

/**
 * Audrique CLI — Entry point for all framework commands.
 *
 * Usage:
 *   audrique run [suite-file]        Run a declarative test suite
 *   audrique run --dry-run            Validate suite without executing
 *   audrique studio                  Start Scenario Studio at localhost:4200
 *   audrique auth:sf                 Capture Salesforce session
 *   audrique auth:connect            Capture Connect CCP session
 *   audrique discover                Run org auto-discovery
 *   audrique merge                   Merge video recordings
 *   audrique highlight               Generate highlight reel
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
    usage: "audrique run [suite-file] [--dry-run] [--instance <name>]",
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
    audrique run scenarios/e2e/my-suite.json        # Run specific suite
    audrique run --dry-run                           # Validate without executing
    audrique studio                                  # Open Scenario Studio
    INSTANCE=myorg audrique auth:sf                  # Capture SF session
    INSTANCE=myorg audrique run                      # Run suite against your org

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

// ── Command dispatch ──────────────────────────────────────────────────────

if (!command || command === "help" || command === "--help" || command === "-h") {
  showHelp();
  process.exit(0);
}

const { positional, flags } = parseArgs(args);

switch (command) {
  case "run": {
    const env = {};
    const suiteFile = positional[0] || "scenarios/e2e/full-suite-v2.json";
    env.E2E_SUITE_FILE = suiteFile;
    if (flags["dry-run"]) env.E2E_SUITE_DRY_RUN = "true";
    if (flags.instance) env.INSTANCE = flags.instance;
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

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run "audrique help" for available commands.');
    process.exit(1);
}
