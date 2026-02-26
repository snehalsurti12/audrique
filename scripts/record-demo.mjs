#!/usr/bin/env node
/**
 * record-demo.mjs — Automated demo recording of Audrique Scenario Studio.
 *
 * Records a Playwright video showing the full Studio workflow:
 *   1. Landing page with existing scenario suite
 *   2. Building 3 working scenarios via the wizard:
 *      - inbound-agent-offer (direct call → accept → screen pop)
 *      - ivr-support-queue-branch (DTMF 1 → Support Queue + supervisor)
 *      - ivr-timeout-default-queue-branch (timeout → SCV Basic Queue + supervisor)
 *   3. Quick browse of the updated suite
 *   4. Showcasing a complex scenario (voicemail) in the wizard
 *   5. Running the suite (dry run or real execution against Salesforce)
 *
 * Usage:
 *   node scripts/record-demo.mjs                        # Dry run (default)
 *   node scripts/record-demo.mjs --real                  # Real execution
 *   node scripts/record-demo.mjs --headed                # Watch live
 *   node scripts/record-demo.mjs --slow 800              # Slow-mo ms
 *   node scripts/record-demo.mjs --real --headed --slow 600
 *
 * Output:
 *   test-results/demo/studio-demo.webm
 */

import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.resolve(ROOT, "test-results/demo");

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const headed = args.includes("--headed");
const realRun = args.includes("--real");
const slowIdx = args.indexOf("--slow");
const slowMo = slowIdx >= 0 ? parseInt(args[slowIdx + 1], 10) : 400;
const port = process.env.STUDIO_PORT || 4200;
const BASE = `http://localhost:${port}`;

// ── Helpers ───────────────────────────────────────────────────────────────

async function pause(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function clickNext(page) {
  await page.evaluate(() => document.getElementById("btn-next").click());
  await pause(300);
}

async function smoothScroll(page, selector, direction = "down", amount = 300) {
  const el = await page.$(selector);
  if (!el) return;
  await el.evaluate(
    (node, { dir, amt }) => {
      node.scrollBy({ top: dir === "down" ? amt : -amt, behavior: "smooth" });
    },
    { dir: direction, amt: amount }
  );
  await pause(600);
}

async function clearAndType(page, selector, text, delay = 50) {
  const el = await page.$(selector);
  if (!el) return;
  await el.scrollIntoViewIfNeeded();
  await pause(200);
  await el.click({ clickCount: 3 });
  await pause(100);
  await el.type(text, { delay });
  await pause(300);
}

async function toggleCheckbox(page, id, shouldBeChecked) {
  const isChecked = await page.evaluate(
    (elId) => document.getElementById(elId)?.checked,
    id
  );
  if (isChecked !== shouldBeChecked) {
    await page.evaluate((elId) => document.getElementById(elId).click(), id);
    await pause(800);
  }
}

async function selectOptionCard(page, groupName, value) {
  const card = await page.$(
    `[data-name="${groupName}"] [data-value="${value}"]`
  );
  if (card) {
    await card.scrollIntoViewIfNeeded();
    await pause(200);
    await card.click();
    await pause(600);
  }
}

async function getCurrentStepLabel(page) {
  return page.evaluate(() => {
    const active = document.querySelector(".progress-step.active");
    return active ? active.textContent.trim() : "";
  });
}

// ── Scenario Definitions ──────────────────────────────────────────────────
//
// These match the 3 working scenarios in full-suite-v2.json exactly.

// Read real Connect entrypoint from personal.env
const CONNECT_ENTRY_NUMBER = (() => {
  try {
    const envPath = path.resolve(ROOT, "instances/personal.env");
    const content = fs.readFileSync(envPath, "utf8");
    const match = content.match(/^CONNECT_ENTRYPOINT_NUMBER=(.+)$/m);
    return match ? match[1].trim() : "+18005550199";
  } catch {
    return "+18005550199";
  }
})();

const SCENARIOS = [
  {
    name: "Scenario 1: Direct Inbound Call",
    config: {
      callMode: "connect_ccp",
      callOutcome: "agent_answer",
      entryNumber: CONNECT_ENTRY_NUMBER,
      hasIvr: false,
      description:
        "Direct inbound call — agent accepts, VoiceCall screen pop appears.",
      id: "inbound-agent-offer",
      ringTimeout: null, // 90 = default
      execStatus: "active",
    },
  },
  {
    name: "Scenario 2: IVR DTMF 1 → Support Queue",
    config: {
      callMode: "connect_ccp",
      callOutcome: "agent_answer",
      entryNumber: CONNECT_ENTRY_NUMBER,
      hasIvr: true,
      ivrDigits: "1",
      ivrLabel: "Support",
      targetQueue: "Support Queue",
      supervisorEnabled: true,
      observeAgentOffer: true,
      description:
        "DTMF 1 routes to Support Queue — supervisor verifies queue + agent offer.",
      id: "ivr-support-queue-branch",
      ringTimeout: 120,
      execStatus: "soft-fail",
    },
  },
  {
    name: "Scenario 3: IVR Timeout → Default Queue",
    config: {
      callMode: "connect_ccp",
      callOutcome: "agent_answer",
      entryNumber: CONNECT_ENTRY_NUMBER,
      hasIvr: true,
      ivrDigits: "", // empty = timeout
      ivrLabel: "",
      targetQueue: "SCV Basic Queue",
      supervisorEnabled: true,
      observeAgentOffer: false,
      description:
        "No DTMF — IVR timeout routes to default SCV Basic Queue.",
      id: "ivr-timeout-default-queue-branch",
      ringTimeout: 180,
      execStatus: "soft-fail",
    },
  },
];

// ── Build One Scenario via Wizard ─────────────────────────────────────────

async function buildScenario(page, scenarioConfig, stepLog) {
  const c = scenarioConfig;

  // Start new scenario
  await page.evaluate(() =>
    document.getElementById("btn-new-scenario").click()
  );
  await pause(1200);

  // Walk through each wizard step dynamically
  let saved = false;
  let loopGuard = 0;

  while (!saved && loopGuard < 12) {
    loopGuard++;
    const stepLabel = await getCurrentStepLabel(page);

    if (stepLabel.includes("Call")) {
      // ── Call Setup ──
      console.log("      Call Setup");
      stepLog.steps.push({ step: "Call Setup", ms: Date.now() });
      // CCP mode is default — only change if different
      if (c.callMode && c.callMode !== "connect_ccp") {
        await selectOptionCard(page, "call-mode", c.callMode);
      }
      // Call outcome — agent_answer is default
      if (c.callOutcome && c.callOutcome !== "agent_answer") {
        await selectOptionCard(page, "call-outcome", c.callOutcome);
        await pause(600);
      }
      // Set real Connect entrypoint number
      if (c.entryNumber) {
        await clearAndType(page, "#entry-number", c.entryNumber, 30);
      }
      await pause(400);
    } else if (stepLabel.includes("IVR")) {
      // ── IVR & Routing ──
      console.log("      IVR & Routing");
      stepLog.steps.push({ step: "IVR & Routing", ms: Date.now() });
      if (c.hasIvr) {
        await toggleCheckbox(page, "has-ivr", true);
        await pause(1000);

        // Fill IVR digit in the first flowchart level
        if (c.ivrDigits) {
          const digitsInput = await page.$(".ivr-level-digits");
          if (digitsInput) {
            await digitsInput.scrollIntoViewIfNeeded();
            await digitsInput.click();
            await digitsInput.type(c.ivrDigits, { delay: 80 });
            await pause(400);
          }
        }

        // Fill optional label
        if (c.ivrLabel) {
          const labelInput = await page.$(".ivr-level-label");
          if (labelInput) {
            await labelInput.click();
            await labelInput.type(c.ivrLabel, { delay: 60 });
            await pause(400);
          }
        }

        // Set target queue
        if (c.targetQueue) {
          await clearAndType(page, "#target-queue", c.targetQueue, 40);
        }

        // Scroll to show the full flowchart
        await smoothScroll(page, ".wizard-step-container", "down", 200);
        await pause(600);
      }
    } else if (stepLabel.includes("Agent")) {
      // ── Agent ──
      console.log("      Agent");
      stepLog.steps.push({ step: "Agent", ms: Date.now() });
      // Screen pop is on by default — no action needed
      await pause(400);
    } else if (stepLabel.includes("Supervisor")) {
      // ── Supervisor ──
      console.log("      Supervisor");
      stepLog.steps.push({ step: "Supervisor", ms: Date.now() });
      // Supervisor toggle may be pre-checked from IVR auto-set
      if (c.supervisorEnabled !== undefined) {
        await toggleCheckbox(page, "supervisor-enabled", c.supervisorEnabled);
        await pause(600);
      }

      if (c.observeAgentOffer !== undefined) {
        await toggleCheckbox(
          page,
          "observe-agent-offer",
          c.observeAgentOffer
        );
        await pause(400);
      }

      await pause(400);
    } else if (stepLabel.includes("Details")) {
      // ── Details ──
      console.log("      Details");
      stepLog.steps.push({ step: "Details", ms: Date.now() });
      if (c.description) {
        await clearAndType(page, "#scenario-desc", c.description, 30);
      }
      if (c.id) {
        await clearAndType(page, "#scenario-id", c.id, 35);
      }
      if (c.ringTimeout && c.ringTimeout !== 90) {
        await clearAndType(page, "#ring-timeout", String(c.ringTimeout));
      }
      if (c.execStatus && c.execStatus !== "active") {
        await selectOptionCard(page, "exec-status", c.execStatus);
      }
      await pause(600);
    } else if (stepLabel.includes("Review")) {
      // ── Review ──
      console.log("      Review — previewing...");
      stepLog.steps.push({ step: "Review", ms: Date.now() });
      await smoothScroll(page, ".wizard-step-container", "down", 200);
      await pause(1000);

      // Click "Preview & Save" (= Next on review step)
      await clickNext(page);
      await pause(1500);

      // Show JSON preview briefly
      await smoothScroll(page, ".preview-body", "down", 250);
      await pause(1200);

      // Switch to Visual Flow tab
      await page.evaluate(() => {
        const tab = document.querySelector('.preview-tab[data-tab="steps"]');
        if (tab) tab.click();
      });
      await pause(1200);

      // Save to suite
      console.log("      Saving to suite...");
      await page.evaluate(() =>
        document.getElementById("btn-save-scenario").click()
      );
      await pause(1500);

      // Close preview → back to landing
      await page.evaluate(() =>
        document.getElementById("btn-back-to-edit")?.click()
      );
      await pause(400);
      await page.evaluate(() =>
        document.getElementById("btn-cancel-edit")?.click()
      );
      await pause(800);

      saved = true;
    }

    // Advance to next step (unless we just saved)
    if (!saved) {
      await clickNext(page);
      await pause(800);
    }
  }

  if (!saved) {
    console.warn("      WARNING: wizard loop ended without saving!");
  }
}

// ── Showcase Complex Scenario (Voicemail) ─────────────────────────────────
//
// Quick walkthrough of the voicemail outcome path to show advanced capability.
// Does NOT save — just shows the wizard and cancels.

async function showcaseComplexScenario(page) {
  console.log("\n   Showcasing voicemail scenario (wizard only)...");

  // Start new scenario
  await page.evaluate(() =>
    document.getElementById("btn-new-scenario").click()
  );
  await pause(1200);

  // Select "Voicemail" call outcome to show the extra fields
  await selectOptionCard(page, "call-outcome", "voicemail");
  await pause(1000);

  // Scroll to show voicemail fields
  await smoothScroll(page, ".wizard-step-container", "down", 200);
  await pause(1200);

  // Type voicemail text
  await clearAndType(
    page,
    "#voicemail-text",
    "Hi, I am calling about my account balance. Please call me back.",
    30
  );
  await pause(800);

  // Go to next step to show IVR page briefly
  await clickNext(page);
  await pause(1000);

  // Toggle IVR on to show the flowchart
  await toggleCheckbox(page, "has-ivr", true);
  await pause(1000);

  // Fill IVR level
  const digitsInput = await page.$(".ivr-level-digits");
  if (digitsInput) {
    await digitsInput.click();
    await digitsInput.type("2", { delay: 80 });
    await pause(400);
  }
  const labelInput = await page.$(".ivr-level-label");
  if (labelInput) {
    await labelInput.click();
    await labelInput.type("Billing", { delay: 60 });
    await pause(400);
  }

  // Add a second IVR level via the (+) button
  const addBtn = await page.$(".ivr-fc-add-btn");
  if (addBtn) {
    await addBtn.scrollIntoViewIfNeeded();
    await pause(300);
    await addBtn.click();
    await pause(1000);

    // Fill second level
    const allDigits = await page.$$(".ivr-level-digits");
    const allLabels = await page.$$(".ivr-level-label");
    if (allDigits.length > 1) {
      await allDigits[1].scrollIntoViewIfNeeded();
      await allDigits[1].click();
      await allDigits[1].type("3", { delay: 80 });
    }
    if (allLabels.length > 1) {
      await allLabels[1].click();
      await allLabels[1].type("Account Balance", { delay: 50 });
    }
    await pause(1200);
  }

  // Scroll to show the full flowchart
  await smoothScroll(page, ".wizard-step-container", "down", 300);
  await pause(1500);

  // Cancel — don't save this one
  await page.evaluate(() =>
    document.getElementById("btn-cancel-edit")?.click()
  );
  await pause(1000);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log("Recording Audrique Studio demo...");
  console.log(`  Studio: ${BASE}`);
  console.log(`  Output: ${OUTPUT_DIR}/`);
  console.log(`  Headed: ${headed}`);
  console.log(`  Slow-mo: ${slowMo}ms`);
  console.log(`  Mode:   ${realRun ? "REAL EXECUTION (Salesforce + Connect)" : "Dry run (validation only)"}`);
  console.log("");

  const browser = await chromium.launch({
    headless: !headed,
    slowMo,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: {
      dir: OUTPUT_DIR,
      size: { width: 1440, height: 900 },
    },
  });

  const page = await context.newPage();

  // ── Phase timeline for build-demo-video.mjs ─────────────────────────
  const demoTimeline = {
    recordingStartMs: null,
    browseStartMs: null,
    browseEndMs: null,
    wizardStartMs: null,
    wizardScenarios: [],
    wizardEndMs: null,
    reviewStartMs: null,
    reviewEndMs: null,
    showcaseStartMs: null,
    showcaseEndMs: null,
    suiteRunStartMs: null,
    recordingEndMs: null,
  };

  try {
    // ── 1. Open Studio ──────────────────────────────────────────────────
    console.log("1. Opening Scenario Studio...");
    await page.goto(BASE, { waitUntil: "networkidle" });
    await pause(2000);
    demoTimeline.recordingStartMs = Date.now();

    // Wait for suite to auto-load
    await page.waitForSelector(".scenario-card", { timeout: 10000 });
    await pause(1500);

    // ── 2. Browse existing scenarios briefly ────────────────────────────
    console.log("2. Browsing existing scenarios...");
    demoTimeline.browseStartMs = Date.now();
    const cards = await page.$$(".scenario-card");
    const browseCount = Math.min(cards.length, 3);

    for (let i = 0; i < browseCount; i++) {
      const card = (await page.$$(".scenario-card"))[i];
      if (!card) break;
      await card.click();
      await pause(1200);
      await smoothScroll(page, ".live-flow", "down", 150);
      await pause(600);
    }

    // Back to landing
    await page.evaluate(() =>
      document.getElementById("btn-cancel-edit")?.click()
    );
    await pause(1000);
    demoTimeline.browseEndMs = Date.now();

    // ── 3–5. Build the 3 working scenarios ──────────────────────────────
    demoTimeline.wizardStartMs = Date.now();
    for (let i = 0; i < SCENARIOS.length; i++) {
      const s = SCENARIOS[i];
      console.log(`\n${i + 3}. Building: ${s.name}`);
      const stepLog = { id: s.config.id, name: s.name, startMs: Date.now(), steps: [], savedAtMs: null };
      await buildScenario(page, s.config, stepLog);
      stepLog.savedAtMs = Date.now();
      demoTimeline.wizardScenarios.push(stepLog);
    }
    demoTimeline.wizardEndMs = Date.now();

    // ── 6. Browse updated suite — verify all 3 are there ───────────────
    console.log("\n6. Reviewing built scenarios in sidebar...");
    demoTimeline.reviewStartMs = Date.now();
    await pause(1000);

    for (const s of SCENARIOS) {
      const card = await page.$(
        `.scenario-card[data-id="${s.config.id}"]`
      );
      if (card) {
        await card.scrollIntoViewIfNeeded();
        await card.click();
        await pause(1500);
        // Scroll the live preview to show the generated step flow
        await smoothScroll(page, ".live-flow", "down", 200);
        await pause(800);
      }
    }

    // Back to landing
    await page.evaluate(() =>
      document.getElementById("btn-cancel-edit")?.click()
    );
    await pause(800);
    demoTimeline.reviewEndMs = Date.now();

    // ── 7. Showcase a complex scenario (voicemail + multi-level IVR) ───
    console.log("\n7. Showcasing complex scenario capabilities...");
    demoTimeline.showcaseStartMs = Date.now();
    await showcaseComplexScenario(page);
    demoTimeline.showcaseEndMs = Date.now();

    // ── 8. Run suite ────────────────────────────────────────────────────
    if (realRun) {
      console.log("\n8. Running REAL suite execution against Salesforce...");
    } else {
      console.log("\n8. Running dry run to validate all scenarios...");
    }

    // Open run panel
    demoTimeline.suiteRunStartMs = Date.now();
    await page.evaluate(() =>
      document.getElementById("btn-run-suite")?.click()
    );
    await pause(1500);

    if (realRun) {
      // Real execution — click the main "Run" area (startRun with dryRun=false)
      // We trigger via the rerun button after clicking dry run panel open,
      // or directly call startRun(false) from the page context
      await page.evaluate(() => {
        // Call the app's startRun function directly for real execution
        if (typeof startRun === "function") {
          startRun(false);
        }
      });
    } else {
      // Dry run
      await page.evaluate(() =>
        document.getElementById("btn-run-dry")?.click()
      );
    }
    await pause(2000);

    // Wait for output to appear
    const runTimeout = realRun ? 60000 : 15000;
    await page
      .waitForSelector(".run-line", { timeout: runTimeout })
      .catch(() => {});
    await pause(3000);

    // Scroll terminal as output streams in
    const scrollRounds = realRun ? 20 : 5;
    const scrollPause = realRun ? 3000 : 1500;
    for (let i = 0; i < scrollRounds; i++) {
      await smoothScroll(page, "#run-terminal-body", "down", 500);
      await pause(scrollPause);
    }

    // Wait for completion (real runs can take minutes)
    const completeTimeout = realRun ? 600000 : 30000; // 10 min for real
    await page
      .waitForSelector(".run-line-done", { timeout: completeTimeout })
      .catch(() => {
        console.log("   (timed out waiting for completion marker)");
      });
    await pause(3000);

    // Final scroll to show results
    await smoothScroll(page, "#run-terminal-body", "down", 1000);
    await pause(2000);

    // ── 9. Final pause on summary ─────────────────────────────────────
    console.log("\n9. Demo complete!");
    demoTimeline.recordingEndMs = Date.now();
    await pause(3000);

    console.log("\nDemo recording complete!");
  } catch (err) {
    console.error("Demo error:", err.message);
    console.error(err.stack);
    await page.screenshot({ path: path.join(OUTPUT_DIR, "demo-error.png") });
  }

  // Write phase timeline for build-demo-video.mjs
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "demo-timeline.json"),
    JSON.stringify(demoTimeline, null, 2)
  );
  console.log(`Timeline saved: ${path.join(OUTPUT_DIR, "demo-timeline.json")}`);

  // Close and save video
  await page.close();
  await context.close();
  await browser.close();

  // Find the generated video file and copy (sort by mtime, newest first)
  const files = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith(".webm") && f !== "studio-demo.webm")
    .sort((a, b) =>
      fs.statSync(path.join(OUTPUT_DIR, b)).mtimeMs -
      fs.statSync(path.join(OUTPUT_DIR, a)).mtimeMs
    );
  if (files.length > 0) {
    const latest = files[0];
    const src = path.join(OUTPUT_DIR, latest);
    const dest = path.join(OUTPUT_DIR, "studio-demo.webm");
    fs.copyFileSync(src, dest);
    console.log(`\nVideo saved: ${dest}`);
    console.log(
      `File size: ${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB`
    );
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
