#!/usr/bin/env node
/**
 * create-scenario.mjs — Interactive Q&A CLI for generating declarative
 * v2 test scenarios. No framework knowledge required.
 *
 * Usage:
 *   node scripts/create-scenario.mjs
 *   node scripts/create-scenario.mjs --output scenarios/e2e/my-suite.json
 *   node scripts/create-scenario.mjs --append scenarios/e2e/full-suite-v2.json
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const outputFlag = args.indexOf("--output");
const appendFlag = args.indexOf("--append");
const outputFile = outputFlag >= 0 ? args[outputFlag + 1] : null;
const appendFile = appendFlag >= 0 ? args[appendFlag + 1] : null;

// ── Readline setup ──────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true
});

function ask(question, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

function askYesNo(question, defaultValue = true) {
  const hint = defaultValue ? "[Y/n]" : "[y/N]";
  return new Promise((resolve) => {
    rl.question(`  ${question} ${hint}: `, (answer) => {
      const val = answer.trim().toLowerCase();
      if (val === "") resolve(defaultValue);
      else resolve(val === "y" || val === "yes" || val === "true" || val === "1");
    });
  });
}

function askChoice(question, options) {
  return new Promise((resolve) => {
    console.log(`  ${question}`);
    options.forEach((opt, i) => {
      console.log(`    ${i + 1}. ${opt.label}${opt.default ? " (default)" : ""}`);
    });
    rl.question(`  Choice [1]: `, (answer) => {
      const index = parseInt(answer.trim(), 10) - 1;
      if (index >= 0 && index < options.length) {
        resolve(options[index].value);
      } else {
        resolve(options[0].value);
      }
    });
  });
}

// ── Main flow ───────────────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log("  ╔══════════════════════════════════════════╗");
  console.log("  ║   Audrique — Test Scenario Creator       ║");
  console.log("  ║   Answer questions to build a test case  ║");
  console.log("  ╚══════════════════════════════════════════╝");
  console.log("");

  // ── Step 1: The Call ────────────────────────────────────────────────────
  console.log("  ── Step 1: The Incoming Call ──\n");

  const entryNumber = await ask(
    "What number does the caller dial?",
    process.env.CONNECT_ENTRYPOINT_NUMBER || "+18005550199"
  );

  const callMode = await askChoice("How is the call placed?", [
    { label: "CCP softphone dials the number automatically", value: "connect_ccp", default: true },
    { label: "Twilio API places the call", value: "twilio" },
    { label: "Manual — tester dials from a real phone", value: "manual" }
  ]);

  // ── Step 2: IVR / Routing ─────────────────────────────────────────────
  console.log("\n  ── Step 2: IVR & Routing ──\n");

  const hasIvr = await askYesNo("Does the caller hear an IVR menu?", false);
  let ivrDigits = "";
  let ivrDelayMs = 3500;
  let targetQueue = "";

  if (hasIvr) {
    ivrDigits = await ask("What does the caller press? (e.g. 1, or 1,3 for multi-level)", "1");
    ivrDelayMs = parseInt(
      await ask("Seconds to wait before pressing (IVR greeting length)?", "4"),
      10
    ) * 1000;
    targetQueue = await ask("Which queue should the call land in?", "Support Queue");
  } else {
    const routeType = await askChoice("How is the call routed?", [
      { label: "Direct to agent (no queue)", value: "direct", default: true },
      { label: "To a specific queue (IVR timeout / default route)", value: "queue" },
      { label: "Don't know / auto-detect", value: "auto" }
    ]);
    if (routeType === "queue") {
      targetQueue = await ask("Queue name?", "SCV Basic Queue");
    }
  }

  // ── Step 3: What should the agent see? ─────────────────────────────────
  console.log("\n  ── Step 3: Agent Experience ──\n");

  const expectScreenPop = await askYesNo("Should a VoiceCall screen pop appear after accept?", true);
  const expectTranscript = await askYesNo("Should real-time transcript be verified?", false);

  let transcriptPhrase = "";
  let transcriptTimeout = 30;
  if (expectTranscript) {
    transcriptPhrase = await ask("Expected phrase in transcript (or blank for any growth)");
    transcriptTimeout = parseInt(await ask("Transcript wait timeout (seconds)?", "30"), 10);
  }

  // ── Step 4: Supervisor monitoring ───────────────────────────────────────
  console.log("\n  ── Step 4: Supervisor Monitoring ──\n");

  let supervisorEnabled = false;
  let observeAgentOffer = false;
  let supervisorSurface = "Command Center for Service";

  if (targetQueue) {
    supervisorEnabled = await askYesNo(
      `Should a supervisor verify the call appears in "${targetQueue}"?`,
      true
    );
  } else {
    supervisorEnabled = await askYesNo("Should a supervisor monitor this call?", false);
    if (supervisorEnabled) {
      targetQueue = await ask("Which queue should the supervisor watch?");
    }
  }

  if (supervisorEnabled) {
    observeAgentOffer = await askYesNo("Should supervisor also verify the agent gets the offer?", true);
    supervisorSurface = await ask("Supervisor app/surface name?", "Command Center for Service");
  }

  // ── Step 5: Test identity ──────────────────────────────────────────────
  console.log("\n  ── Step 5: Test Details ──\n");

  const description = await ask("Describe this test in one line",
    targetQueue
      ? `Inbound call routed to ${targetQueue}${hasIvr ? ` via IVR (press ${ivrDigits})` : ""}`
      : "Direct inbound call — agent accepts and verifies screen pop"
  );
  const id = await ask(
    "Scenario ID (short, kebab-case)",
    slugify(description) || "my-test-case"
  );

  // ── Step 6: Timeouts ───────────────────────────────────────────────────
  console.log("\n  ── Step 6: Timeouts ──\n");

  const ringTimeout = parseInt(
    await ask("Max seconds to wait for incoming call?", hasIvr ? "120" : "90"),
    10
  );
  const allowFailure = await askYesNo("Allow this scenario to fail without stopping the suite?", false);

  // ── Build scenario ──────────────────────────────────────────────────────
  console.log("\n  ── Building Scenario ──\n");

  const scenario = buildScenario({
    id,
    description,
    entryNumber,
    callMode,
    hasIvr,
    ivrDigits,
    ivrDelayMs,
    targetQueue,
    supervisorEnabled,
    observeAgentOffer,
    supervisorSurface,
    expectScreenPop,
    expectTranscript,
    transcriptPhrase,
    transcriptTimeout,
    ringTimeout,
    allowFailure
  });

  // ── Display result ──────────────────────────────────────────────────────
  const json = JSON.stringify(scenario, null, 2);
  console.log("  Generated scenario:\n");
  console.log(indent(json, 4));
  console.log("");

  // ── Save ────────────────────────────────────────────────────────────────
  if (appendFile) {
    appendToSuite(appendFile, scenario);
  } else if (outputFile) {
    writeNewSuite(outputFile, scenario);
  } else {
    const shouldSave = await askYesNo("Save this scenario?", true);
    if (shouldSave) {
      const saveTo = await ask(
        "Save to file?",
        "scenarios/e2e/full-suite-v2.json"
      );
      const resolved = path.resolve(process.cwd(), saveTo);
      if (fs.existsSync(resolved)) {
        appendToSuite(resolved, scenario);
      } else {
        writeNewSuite(resolved, scenario);
      }
    }
  }

  console.log("  Done!\n");
  rl.close();
}

// ── Scenario builder ────────────────────────────────────────────────────────

function buildScenario(opts) {
  const scenario = {
    id: opts.id,
    description: opts.description
  };

  if (opts.allowFailure) {
    scenario.allowFailure = true;
  }

  // Call trigger
  const callTrigger = { mode: opts.callMode, entryNumber: opts.entryNumber };
  if (opts.hasIvr) {
    callTrigger.ivrDigits = opts.ivrDigits.replace(/,/g, "");
    callTrigger.ivrInitialDelayMs = opts.ivrDelayMs;
    if (opts.ivrDigits.includes(",")) {
      // Multi-level IVR: separate digits
      callTrigger.ivrDigits = opts.ivrDigits.split(",").map((d) => d.trim()).join("");
      callTrigger.ivrInterDigitDelayMs = 450;
    }
    callTrigger.dtmfMinCallElapsedSec = 5;
  } else if (opts.targetQueue && !opts.ivrDigits) {
    // No IVR, but targeting a queue (timeout routing)
    callTrigger.ivrDigits = "";
  }
  scenario.callTrigger = callTrigger;

  // Steps
  const steps = [];
  steps.push({ action: "preflight" });

  if (opts.supervisorEnabled) {
    const supervisorStep = {
      action: "start_supervisor",
      queue: opts.targetQueue
    };
    if (opts.supervisorSurface !== "Command Center for Service") {
      supervisorStep.surface = opts.supervisorSurface;
    }
    if (opts.observeAgentOffer) {
      supervisorStep.observeAgentOffer = true;
    }
    supervisorStep.checkBeforeAccept = true;
    steps.push(supervisorStep);
  }

  steps.push({ action: "trigger_call" });
  steps.push({ action: "detect_incoming", timeoutSec: opts.ringTimeout });
  steps.push({ action: "accept_call" });

  if (opts.expectScreenPop) {
    steps.push({ action: "verify_screen_pop" });
  }

  if (opts.expectTranscript) {
    const transcriptStep = { action: "verify_transcript" };
    if (opts.transcriptPhrase) {
      transcriptStep.expectPhrase = opts.transcriptPhrase;
    }
    transcriptStep.timeoutSec = opts.transcriptTimeout;
    steps.push(transcriptStep);
  }

  scenario.steps = steps;

  // Assertions
  const expect = [];
  expect.push({ type: "e2e.call_connected", equals: true });

  if (opts.supervisorEnabled && opts.targetQueue) {
    expect.push({
      type: "e2e.supervisor_queue_observed",
      queue: opts.targetQueue
    });
  }
  if (opts.observeAgentOffer) {
    expect.push({ type: "e2e.supervisor_agent_offer", equals: true });
  }
  if (opts.expectScreenPop) {
    expect.push({ type: "e2e.screen_pop_detected", equals: true });
  }
  if (opts.expectTranscript) {
    const assertion = { type: "e2e.transcript_captured", equals: true };
    if (opts.transcriptPhrase) {
      assertion.contains = opts.transcriptPhrase;
    }
    expect.push(assertion);
  }

  scenario.expect = expect;

  // Timeouts (only if non-default)
  const timeouts = {};
  if (opts.ringTimeout !== 90) {
    timeouts.ringSec = opts.ringTimeout;
  }
  if (opts.supervisorEnabled && opts.ringTimeout > 120) {
    timeouts.supervisorQueueSec = opts.ringTimeout;
    timeouts.offerAfterQueueSec = opts.ringTimeout;
  }
  if (Object.keys(timeouts).length > 0) {
    scenario.timeouts = timeouts;
  }

  return scenario;
}

// ── File I/O ────────────────────────────────────────────────────────────────

function appendToSuite(filePath, scenario) {
  const resolved = path.resolve(process.cwd(), filePath);
  const suite = JSON.parse(fs.readFileSync(resolved, "utf8"));

  // Check for duplicate ID
  const existing = suite.scenarios.findIndex((s) => s.id === scenario.id);
  if (existing >= 0) {
    console.log(`  Replacing existing scenario "${scenario.id}" at index ${existing}.`);
    suite.scenarios[existing] = scenario;
  } else {
    suite.scenarios.push(scenario);
    console.log(`  Appended scenario "${scenario.id}" to ${filePath} (${suite.scenarios.length} total).`);
  }

  fs.writeFileSync(resolved, JSON.stringify(suite, null, 2) + "\n");
}

function writeNewSuite(filePath, scenario) {
  const resolved = path.resolve(process.cwd(), filePath);
  const suite = {
    name: "Custom Test Suite",
    version: 2,
    stopOnFailure: false,
    defaults: {
      callTrigger: { mode: "connect_ccp" },
      timeouts: {
        ringSec: 90,
        supervisorQueueSec: 90,
        supervisorAgentOfferSec: 90,
        offerAfterQueueSec: 120
      }
    },
    scenarios: [scenario]
  };

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(suite, null, 2) + "\n");
  console.log(`  Created new suite at ${filePath} with 1 scenario.`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function indent(text, spaces) {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

// ── Run ─────────────────────────────────────────────────────────────────────

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
