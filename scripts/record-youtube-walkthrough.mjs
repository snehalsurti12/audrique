#!/usr/bin/env node
/**
 * record-youtube-walkthrough.mjs — YouTube-quality Studio walkthrough recorder.
 *
 * Records a 1920x1080 Playwright video of the Audrique Scenario Studio:
 *   1. Landing page overview
 *   2. Creating a new test suite
 *   3. Building the IVR Support Queue scenario via 7-step wizard
 *   4. Reviewing the saved scenario
 *   5. Launching suite execution from the UI
 *
 * Paced for content-creator quality — longer pauses, visible mouse movement,
 * deliberate form fills — so the recording works directly in a YouTube video.
 *
 * Usage:
 *   node scripts/record-youtube-walkthrough.mjs                    # Headless dry run
 *   node scripts/record-youtube-walkthrough.mjs --headed           # Watch live
 *   node scripts/record-youtube-walkthrough.mjs --real             # Real execution
 *   node scripts/record-youtube-walkthrough.mjs --suite "My Suite" # Custom suite name
 *   node scripts/record-youtube-walkthrough.mjs --skip-run         # Skip execution
 *
 * Output:
 *   test-results/youtube/studio-walkthrough.webm
 *   test-results/youtube/youtube-timeline.json
 */

import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.resolve(ROOT, "test-results/youtube");

// ── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const headed = args.includes("--headed");
const realRun = args.includes("--real");
const skipRun = args.includes("--skip-run");
const slowIdx = args.indexOf("--slow");
const slowMo = slowIdx >= 0 ? parseInt(args[slowIdx + 1], 10) : 200;
const suiteIdx = args.indexOf("--suite");
const suiteName = suiteIdx >= 0 ? args[suiteIdx + 1] : "YouTube Demo Suite";
const port = process.env.STUDIO_PORT || 4200;
const BASE = `http://localhost:${port}`;

// ── Resolution ────────────────────────────────────────────────────────────

const W = 1920;
const H = 1080;

// ── Content-creator pacing ────────────────────────────────────────────────

const PACE = {
  afterNavigation: 2500,
  beforeClick: 800,
  afterClick: 1200,
  afterType: 600,
  formFieldGap: 1000,
  sectionTransition: 3000,
  wizardStepEntry: 1500,
  readTime: 2000,
  scrollPause: 1000,
};

async function pause(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

// ── Mouse-visible click ───────────────────────────────────────────────────
// Moves cursor to element center with visible trajectory, pauses, then clicks.

async function moveToAndClick(page, selector) {
  const el = await page.$(selector);
  if (!el) return false;
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 15 });
  await pause(PACE.beforeClick);
  await el.click();
  await pause(PACE.afterClick);
  return true;
}

// ── Helpers (adapted from record-demo.mjs) ────────────────────────────────

async function clickNext(page) {
  // Move cursor to Next button for visual feedback, then JS-click
  const btn = await page.$("#btn-next");
  if (btn) {
    const box = await btn.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
      await pause(PACE.beforeClick);
    }
  }
  await page.evaluate(() => document.getElementById("btn-next").click());
  await pause(500);
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
  await pause(PACE.scrollPause);
}

async function clearAndType(page, selector, text, delay = 50) {
  const el = await page.$(selector);
  if (!el) return;
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
  }
  await pause(300);
  await el.click({ clickCount: 3 });
  await pause(100);
  await el.type(text, { delay });
  await pause(PACE.afterType);
}

async function toggleCheckbox(page, id, shouldBeChecked) {
  const isChecked = await page.evaluate(
    (elId) => document.getElementById(elId)?.checked,
    id
  );
  if (isChecked !== shouldBeChecked) {
    // Move cursor to the toggle's visible slider for visual feedback,
    // then use JS click on the hidden checkbox (custom toggle hides the input)
    const slider = await page.$(`#${id} + .slider`);
    if (slider) {
      const box = await slider.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
        await pause(PACE.beforeClick);
      }
    }
    await page.evaluate((elId) => document.getElementById(elId).click(), id);
    await pause(PACE.afterClick);
  }
}

async function selectOptionCard(page, groupName, value) {
  const card = await page.$(
    `[data-name="${groupName}"] [data-value="${value}"]`
  );
  if (card) {
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
    }
    await pause(PACE.beforeClick);
    await card.click();
    await pause(PACE.afterClick);
  }
}

async function getCurrentStepLabel(page) {
  return page.evaluate(() => {
    const active = document.querySelector(".progress-step.active");
    return active ? active.textContent.trim() : "";
  });
}

// ── Read entry number from personal.env ───────────────────────────────────

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

// ── Scenario config ───────────────────────────────────────────────────────
// Single scenario: IVR Support Queue Branch (Scenario 2 from the full suite)

const SCENARIO = {
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
};

// ── Build scenario via wizard ─────────────────────────────────────────────

async function buildScenario(page, c, stepLog) {
  // Start new scenario
  await moveToAndClick(page, "#btn-new-scenario");
  await pause(PACE.wizardStepEntry);

  let saved = false;
  let loopGuard = 0;

  while (!saved && loopGuard < 12) {
    loopGuard++;
    const stepLabel = await getCurrentStepLabel(page);

    if (stepLabel.includes("Call")) {
      // ── Call Setup ──
      console.log("      Step 1/7: Call Setup");
      stepLog.steps.push({ step: "Call Setup", ms: Date.now() });

      // CCP mode is default — hover to show it's selected
      const ccpCard = await page.$('[data-name="call-mode"] [data-value="connect_ccp"]');
      if (ccpCard) {
        const box = await ccpCard.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
          await pause(PACE.readTime);
        }
      }

      // Set entry number
      await clearAndType(page, "#entry-number", c.entryNumber, 30);
      await pause(PACE.formFieldGap);

    } else if (stepLabel.includes("IVR")) {
      // ── IVR & Routing ──
      console.log("      Step 2/7: IVR & Routing");
      stepLog.steps.push({ step: "IVR & Routing", ms: Date.now() });

      if (c.hasIvr) {
        await toggleCheckbox(page, "has-ivr", true);
        await pause(PACE.formFieldGap);

        // DTMF digit
        if (c.ivrDigits) {
          const digitsInput = await page.$(".ivr-level-digits");
          if (digitsInput) {
            await digitsInput.scrollIntoViewIfNeeded();
            const box = await digitsInput.boundingBox();
            if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
            await pause(300);
            await digitsInput.click();
            await digitsInput.type(c.ivrDigits, { delay: 80 });
            await pause(PACE.afterType);
          }
        }

        // Label
        if (c.ivrLabel) {
          const labelInput = await page.$(".ivr-level-label");
          if (labelInput) {
            const box = await labelInput.boundingBox();
            if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
            await pause(300);
            await labelInput.click();
            await labelInput.type(c.ivrLabel, { delay: 60 });
            await pause(PACE.afterType);
          }
        }

        // Target queue
        if (c.targetQueue) {
          await clearAndType(page, "#target-queue", c.targetQueue, 40);
        }

        // Scroll to show the flowchart
        await smoothScroll(page, ".wizard-step-container", "down", 200);
        await pause(PACE.readTime);
      }

    } else if (stepLabel.includes("Agent")) {
      // ── Agent ──
      console.log("      Step 3/7: Agent");
      stepLog.steps.push({ step: "Agent", ms: Date.now() });
      // Screen pop is on by default — just pause so viewer sees the step
      await pause(PACE.readTime);

    } else if (stepLabel.includes("Conversation")) {
      // ── Conversation ──
      console.log("      Step 4/7: Conversation");
      stepLog.steps.push({ step: "Conversation", ms: Date.now() });
      // Default — skip, but pause for viewer
      await pause(PACE.readTime);

    } else if (stepLabel.includes("Supervisor")) {
      // ── Supervisor ──
      console.log("      Step 5/7: Supervisor");
      stepLog.steps.push({ step: "Supervisor", ms: Date.now() });

      if (c.supervisorEnabled !== undefined) {
        await toggleCheckbox(page, "supervisor-enabled", c.supervisorEnabled);
        await pause(PACE.formFieldGap);
      }
      if (c.observeAgentOffer !== undefined) {
        await toggleCheckbox(page, "observe-agent-offer", c.observeAgentOffer);
        await pause(PACE.formFieldGap);
      }
      await pause(PACE.readTime);

    } else if (stepLabel.includes("Details")) {
      // ── Details ──
      console.log("      Step 6/7: Details");
      stepLog.steps.push({ step: "Details", ms: Date.now() });

      if (c.description) {
        await clearAndType(page, "#scenario-desc", c.description, 20);
        await pause(PACE.formFieldGap);
      }
      if (c.id) {
        await clearAndType(page, "#scenario-id", c.id, 25);
        await pause(PACE.formFieldGap);
      }
      if (c.ringTimeout && c.ringTimeout !== 90) {
        await clearAndType(page, "#ring-timeout", String(c.ringTimeout));
        await pause(PACE.formFieldGap);
      }
      if (c.execStatus && c.execStatus !== "active") {
        await selectOptionCard(page, "exec-status", c.execStatus);
      }
      await pause(PACE.readTime);

    } else if (stepLabel.includes("Review")) {
      // ── Review ──
      console.log("      Step 7/7: Review");
      stepLog.steps.push({ step: "Review", ms: Date.now() });

      // Scroll to see review content
      await smoothScroll(page, ".wizard-step-container", "down", 200);
      await pause(PACE.readTime);

      // Click "Preview & Save"
      await clickNext(page);
      await pause(PACE.sectionTransition);

      // Show JSON preview — scroll through it
      await smoothScroll(page, ".preview-body", "down", 250);
      await pause(PACE.readTime);
      await smoothScroll(page, ".preview-body", "down", 250);
      await pause(PACE.readTime);

      // Switch to Visual Flow tab
      await page.evaluate(() => {
        const tab = document.querySelector('.preview-tab[data-tab="steps"]');
        if (tab) tab.click();
      });
      await pause(PACE.sectionTransition);

      // Save to suite
      console.log("      Saving to suite...");
      await moveToAndClick(page, "#btn-save-scenario");
      await pause(PACE.sectionTransition);

      // Close preview → back to landing
      await page.evaluate(() =>
        document.getElementById("btn-back-to-edit")?.click()
      );
      await pause(600);
      await page.evaluate(() =>
        document.getElementById("btn-cancel-edit")?.click()
      );
      await pause(PACE.afterClick);

      saved = true;
    }

    // Advance to next wizard step
    if (!saved) {
      await clickNext(page);
      await pause(PACE.wizardStepEntry);
    }
  }

  if (!saved) {
    console.warn("      WARNING: wizard loop ended without saving!");
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log("Recording YouTube Studio walkthrough...");
  console.log(`  Studio:     ${BASE}`);
  console.log(`  Output:     ${OUTPUT_DIR}/`);
  console.log(`  Resolution: ${W}x${H}`);
  console.log(`  Headed:     ${headed}`);
  console.log(`  Slow-mo:    ${slowMo}ms`);
  console.log(`  Suite name: ${suiteName}`);
  console.log(`  Mode:       ${realRun ? "REAL EXECUTION" : skipRun ? "SKIP RUN" : "Dry run"}`);
  console.log("");

  const browser = await chromium.launch({
    headless: !headed,
    slowMo,
  });

  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: {
      dir: OUTPUT_DIR,
      size: { width: W, height: H },
    },
  });

  const page = await context.newPage();

  // ── Phase timeline ──────────────────────────────────────────────────
  const timeline = {
    recordingStartMs: null,
    landingShownMs: null,
    suiteCreatedMs: null,
    wizardStartMs: null,
    wizardScenario: {
      id: SCENARIO.id,
      name: "IVR Support Queue Branch",
      startMs: null,
      steps: [],
      savedAtMs: null,
    },
    wizardEndMs: null,
    scenarioReviewMs: null,
    runStartMs: null,
    runFirstOutputMs: null,
    runCompleteMs: null,
    recordingEndMs: null,
  };

  try {
    // ══════════════════════════════════════════════════════════════════
    // Phase 1: Open Studio
    // ══════════════════════════════════════════════════════════════════
    console.log("1. Opening Scenario Studio...");
    await page.goto(BASE, { waitUntil: "networkidle" });
    timeline.recordingStartMs = Date.now();
    await pause(PACE.sectionTransition);

    // Wait for initial content to load
    await page.waitForSelector("#suite-selector", { timeout: 10000 }).catch(() => {});
    await pause(PACE.readTime);
    timeline.landingShownMs = Date.now();

    // ══════════════════════════════════════════════════════════════════
    // Phase 2: Create new suite
    // ══════════════════════════════════════════════════════════════════
    console.log(`\n2. Creating new suite: "${suiteName}"...`);

    // Click the Create Suite button
    await moveToAndClick(page, "#btn-suite-create");
    await pause(PACE.readTime);

    // Type suite name in the modal
    await clearAndType(page, "#modal-suite-name", suiteName, 35);
    await pause(PACE.formFieldGap);

    // Select connection profile if available
    const connSelect = await page.$("#modal-suite-conn");
    if (connSelect) {
      const options = await connSelect.evaluate((sel) =>
        Array.from(sel.options).map((o) => o.value).filter((v) => v)
      );
      if (options.length > 0) {
        await connSelect.selectOption(options[0]);
        await pause(PACE.afterClick);
      }
    }

    // Click Create
    await moveToAndClick(page, "#modal-suite-create-btn");
    await pause(PACE.sectionTransition);
    timeline.suiteCreatedMs = Date.now();
    console.log("   Suite created.");

    // ══════════════════════════════════════════════════════════════════
    // Phase 3: Build scenario via 7-step wizard
    // ══════════════════════════════════════════════════════════════════
    console.log("\n3. Building IVR Support Queue scenario...");
    timeline.wizardStartMs = Date.now();
    timeline.wizardScenario.startMs = Date.now();

    await buildScenario(page, SCENARIO, timeline.wizardScenario);

    timeline.wizardScenario.savedAtMs = Date.now();
    timeline.wizardEndMs = Date.now();
    console.log("   Scenario saved.");

    // ══════════════════════════════════════════════════════════════════
    // Phase 4: Review saved scenario
    // ══════════════════════════════════════════════════════════════════
    console.log("\n4. Reviewing saved scenario in sidebar...");
    timeline.scenarioReviewMs = Date.now();
    await pause(PACE.readTime);

    // Click the scenario card
    const card = await page.$(`.scenario-card[data-id="${SCENARIO.id}"]`);
    if (card) {
      await card.scrollIntoViewIfNeeded();
      const box = await card.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
      }
      await pause(PACE.beforeClick);
      await card.click();
      await pause(PACE.sectionTransition);

      // Scroll live preview to show flow
      await smoothScroll(page, ".live-flow", "down", 200);
      await pause(PACE.readTime);
      await smoothScroll(page, ".live-flow", "down", 200);
      await pause(PACE.readTime);
    }

    // Back to landing
    await page.evaluate(() =>
      document.getElementById("btn-cancel-edit")?.click()
    );
    await pause(PACE.afterClick);

    // ══════════════════════════════════════════════════════════════════
    // Phase 5: Launch execution
    // ══════════════════════════════════════════════════════════════════
    if (!skipRun) {
      if (realRun) {
        console.log("\n5. Running REAL suite execution...");
      } else {
        console.log("\n5. Running dry run...");
      }

      timeline.runStartMs = Date.now();

      // Open run panel
      await moveToAndClick(page, "#btn-run-suite");
      await pause(PACE.readTime);

      if (realRun) {
        await page.evaluate(() => {
          if (typeof startRun === "function") startRun(false);
        });
      } else {
        await moveToAndClick(page, "#btn-run-dry");
      }
      await pause(PACE.sectionTransition);

      // Wait for first output line
      const runTimeout = realRun ? 60000 : 15000;
      await page
        .waitForSelector(".run-line", { timeout: runTimeout })
        .catch(() => {});
      timeline.runFirstOutputMs = Date.now();
      await pause(PACE.readTime);

      // Scroll terminal output periodically
      const scrollRounds = realRun ? 20 : 5;
      const scrollPause = realRun ? 3000 : 2000;
      for (let i = 0; i < scrollRounds; i++) {
        await smoothScroll(page, "#run-terminal-body", "down", 500);
        await pause(scrollPause);
      }

      // Wait for completion
      const completeTimeout = realRun ? 600000 : 30000;
      await page
        .waitForSelector(".run-line-done", { timeout: completeTimeout })
        .catch(() => {
          console.log("   (timed out waiting for completion)");
        });
      await pause(PACE.sectionTransition);

      // Final scroll to show results
      await smoothScroll(page, "#run-terminal-body", "down", 1000);
      await pause(PACE.sectionTransition);

      timeline.runCompleteMs = Date.now();
    }

    // ══════════════════════════════════════════════════════════════════
    // Phase 6: Final pause
    // ══════════════════════════════════════════════════════════════════
    console.log("\n6. Recording complete!");
    timeline.recordingEndMs = Date.now();
    await pause(PACE.sectionTransition);

  } catch (err) {
    console.error("Recording error:", err.message);
    console.error(err.stack);
    await page.screenshot({ path: path.join(OUTPUT_DIR, "walkthrough-error.png") });
  }

  // Write timeline JSON
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "youtube-timeline.json"),
    JSON.stringify(timeline, null, 2)
  );
  console.log(`Timeline saved: ${path.join(OUTPUT_DIR, "youtube-timeline.json")}`);

  // Close and finalize video
  await page.close();
  await context.close();
  await browser.close();

  // Find the generated video file and rename
  const files = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith(".webm") && f !== "studio-walkthrough.webm")
    .sort((a, b) =>
      fs.statSync(path.join(OUTPUT_DIR, b)).mtimeMs -
      fs.statSync(path.join(OUTPUT_DIR, a)).mtimeMs
    );
  if (files.length > 0) {
    const src = path.join(OUTPUT_DIR, files[0]);
    const dest = path.join(OUTPUT_DIR, "studio-walkthrough.webm");
    fs.copyFileSync(src, dest);
    console.log(`\nVideo saved: ${dest}`);
    console.log(`File size: ${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB`);
  }

  // Print duration summary
  if (timeline.recordingStartMs && timeline.recordingEndMs) {
    const durSec = (timeline.recordingEndMs - timeline.recordingStartMs) / 1000;
    const mins = Math.floor(durSec / 60);
    const secs = Math.round(durSec % 60);
    console.log(`Recording duration: ${mins}m ${secs}s`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
