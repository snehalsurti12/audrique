#!/usr/bin/env node
/**
 * build-demo-video.mjs
 *
 * Creates a single annotated demo video combining:
 *   1. Audrique Scenario Studio walkthrough (from record-demo.mjs)
 *   2. Live E2E suite execution results (from run-instance-e2e-suite.mjs)
 *
 * Adds title cards, phase transitions, speed modulation, banners, and results summary.
 *
 * Usage:
 *   node scripts/build-demo-video.mjs
 *   node scripts/build-demo-video.mjs --suite <suite-dir>
 *   node scripts/build-demo-video.mjs --studio <video-path> --suite <suite-dir>
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

// ── Video constants ────────────────────────────────────────
const W = 1280;
const H = 720;
const FPS = 24;
const VP9_CRF = "34";

// ── Speed factors ──────────────────────────────────────────
const STUDIO_SPEED = 2;
const PREFLIGHT_SPEED = 3;
const CCP_SPEED = 2;
const DEAD_WAIT_SPEED = 4;

// ── Real E2E scenarios (with actual Connect call routing) ──
const REAL_SCENARIOS = new Set([
  "inbound-agent-offer",
  "ivr-support-queue-branch",
  "ivr-timeout-default-queue-branch"
]);

// ── Usable system font ────────────────────────────────────
const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf"
];
const FONT = FONT_CANDIDATES.find((p) => fs.existsSync(p)) ?? "";

// ── Scenario display names ─────────────────────────────────
const TITLES = {
  "inbound-agent-offer": "Inbound Agent Offer",
  "ivr-support-queue-branch": "IVR Support Queue (DTMF 1)",
  "ivr-timeout-default-queue-branch": "IVR Timeout Default Queue",
  "skill-based-spanish-support": "Skill-Based Spanish Support",
  "multi-level-ivr-billing": "Multi-Level IVR Billing",
  "after-hours-closed-message": "After Hours Closed Message",
  "voicemail-no-agent-available": "Voicemail (No Agent)",
  "callback-queue-full": "Callback (Queue Full)",
  "ivr-greeting-prompt-validation": "IVR Greeting Prompt Validation"
};

// ── CLI args ───────────────────────────────────────────────
function resolveArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

// ── Resolve inputs ─────────────────────────────────────────
const demoDir = path.resolve(process.cwd(), "test-results/demo");
const studioVideo = resolveArg("--studio")
  ?? path.join(demoDir, "studio-demo.webm");

const e2eRoot = path.resolve(process.cwd(), "test-results", "e2e-suite");
const suiteDir = resolveArg("--suite")
  ?? (() => {
    const dirs = fs
      .readdirSync(e2eRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
      .map((d) => path.join(e2eRoot, d.name))
      .sort();
    return dirs.pop() ?? "";
  })();

if (!suiteDir || !fs.existsSync(path.join(suiteDir, "suite-summary.json"))) {
  console.error("No suite-summary.json found. Run a suite first.");
  process.exit(1);
}

const suite = JSON.parse(
  fs.readFileSync(path.join(suiteDir, "suite-summary.json"), "utf8")
);

// ── Demo timeline (optional — from record-demo.mjs) ───────
const demoTimelinePath = path.join(demoDir, "demo-timeline.json");
const demoTimeline = fs.existsSync(demoTimelinePath)
  ? JSON.parse(fs.readFileSync(demoTimelinePath, "utf8"))
  : null;

const hasStudioVideo = fs.existsSync(studioVideo);

// ── Build directory ────────────────────────────────────────
const tmpDir = path.join(demoDir, "_demo-build");
if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });

// ── FFmpeg helpers (from merge-e2e-highlight.mjs) ──────────

function escText(str) {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\u2019");
}

function drawtext(text, opts = {}) {
  const {
    size = 24,
    color = "white",
    x = "(w-text_w)/2",
    y = "(h-text_h)/2"
  } = opts;
  const parts = [];
  if (FONT) parts.push(`fontfile=${FONT}`);
  parts.push(`text='${escText(text)}'`);
  parts.push(`fontsize=${size}`);
  parts.push(`fontcolor=${color}`);
  parts.push(`x=${x}`);
  parts.push(`y=${y}`);
  return "drawtext=" + parts.join(":");
}

function ffrun(args, label) {
  console.log(`  [demo] ${label} ...`);
  const r = spawnSync(ffmpegPath, args, {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 600_000
  });
  if (r.status !== 0) {
    console.error(`  FAILED: ${label}`);
    if (r.stderr) console.error(r.stderr.slice(-600));
    return false;
  }
  return true;
}

function colorSrc(duration, color = "0x0d1117") {
  return `color=c=${color}:s=${W}x${H}:d=${duration}:r=${FPS}`;
}

function vpxOut() {
  return ["-c:v", "libvpx-vp9", "-crf", VP9_CRF, "-b:v", "0", "-pix_fmt", "yuv420p"];
}

function getDuration(videoPath) {
  const r = spawnSync("ffprobe", [
    "-v", "quiet", "-print_format", "json", "-show_format", videoPath
  ], { encoding: "utf8", timeout: 10_000, stdio: "pipe" });
  if (r.status === 0) {
    try { return parseFloat(JSON.parse(r.stdout).format.duration); } catch { /* ignore */ }
  }
  const r2 = spawnSync(ffmpegPath, ["-i", videoPath], {
    encoding: "utf8", stdio: "pipe", timeout: 10_000
  });
  const m = r2.stderr?.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 100;
  return 30;
}

// ── Video segment builder ──────────────────────────────────

function buildVideoSegment({
  input, output, label,
  startSec = 0, durationSec = 0, speed = 1,
  bannerText = "", bannerColor = "0xd29922", bannerPosition = "bottom",
  scaleFilter = null
}) {
  const ssArgs = startSec > 0 ? ["-ss", startSec.toFixed(3)] : [];
  const tArgs = durationSec > 0 ? ["-t", durationSec.toFixed(3)] : [];

  const filters = [
    scaleFilter ?? `scale=${W}:${H}`,
    `fps=${FPS}`,
    "format=yuv420p"
  ];

  if (speed > 1) {
    filters.push(`setpts=PTS/${speed}`);
  }

  if (bannerText) {
    const isTop = bannerPosition === "top";
    const boxY = isTop ? "0" : "ih-36";
    filters.push(`drawbox=x=0:y=${boxY}:w=iw:h=36:color=black@0.75:t=fill`);
    filters.push(drawtext(bannerText, {
      size: 16,
      color: bannerColor,
      x: "20",
      y: isTop ? "10" : "h-26"
    }));
  }

  return ffrun(
    ["-y", ...ssArgs, ...tArgs, "-i", input, "-vf", filters.join(","), ...vpxOut(), output],
    label
  );
}

// ── Title card builder ─────────────────────────────────────

function buildTitleCard({ output, scenarioNum, title, description, assertions, passed, duration }) {
  const dur = Math.max(4, 3 + assertions.length * 0.6);
  const filters = [
    drawtext(`Scenario ${scenarioNum}`, { size: 38, color: "0x58a6ff", y: "60" }),
    drawtext(title, { size: 30, y: "115" })
  ];

  if (description) {
    filters.push(drawtext(description.replace(/[:.]/g, " ").trim().slice(0, 80), {
      size: 14, color: "0x888888", y: "160"
    }));
  }

  for (let j = 0; j < assertions.length; j++) {
    filters.push(drawtext(`[${j + 1}] ${assertions[j]}`, {
      size: 18, color: "0x7ee787", x: "160", y: String(210 + j * 32)
    }));
  }

  filters.push(drawtext(
    passed ? `PASSED | ${Math.round(duration)}s` : `FAILED | ${Math.round(duration)}s`,
    { size: 20, color: passed ? "0x3fb950" : "0xf85149", y: "h-50" }
  ));

  return ffrun(
    ["-y", "-f", "lavfi", "-i", colorSrc(dur, "0x161b22"), "-vf", filters.join(","), ...vpxOut(), output],
    `Scenario ${scenarioNum} title card`
  );
}

// ── Timeline helpers ───────────────────────────────────────

function readTimeline(sc) {
  const tp = sc.artifacts?.[0]?.timeline;
  if (!tp || !fs.existsSync(tp)) return null;
  try {
    return JSON.parse(fs.readFileSync(tp, "utf8"));
  } catch {
    return null;
  }
}

function timelineToVideoSec(tl) {
  if (!tl?.testStartMs) return null;
  const t0 = tl.testStartMs;
  const s = (ms) => (ms && Number.isFinite(Number(ms)) ? (Number(ms) - t0) / 1000 : null);
  return {
    preflightReady: s(tl.preflightReadyMs),
    callTriggerStart: s(tl.callTriggerStartMs),
    ccpDialConfirmed: s(tl.ccpDialConfirmedMs),
    incomingDetected: s(tl.incomingDetectedMs),
    acceptClicked: s(tl.acceptClickedMs),
    screenPopDetected: s(tl.screenPopDetectedMs),
    supervisorStarted: s(tl.supervisorObserverStartedMs),
    supervisorQueueObserved: s(tl.supervisorQueueObservedMs),
    supervisorAgentOffer: s(tl.supervisorAgentOfferObservedMs),
    testEnd: s(tl.testEndMs)
  };
}

function demoTimelineToVideoSec(dt) {
  if (!dt?.recordingStartMs) return null;
  const t0 = dt.recordingStartMs;
  const s = (ms) => (ms ? (ms - t0) / 1000 : null);
  return {
    browseStart: s(dt.browseStartMs),
    browseEnd: s(dt.browseEndMs),
    wizardStart: s(dt.wizardStartMs),
    wizardEnd: s(dt.wizardEndMs),
    reviewStart: s(dt.reviewStartMs),
    reviewEnd: s(dt.reviewEndMs),
    showcaseStart: s(dt.showcaseStartMs),
    showcaseEnd: s(dt.showcaseEndMs),
    suiteRunStart: s(dt.suiteRunStartMs),
    recordingEnd: s(dt.recordingEndMs)
  };
}

// ── Step description map ────────────────────────────────────
const STEP_DESCRIPTIONS = {
  "Call Setup": "Entry number and call mode",
  "IVR & Routing": "DTMF digits and target queue",
  "Agent": "Screen pop and call handling",
  "Supervisor": "Queue monitoring and agent offer",
  "Details": "ID, description, execution settings",
  "Review": "Preview JSON and save to suite"
};

// ── Assertion list builder ─────────────────────────────────

function buildAssertions(sc) {
  const env = sc.appliedEnv ?? {};
  const tl = readTimeline(sc);
  const items = [];

  items.push("Salesforce preflight and login");

  if (env.CONNECT_CCP_IVR_DIGITS) {
    items.push(`CCP outbound dial + send DTMF ${env.CONNECT_CCP_IVR_DIGITS}`);
  } else {
    items.push(
      sc.id.includes("timeout")
        ? "CCP outbound dial (no DTMF - IVR timeout)"
        : "CCP outbound dial to entry number"
    );
  }

  if (env.VERIFY_SUPERVISOR_QUEUE_WAITING === "true") {
    const q = env.SUPERVISOR_QUEUE_NAME ?? "queue";
    items.push(`Supervisor detects call in ${q}`);
  }

  if (tl?.incomingDetectedMs) items.push("Incoming call detected on SF agent");
  if (tl?.acceptClickedMs) items.push("Agent accepts the call");

  if (env.VERIFY_SUPERVISOR_AGENT_OFFER === "true") {
    items.push("Supervisor sees agent offer");
  }

  if (tl?.screenPopDetectedMs) items.push("VoiceCall screen pop verified");

  return items;
}

// ── Find supervisor video ──────────────────────────────────

function findSupervisorVideo(sc) {
  const artDir = sc.artifacts?.[0]?.dir;
  if (!artDir) return null;
  const attDir = path.join(artDir, "attachments");
  if (!fs.existsSync(attDir)) return null;
  const files = fs.readdirSync(attDir)
    .filter((n) => /^salesforce-supervisor-video-.*\.webm$/i.test(n))
    .map((n) => path.join(attDir, n))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ?? null;
}

// ═══════════════════════════════════════════════════════════
// ── Main build ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

console.log("\n=== Building Annotated Demo Video ===\n");
console.log(`  Studio video: ${hasStudioVideo ? studioVideo : "(not found)"}`);
console.log(`  Demo timeline: ${demoTimeline ? "yes" : "no"}`);
console.log(`  Suite dir: ${suiteDir}`);
console.log(`  Suite: ${suite.totals.passed}/${suite.totals.scenarios} passed\n`);

const segments = [];
let segIdx = 0;

function segPath(name) {
  return path.join(tmpDir, `${String(segIdx++).padStart(3, "0")}-${name}.webm`);
}

// ═══════════════════════════════════════════════════════════
// ── ACT 1: Intro Card (5s) ───────────────────────────────
// ═══════════════════════════════════════════════════════════

{
  const out = segPath("intro");
  const realScenarios = suite.scenarios.filter((sc) => REAL_SCENARIOS.has(sc.id));
  const realPassed = realScenarios.filter((sc) => sc.status === "passed").length;
  const totalMin = Math.round(suite.durationSec / 60);
  const vf = [
    drawtext("Audrique -- Contact Center E2E Testing", { size: 42, y: "h/2-80" }),
    drawtext("Scenario Studio + Live Salesforce Execution", {
      size: 22, color: "0xaaaaaa", y: "h/2-25"
    }),
    drawtext(
      `${realScenarios.length} E2E Scenarios | ${realPassed} Passed | Real Calls`,
      { size: 18, color: "0x3fb950", y: "h/2+25" }
    ),
    drawtext("Salesforce Service Cloud Voice + Amazon Connect", {
      size: 14, color: "0x555555", y: "h/2+70"
    })
  ].join(",");

  if (ffrun(["-y", "-f", "lavfi", "-i", colorSrc(5), "-vf", vf, ...vpxOut(), out], "Intro card")) {
    segments.push(out);
  }
}

// ═══════════════════════════════════════════════════════════
// ── ACT 2: Studio Walkthrough ────────────────────────────
// ═══════════════════════════════════════════════════════════

if (hasStudioVideo) {
  // Phase card
  {
    const out = segPath("phase1-card");
    const vf = [
      drawtext("Phase 1", { size: 18, color: "0x58a6ff", y: "h/2-50" }),
      drawtext("Building Test Scenarios", { size: 38, y: "h/2-10" }),
      drawtext("Audrique Scenario Studio", { size: 16, color: "0x888888", y: "h/2+35" })
    ].join(",");

    if (ffrun(["-y", "-f", "lavfi", "-i", colorSrc(3, "0x161b22"), "-vf", vf, ...vpxOut(), out], "Phase 1 card")) {
      segments.push(out);
    }
  }

  // Studio recording — split into annotated sub-segments per phase
  const studioTs = demoTimelineToVideoSec(demoTimeline);
  const fullDuration = getDuration(studioVideo);
  const t0 = demoTimeline?.recordingStartMs ?? 0;
  const toSec = (ms) => (ms && t0 ? (ms - t0) / 1000 : null);

  // Scale filter for 1440x900 → 1280x720
  const studioScale = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`;

  // Helper to add a studio sub-segment
  function addStudioSeg({ startSec, endSec, label, bannerText }) {
    const dur = endSec - startSec;
    if (dur < 1) return;
    const out = segPath(label.replace(/\s+/g, "-").toLowerCase().slice(0, 30));
    buildVideoSegment({
      input: studioVideo, output: out,
      label: `${label} (${STUDIO_SPEED}x)`,
      startSec, durationSec: dur,
      speed: STUDIO_SPEED,
      bannerText: `>> ${bannerText} (${STUDIO_SPEED}x)`,
      bannerColor: "0xd29922",
      bannerPosition: "top",
      scaleFilter: studioScale
    });
    if (fs.existsSync(out)) segments.push(out);
  }

  const hasGranularTimeline = studioTs
    && demoTimeline?.wizardScenarios?.length > 0
    && demoTimeline.wizardScenarios[0]?.steps?.length > 0;

  if (hasGranularTimeline) {
    // ── Browse phase ──
    if (studioTs.browseStart != null && studioTs.browseEnd != null) {
      addStudioSeg({
        startSec: studioTs.browseStart,
        endSec: studioTs.browseEnd,
        label: "Browse",
        bannerText: "Browsing Existing Test Scenarios"
      });
    }

    // ── Per-scenario wizard steps ──
    for (let si = 0; si < demoTimeline.wizardScenarios.length; si++) {
      const sc = demoTimeline.wizardScenarios[si];
      const num = si + 1;
      const scName = sc.name ?? `Scenario ${num}`;

      for (let j = 0; j < sc.steps.length; j++) {
        const stepStart = toSec(sc.steps[j].ms);
        const stepEnd = sc.steps[j + 1]?.ms
          ? toSec(sc.steps[j + 1].ms)
          : toSec(sc.savedAtMs);
        if (stepStart == null || stepEnd == null) continue;

        const stepName = sc.steps[j].step;
        const desc = STEP_DESCRIPTIONS[stepName] ?? "";
        addStudioSeg({
          startSec: stepStart,
          endSec: stepEnd,
          label: `S${num}-${stepName}`,
          bannerText: `${scName} > ${stepName}${desc ? " -- " + desc : ""}`
        });
      }
    }

    // ── Review built scenarios ──
    if (studioTs.reviewStart != null && studioTs.reviewEnd != null) {
      addStudioSeg({
        startSec: studioTs.reviewStart,
        endSec: studioTs.reviewEnd,
        label: "Review-built",
        bannerText: "Reviewing Built Scenarios in Sidebar"
      });
    }

    // ── Showcase complex scenario ──
    if (studioTs.showcaseStart != null && studioTs.showcaseEnd != null) {
      addStudioSeg({
        startSec: studioTs.showcaseStart,
        endSec: studioTs.showcaseEnd,
        label: "Showcase",
        bannerText: "Advanced Demo -- Voicemail + Multi-Level IVR"
      });
    }
  } else if (studioTs && studioTs.wizardStart != null) {
    // Basic timeline (no per-step data) — extract wizard+showcase as one segment
    const startSec = Math.max(0, (studioTs.browseEnd ?? 0) - 1);
    const endSec = studioTs.showcaseEnd ?? studioTs.suiteRunStart ?? fullDuration;
    addStudioSeg({
      startSec, endSec,
      label: "Studio-wizard",
      bannerText: "Scenario Studio -- Building 3 Scenarios"
    });
  } else {
    // Fallback: use entire studio video
    const out = segPath("studio-full");
    buildVideoSegment({
      input: studioVideo, output: out,
      label: `Studio full (${STUDIO_SPEED}x fallback)`,
      speed: STUDIO_SPEED,
      bannerText: `>> Scenario Studio -- Full Walkthrough (${STUDIO_SPEED}x speed)`,
      bannerColor: "0xd29922",
      bannerPosition: "top",
      scaleFilter: studioScale
    });
    if (fs.existsSync(out)) segments.push(out);
  }
}

// ═══════════════════════════════════════════════════════════
// ── ACT 3: Live Execution ────────────────────────────────
// ═══════════════════════════════════════════════════════════

// Phase card
{
  const out = segPath("phase2-card");
  const realWithVideo = suite.scenarios.filter(
    (sc) => REAL_SCENARIOS.has(sc.id) && sc.artifacts?.[0]?.mergedVideo && fs.existsSync(sc.artifacts[0].mergedVideo)
  ).length;
  const vf = [
    drawtext("Phase 2", { size: 18, color: "0x58a6ff", y: "h/2-50" }),
    drawtext("Live Execution Against Salesforce + Connect", { size: 34, y: "h/2-10" }),
    drawtext(`${realWithVideo} real E2E scenarios with call routing + video evidence`, {
      size: 16, color: "0x888888", y: "h/2+35"
    })
  ].join(",");

  if (ffrun(["-y", "-f", "lavfi", "-i", colorSrc(3, "0x161b22"), "-vf", vf, ...vpxOut(), out], "Phase 2 card")) {
    segments.push(out);
  }
}

// ── Per-scenario execution (real scenarios only) ────────────
let scenarioDisplayNum = 0;
let isFirstScenarioWithTimeline = true;

for (let i = 0; i < suite.scenarios.length; i++) {
  const sc = suite.scenarios[i];

  // Only include real E2E scenarios with actual Connect call routing
  if (!REAL_SCENARIOS.has(sc.id)) continue;

  const title = TITLES[sc.id] ?? sc.id;
  const passed = sc.status === "passed";
  const merged = sc.artifacts?.[0]?.mergedVideo;
  const sfVideo = sc.artifacts?.[0]?.salesforceVideo;
  const ccpVideo = sc.artifacts?.[0]?.ccpVideo;

  const hasMerged = merged && fs.existsSync(merged);
  const hasSf = sfVideo && fs.existsSync(sfVideo);
  const hasCcp = ccpVideo && fs.existsSync(ccpVideo);

  // Skip scenarios without any video
  if (!hasMerged && !hasSf) continue;

  scenarioDisplayNum++;
  const num = scenarioDisplayNum;
  const assertions = buildAssertions(sc);
  const timeline = readTimeline(sc);
  const ts = timelineToVideoSec(timeline);
  const supervisorVideo = findSupervisorVideo(sc);

  console.log(`\n  --- Scenario ${num}: ${title} (${sc.status}) ---`);
  console.log(`    SF: ${!!hasSf}  CCP: ${!!hasCcp}  Merged: ${!!hasMerged}  Timeline: ${!!ts}  Supervisor: ${!!supervisorVideo}`);

  // ── Title card ──────────────────────────────────────────
  const titleOut = segPath("title-card");
  buildTitleCard({
    output: titleOut,
    scenarioNum: num,
    title,
    description: sc.description,
    assertions,
    passed,
    duration: sc.durationSec
  });
  if (fs.existsSync(titleOut)) segments.push(titleOut);

  // ── Speed-modulated execution video ─────────────────────
  if (ts && hasSf) {
    // Scenario with timeline: phase-based speed modulation

    // Preflight at 3x (first scenario only)
    if (isFirstScenarioWithTimeline && ts.preflightReady > 5) {
      const out = segPath("preflight");
      buildVideoSegment({
        input: sfVideo, output: out,
        label: `S${num} preflight (${PREFLIGHT_SPEED}x)`,
        startSec: 0,
        durationSec: ts.preflightReady,
        speed: PREFLIGHT_SPEED,
        bannerText: `>> Preflight Setup (${PREFLIGHT_SPEED}x speed)`,
        bannerColor: "0xd29922",
        bannerPosition: "top"
      });
      if (fs.existsSync(out)) segments.push(out);
    }
    isFirstScenarioWithTimeline = false;

    // CCP dial at 2x
    if (hasCcp) {
      const out = segPath("ccp-dial");
      buildVideoSegment({
        input: ccpVideo, output: out,
        label: `S${num} CCP dial (${CCP_SPEED}x)`,
        speed: CCP_SPEED,
        bannerText: `>> Scenario ${num} -- CCP Dial (${CCP_SPEED}x speed)`,
        bannerColor: "0xd29922",
        bannerPosition: "top"
      });
      if (fs.existsSync(out)) segments.push(out);
    }

    // Dead wait at 4x (ccpDialConfirmed → incomingDetected)
    if (ts.ccpDialConfirmed != null && ts.incomingDetected != null) {
      const deadDur = ts.incomingDetected - ts.ccpDialConfirmed;
      if (deadDur > 3) {
        const out = segPath("dead-wait");
        buildVideoSegment({
          input: sfVideo, output: out,
          label: `S${num} dead wait (${DEAD_WAIT_SPEED}x)`,
          startSec: ts.ccpDialConfirmed,
          durationSec: deadDur,
          speed: DEAD_WAIT_SPEED,
          bannerText: `>> Waiting for Incoming (${DEAD_WAIT_SPEED}x speed)`,
          bannerColor: "0xd29922",
          bannerPosition: "top"
        });
        if (fs.existsSync(out)) segments.push(out);
      }
    }

    // Supervisor segment at 1x (if available)
    if (supervisorVideo && fs.existsSync(supervisorVideo) && timeline) {
      const startedMs = Number(timeline.supervisorObserverStartedMs ?? 0);
      const observedMs = Number(timeline.supervisorQueueObservedMs ?? 0);
      if (startedMs > 0 && observedMs > startedMs) {
        const observedAt = (observedMs - startedMs) / 1000;
        const segStart = Math.max(0, observedAt - 8);
        const segDur = Math.max(6, observedAt + 5 - segStart);

        const out = segPath("supervisor");
        buildVideoSegment({
          input: supervisorVideo, output: out,
          label: `S${num} supervisor`,
          startSec: segStart,
          durationSec: segDur,
          bannerText: `Scenario ${num} -- Supervisor Queue Observation`,
          bannerColor: "0xbc8cff"
        });
        if (fs.existsSync(out)) segments.push(out);
      }
    }

    // Key moments at 1x (from ~1s before incoming to end)
    if (ts.incomingDetected != null) {
      const keyStart = Math.max(0, ts.incomingDetected - 1);
      const out = segPath("key-moments");
      buildVideoSegment({
        input: sfVideo, output: out,
        label: `S${num} key moments`,
        startSec: keyStart,
        bannerText: `Scenario ${num} -- Accept & Screen Pop`,
        bannerColor: "0x3fb950"
      });
      if (fs.existsSync(out)) segments.push(out);
    }
  } else if (hasMerged) {
    // Fallback: show merged video at 1x with bottom banner
    const out = segPath("merged");
    buildVideoSegment({
      input: merged, output: out,
      label: `S${num} merged video`,
      bannerText: `Scenario ${num} -- ${title} | ${passed ? "PASSED" : "FAILED"}`,
      bannerColor: passed ? "0x3fb950" : "0xf85149"
    });
    if (fs.existsSync(out)) segments.push(out);
  }
}

// ═══════════════════════════════════════════════════════════
// ── ACT 4: Results Summary Card (5s) ─────────────────────
// ═══════════════════════════════════════════════════════════

{
  const out = segPath("results");
  const realResults = suite.scenarios.filter((sc) => REAL_SCENARIOS.has(sc.id));
  const realPassedNames = realResults
    .filter((sc) => sc.status === "passed")
    .map((sc) => TITLES[sc.id] ?? sc.id);
  const realFailedNames = realResults
    .filter((sc) => sc.status !== "passed" && sc.status !== "allowed_failure")
    .map((sc) => TITLES[sc.id] ?? sc.id);

  const filters = [
    drawtext(
      `${realPassedNames.length}/${realResults.length} E2E Scenarios Passed`,
      { size: 36, color: realFailedNames.length === 0 ? "0x3fb950" : "0xf85149", y: "50" }
    )
  ];

  // List passed scenarios
  for (let j = 0; j < realPassedNames.length; j++) {
    filters.push(drawtext(`  ${realPassedNames[j]}`, {
      size: 18, color: "0x7ee787", x: "160", y: String(120 + j * 32)
    }));
  }

  // List allowed failures
  const allowedNames = realResults
    .filter((sc) => sc.status === "allowed_failure")
    .map((sc) => TITLES[sc.id] ?? sc.id);
  if (allowedNames.length > 0) {
    const yStart = 120 + realPassedNames.length * 32 + 16;
    filters.push(drawtext(`${allowedNames.length} allowed failure (supervisor session conflict)`, {
      size: 14, color: "0xd29922", y: String(yStart)
    }));
    for (let j = 0; j < allowedNames.length; j++) {
      filters.push(drawtext(`  ${allowedNames[j]}`, {
        size: 14, color: "0xd29922", x: "160", y: String(yStart + 24 + j * 24)
      }));
    }
  }

  filters.push(drawtext(
    "Real calls via Amazon Connect -- CCP dial + Salesforce agent + screen pop",
    { size: 16, color: "0xaaaaaa", y: "h-60" }
  ));

  if (ffrun(["-y", "-f", "lavfi", "-i", colorSrc(5, "0x0d1117"), "-vf", filters.join(","), ...vpxOut(), out], "Results card")) {
    segments.push(out);
  }
}

// ═══════════════════════════════════════════════════════════
// ── ACT 4b: Voice Audio Note Card (4s) ──────────────────
// ═══════════════════════════════════════════════════════════

{
  const out = segPath("voice-note");
  const vf = [
    drawtext("Note on Voice Audio", { size: 28, color: "0xd29922", y: "h/2-80" }),
    drawtext("Browser recordings capture the CRM/agent side (visual)", {
      size: 18, color: "0xaaaaaa", y: "h/2-30"
    }),
    drawtext("IVR prompts, DTMF tones, and call audio are not yet captured", {
      size: 18, color: "0xaaaaaa", y: "h/2+5"
    }),
    drawtext("Planned -- Twilio call recording integration for voice evidence", {
      size: 16, color: "0x58a6ff", y: "h/2+50"
    })
  ].join(",");

  if (ffrun(["-y", "-f", "lavfi", "-i", colorSrc(4, "0x161b22"), "-vf", vf, ...vpxOut(), out], "Voice audio note")) {
    segments.push(out);
  }
}

// ═══════════════════════════════════════════════════════════
// ── ACT 5: Outro Card (3s) ──────────────────────────────
// ═══════════════════════════════════════════════════════════

{
  const out = segPath("outro");
  const vf = [
    drawtext("Audrique", { size: 44, color: "0x58a6ff", y: "h/2-40" }),
    drawtext("Open Source E2E Contact Center Testing", {
      size: 22, color: "0xaaaaaa", y: "h/2+15"
    }),
    drawtext("Salesforce Service Cloud Voice + Amazon Connect", {
      size: 14, color: "0x555555", y: "h/2+55"
    })
  ].join(",");

  if (ffrun(["-y", "-f", "lavfi", "-i", colorSrc(3), "-vf", vf, ...vpxOut(), out], "Outro card")) {
    segments.push(out);
  }
}

// ═══════════════════════════════════════════════════════════
// ── Final Concatenation ──────────────────────────────────
// ═══════════════════════════════════════════════════════════

console.log(`\n  Concatenating ${segments.length} segments ...`);
const concatList = path.join(tmpDir, "concat.txt");
fs.writeFileSync(concatList, segments.map((s) => `file '${s}'`).join("\n"));

const finalOutput = path.join(demoDir, "full-demo.webm");

let ok = ffrun(
  ["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", finalOutput],
  "Final concat (stream copy)"
);

if (!ok) {
  ok = ffrun(
    [
      "-y", "-f", "concat", "-safe", "0", "-i", concatList,
      "-c:v", "libvpx-vp9", "-crf", VP9_CRF, "-b:v", "0",
      finalOutput
    ],
    "Final concat (re-encode)"
  );
}

if (ok && fs.existsSync(finalOutput)) {
  const stat = fs.statSync(finalOutput);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
  const durSec = getDuration(finalOutput);
  const mins = Math.floor(durSec / 60);
  const secs = Math.round(durSec % 60);
  console.log(`\n  Demo video created!`);
  console.log(`  Output:   ${finalOutput}`);
  console.log(`  Duration: ${mins}m ${secs}s`);
  console.log(`  Size:     ${sizeMB} MB`);
  console.log(`  Segments: ${segments.length}\n`);
} else {
  console.error("\n  Failed to create demo video.\n");
  process.exit(1);
}
