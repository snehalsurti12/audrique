#!/usr/bin/env node
/**
 * build-youtube-video.mjs
 *
 * Assembles a YouTube-ready H.264 MP4 from:
 *   1. Studio walkthrough recording (from record-youtube-walkthrough.mjs)
 *   2. Live E2E suite execution results (from run-instance-e2e-suite.mjs)
 *
 * Features:
 *   - 1920x1080 @ 30 FPS (YouTube HD)
 *   - H.264 + AAC output (optimal YouTube upload)
 *   - 14-chapter structure with YouTube timestamps
 *   - Professional lower-third banners with Audrique branding
 *   - Speed modulation for setup/wait phases
 *   - Optional voiceover overlay
 *
 * Usage:
 *   node scripts/build-youtube-video.mjs
 *   node scripts/build-youtube-video.mjs --studio <walkthrough.webm>
 *   node scripts/build-youtube-video.mjs --suite <suite-dir>
 *   node scripts/build-youtube-video.mjs --voiceover narration.mp3
 *   node scripts/build-youtube-video.mjs --format webm
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  resolveFFmpeg,
  FONT,
  escText,
  drawtext,
  ffrun,
  colorSrc,
  getDuration,
  readTimeline,
  timelineToVideoSec,
  findSupervisorVideo,
  findSupervisorInProgressVideo,
  buildAssertions,
  buildCardWithLogo,
} from "./lib/ffmpeg-helpers.mjs";

const ffmpegPath = resolveFFmpeg();
if (!ffmpegPath) {
  console.error("ffmpeg binary not found (system or ffmpeg-static).");
  process.exit(1);
}

// ── Video constants (YouTube HD) ──────────────────────────────────────────

const W = 1920;
const H = 1080;
const FPS = 30;
const H264_CRF = "18";
const H264_PRESET = "slow";

// ── Branding colors (from webapp style.css :root) ─────────────────────────

const BRAND = {
  bgPrimary: "0x0f1117",
  bgSecondary: "0x161822",
  bgCard: "0x1e2030",
  accent: "0x6c5ce7",
  accentLight: "0x8577ed",
  textPrimary: "0xeaedf3",
  textSecondary: "0xa0a8c0",
  success: "0x3fb950",
  danger: "0xf85149",
  warning: "0xd29922",
  info: "0x58a6ff",
  muted: "0x555555",
  supervisor: "0xbc8cff",
};

// ── Speed factors ─────────────────────────────────────────────────────────

const SPEED = {
  studioSetup: 1.5,
  preflight: 3,
  ccpDial: 2,
  deadWait: 6,
  highlightSample: 2,
};

// ── Scenario display names ────────────────────────────────────────────────

const TITLES = {
  "inbound-agent-offer": "Inbound Agent Offer",
  "ivr-support-queue-branch": "IVR Support Queue (DTMF 1)",
  "ivr-timeout-default-queue-branch": "IVR Timeout Default Queue",
};

// ── CLI args ──────────────────────────────────────────────────────────────

function resolveArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

const outputFormat = resolveArg("--format") ?? "mp4";
const voiceoverPath = resolveArg("--voiceover");
const targetScenarioId = resolveArg("--scenario") ?? "ivr-support-queue-branch";
const logoPath = path.resolve(process.cwd(), "webapp/public/logo-800x800.png");

// ── Resolve inputs ────────────────────────────────────────────────────────

const youtubeDir = path.resolve(process.cwd(), "test-results/youtube");
const studioVideo = resolveArg("--studio")
  ?? path.join(youtubeDir, "studio-walkthrough.webm");

const timelinePath = path.join(youtubeDir, "youtube-timeline.json");
const youtubeTimeline = fs.existsSync(timelinePath)
  ? JSON.parse(fs.readFileSync(timelinePath, "utf8"))
  : null;

const e2eRoot = path.resolve(process.cwd(), "test-results", "e2e-suite");
const suiteDir = resolveArg("--suite")
  ?? (() => {
    if (!fs.existsSync(e2eRoot)) return "";
    const dirs = fs
      .readdirSync(e2eRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
      .map((d) => path.join(e2eRoot, d.name))
      .sort();
    // Prefer a suite containing only the target scenario (YouTube demo suite)
    for (const d of [...dirs].reverse()) {
      const sp = path.join(d, "suite-summary.json");
      if (!fs.existsSync(sp)) continue;
      try {
        const s = JSON.parse(fs.readFileSync(sp, "utf8"));
        if (s.scenarios?.length === 1 && s.scenarios[0].id === targetScenarioId) return d;
      } catch { /* ignore */ }
    }
    // Fallback: most recent
    return dirs.pop() ?? "";
  })();

const hasSuiteDir = suiteDir && fs.existsSync(path.join(suiteDir, "suite-summary.json"));

// ── Docker path resolution ────────────────────────────────────────────────
// Suite summaries generated inside Docker have /app/ prefix. Resolve to local.
const PROJECT_ROOT = path.resolve(process.cwd());
function resolveArtifactPath(p) {
  if (!p) return p;
  if (fs.existsSync(p)) return p;
  // Strip Docker /app/ prefix and resolve relative to project root
  if (p.startsWith("/app/")) {
    const local = path.join(PROJECT_ROOT, p.slice(5));
    if (fs.existsSync(local)) return local;
  }
  return p;
}

function fixSuiteArtifactPaths(suiteData) {
  if (!suiteData?.scenarios) return suiteData;
  for (const sc of suiteData.scenarios) {
    if (!sc.artifacts) continue;
    for (const art of sc.artifacts) {
      if (art.dir) art.dir = resolveArtifactPath(art.dir);
      if (art.salesforceVideo) art.salesforceVideo = resolveArtifactPath(art.salesforceVideo);
      if (art.ccpVideo) art.ccpVideo = resolveArtifactPath(art.ccpVideo);
      if (art.mergedVideo) art.mergedVideo = resolveArtifactPath(art.mergedVideo);
      if (art.timeline) art.timeline = resolveArtifactPath(art.timeline);
      if (art.screenshotOnFailure) art.screenshotOnFailure = resolveArtifactPath(art.screenshotOnFailure);
    }
  }
  return suiteData;
}

const suite = hasSuiteDir
  ? fixSuiteArtifactPaths(JSON.parse(fs.readFileSync(path.join(suiteDir, "suite-summary.json"), "utf8")))
  : null;
const hasStudioVideo = fs.existsSync(studioVideo);

// ── Build directory ───────────────────────────────────────────────────────

const tmpDir = path.join(youtubeDir, "_youtube-build");
if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });
fs.mkdirSync(youtubeDir, { recursive: true });

// ── H.264 codec args ─────────────────────────────────────────────────────

function h264Out() {
  return [
    "-c:v", "libx264", "-crf", H264_CRF, "-preset", H264_PRESET,
    "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.1",
  ];
}

// ── Segment naming ────────────────────────────────────────────────────────

const segments = [];
const chapters = [];
let segIdx = 0;

function segPath(name) {
  return path.join(tmpDir, `${String(segIdx++).padStart(3, "0")}-${name}.${outputFormat}`);
}

// ── Lower-third banner filter ─────────────────────────────────────────────

function lowerThirdFilter(chapterLabel, detailText) {
  return [
    `drawbox=x=0:y=ih-72:w=iw:h=72:color=black@0.8:t=fill`,
    `drawbox=x=0:y=ih-72:w=4:h=72:color=${BRAND.accent}:t=fill`,
    drawtext(chapterLabel.toUpperCase(), {
      size: 12, color: BRAND.accent, x: "16", y: "h-62",
    }),
    drawtext(detailText, {
      size: 20, color: BRAND.textPrimary, x: "16", y: "h-38",
    }),
  ].join(",");
}

// ── Build a video segment with lower-third ────────────────────────────────

function buildSegment({
  input, output, label,
  startSec = 0, durationSec = 0, speed = 1,
  chapterLabel = "", detailText = "",
  scaleFilter = null,
}) {
  const ssArgs = startSec > 0 ? ["-ss", startSec.toFixed(3)] : [];
  const tArgs = durationSec > 0 ? ["-t", durationSec.toFixed(3)] : [];

  const filters = [
    scaleFilter ?? `scale=${W}:${H}`,
    `fps=${FPS}`,
    "format=yuv420p",
  ];

  if (speed > 1) {
    filters.push(`setpts=PTS/${speed}`);
  }

  if (chapterLabel && detailText) {
    filters.push(lowerThirdFilter(chapterLabel, detailText));
  }

  return ffrun(ffmpegPath,
    ["-y", ...ssArgs, ...tArgs, "-i", input, "-vf", filters.join(","), ...h264Out(), output],
    label,
  );
}

// ── Build a title card ────────────────────────────────────────────────────

function buildCard({ output, lines, duration = 5, bgColor = BRAND.bgPrimary }) {
  const filters = lines.map((line) =>
    drawtext(line.text, {
      size: line.size ?? 24,
      color: line.color ?? BRAND.textPrimary,
      x: line.x ?? "(w-text_w)/2",
      y: String(line.y),
    })
  );

  return ffrun(ffmpegPath,
    ["-y", "-f", "lavfi", "-i", colorSrc(duration, bgColor, W, H, FPS),
     "-vf", filters.join(","), ...h264Out(), output],
    `Title card: ${lines[0]?.text?.slice(0, 40) ?? ""}`,
  );
}

// ── Add a segment and track its chapter ───────────────────────────────────

function addSegment(file, chapterName) {
  if (fs.existsSync(file)) {
    const dur = getDuration(file, ffmpegPath);
    segments.push(file);
    if (chapterName) {
      chapters.push({ label: chapterName, duration: dur });
    } else if (chapters.length > 0) {
      // Add to previous chapter's duration
      chapters[chapters.length - 1].duration += dur;
    }
  }
}

// ── Studio timeline to video seconds ──────────────────────────────────────

function studioTimelineToSec(tl) {
  if (!tl?.recordingStartMs) return null;
  const t0 = tl.recordingStartMs;
  const s = (ms) => (ms ? (ms - t0) / 1000 : null);
  return {
    landing: s(tl.landingShownMs),
    suiteCreated: s(tl.suiteCreatedMs),
    wizardStart: s(tl.wizardStartMs),
    wizardEnd: s(tl.wizardEndMs),
    scenarioReview: s(tl.scenarioReviewMs),
    runStart: s(tl.runStartMs),
    runFirstOutput: s(tl.runFirstOutputMs),
    runComplete: s(tl.runCompleteMs),
    recordingEnd: s(tl.recordingEndMs),
  };
}

// ── E2E scale filter (1280x720 → 1920x1080) ──────────────────────────────

const e2eScale = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0f1117`;
// Studio walkthrough is already 1920x1080
const studioScale = `scale=${W}:${H}`;

// ═══════════════════════════════════════════════════════════════════════════
// ── MAIN BUILD ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n=== Building YouTube Video ===\n");
console.log(`  Studio video:  ${hasStudioVideo ? studioVideo : "(not found)"}`);
console.log(`  Studio timeline: ${youtubeTimeline ? "yes" : "no"}`);
console.log(`  Suite dir:     ${suiteDir || "(none)"}`);
if (suite) console.log(`  Suite results: ${suite.totals.passed}/${suite.totals.scenarios} passed`);
console.log(`  Output format: ${outputFormat}`);
console.log(`  Resolution:    ${W}x${H} @ ${FPS}fps`);
console.log("");

// ═══════════════════════════════════════════════════════════════════════════
// ── Chapter 1: Intro (8s, with logo) ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

{
  const out = segPath("hook");
  buildCardWithLogo(ffmpegPath, {
    output: out, duration: 8,
    bgColor: BRAND.bgPrimary,
    w: W, h: H, fps: FPS,
    logoPath, logoSize: 180, logoY: 160,
    codecArgs: h264Out(),
    lines: [
      { text: "Audrique", size: 64, color: BRAND.info, y: 400 },
      { text: "Open-Source E2E Contact Center Testing", size: 28, color: BRAND.textPrimary, y: 480 },
      { text: "Browser + Telephony + CRM — One Automated Test", size: 22, color: BRAND.textSecondary, y: 530 },
      { text: "Salesforce Service Cloud Voice", size: 14, color: BRAND.muted, y: 590 },
    ],
  });
  addSegment(out, "Intro");
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Chapter 2: What is Audrique? (20s) ───────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

{
  const out = segPath("overview");
  buildCard({
    output: out, duration: 10,
    bgColor: BRAND.bgSecondary,
    lines: [
      { text: "What is Audrique?", size: 42, color: BRAND.info, y: 100 },
      { text: "Three parallel recording streams in one test run", size: 22, color: BRAND.textPrimary, y: 180 },
      { text: "Agent Browser", size: 20, color: BRAND.success, x: "200", y: 260 },
      { text: "Salesforce CRM — call handling, screen pop, Omni-Channel", size: 16, color: BRAND.textSecondary, x: "200", y: 295 },
      { text: "CCP Dialer", size: 20, color: BRAND.warning, x: "200", y: 360 },
      { text: "Amazon Connect — outbound dial, DTMF, IVR routing", size: 16, color: BRAND.textSecondary, x: "200", y: 395 },
      { text: "Supervisor Console", size: 20, color: BRAND.supervisor, x: "200", y: 460 },
      { text: "Command Center — queue monitoring, agent offer observation", size: 16, color: BRAND.textSecondary, x: "200", y: 495 },
      { text: "All orchestrated by Playwright + declarative YAML/JSON scenarios", size: 16, color: BRAND.muted, y: H - 80 },
    ],
  });
  addSegment(out, "What is Audrique?");
}

{
  const out = segPath("overview-2");
  buildCard({
    output: out, duration: 10,
    bgColor: BRAND.bgSecondary,
    lines: [
      { text: "Visual Scenario Builder", size: 42, color: BRAND.info, y: 100 },
      { text: "7-step wizard builds test scenarios — no code required", size: 22, color: BRAND.textPrimary, y: 180 },
      { text: "1. Call Setup", size: 18, color: BRAND.success, x: "300", y: 260 },
      { text: "2. IVR & Routing — DTMF branches, queue targets", size: 18, color: BRAND.success, x: "300", y: 300 },
      { text: "3. Agent — incoming detection, acceptance", size: 18, color: BRAND.success, x: "300", y: 340 },
      { text: "4. Conversation — hold, transcript, ACW", size: 18, color: BRAND.success, x: "300", y: 380 },
      { text: "5. Supervisor — queue + agent offer monitoring", size: 18, color: BRAND.success, x: "300", y: 420 },
      { text: "6. Details — ID, timeouts, failure handling", size: 18, color: BRAND.success, x: "300", y: 460 },
      { text: "7. Review — JSON preview + save", size: 18, color: BRAND.success, x: "300", y: 500 },
      { text: "Run from the UI with live SSE streaming output", size: 16, color: BRAND.muted, y: H - 80 },
    ],
  });
  // Part of same chapter
  if (fs.existsSync(out)) {
    segments.push(out);
    if (chapters.length > 0) chapters[chapters.length - 1].duration += 10;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Chapter 3: Current Release (v0.4.0) ──────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

{
  const out = segPath("current-release");
  buildCard({
    output: out, duration: 12,
    bgColor: BRAND.bgSecondary,
    lines: [
      { text: "v0.4.0 — Current Release", size: 38, color: BRAND.info, y: 100 },
      { text: "UI-Driven Configuration", size: 22, color: BRAND.success, x: "200", y: 220 },
      { text: "All org-specific settings configurable from Studio — zero hardcoded values", size: 16, color: BRAND.textSecondary, x: "200", y: 255 },
      { text: "Session Resilience", size: 22, color: BRAND.success, x: "200", y: 320 },
      { text: "HTTP liveness probes + auto-refresh before each suite run", size: 16, color: BRAND.textSecondary, x: "200", y: 355 },
      { text: "Two-Tab Supervisor Monitoring", size: 22, color: BRAND.success, x: "200", y: 420 },
      { text: "Dedicated In-Progress Work tab eliminates CTI adapter interference", size: 16, color: BRAND.textSecondary, x: "200", y: 455 },
      { text: "Run from UI", size: 22, color: BRAND.success, x: "200", y: 520 },
      { text: "Live SSE streaming output with per-scenario status cards", size: 16, color: BRAND.textSecondary, x: "200", y: 555 },
      { text: "40+ Advanced Settings | 17 files | MIT License", size: 14, color: BRAND.muted, y: H - 80 },
    ],
  });
  addSegment(out, "Current Release (v0.4.0)");
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Chapter 4: Roadmap ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

{
  const out = segPath("roadmap");
  buildCard({
    output: out, duration: 12,
    bgColor: BRAND.bgSecondary,
    lines: [
      { text: "Roadmap", size: 38, color: BRAND.info, y: 100 },
      { text: "NL Caller — AI-to-AI Voice Testing", size: 22, color: BRAND.accentLight, x: "200", y: 220 },
      { text: "LLM-driven customer simulates calls against Agentforce", size: 16, color: BRAND.textSecondary, x: "200", y: 255 },
      { text: "Pluggable Dialers", size: 22, color: BRAND.accentLight, x: "200", y: 320 },
      { text: "Twilio, Vonage, Amazon Connect — swap providers via config", size: 16, color: BRAND.textSecondary, x: "200", y: 355 },
      { text: "Parallel Load Testing", size: 22, color: BRAND.accentLight, x: "200", y: 420 },
      { text: "40-50+ simultaneous calls via agent pool federation", size: 16, color: BRAND.textSecondary, x: "200", y: 455 },
      { text: "Multi-Platform", size: 22, color: BRAND.accentLight, x: "200", y: 520 },
      { text: "ServiceNow, SAP, Zendesk, Genesys — same scenario DSL", size: 16, color: BRAND.textSecondary, x: "200", y: 555 },
      { text: "AI-native testing platform — LLM scenario gen, voice AI, self-healing tests", size: 14, color: BRAND.muted, y: H - 80 },
    ],
  });
  addSegment(out, "Roadmap");
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Chapters 5-7: Studio Walkthrough ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

if (hasStudioVideo) {
  const stTs = studioTimelineToSec(youtubeTimeline);
  const fullDuration = getDuration(studioVideo, ffmpegPath);

  // ── Chapter 5: Connection Setup (landing page segment) ──
  {
    const out = segPath("phase-setup-card");
    buildCard({
      output: out, duration: 3,
      bgColor: BRAND.bgSecondary,
      lines: [
        { text: "Connection Setup", size: 18, color: BRAND.info, y: H / 2 - 50 },
        { text: "Audrique Scenario Studio", size: 38, color: BRAND.textPrimary, y: H / 2 - 10 },
        { text: "localhost:4200", size: 16, color: BRAND.muted, y: H / 2 + 35 },
      ],
    });
    addSegment(out, "Connection Setup");
  }

  if (stTs) {
    const setupEnd = stTs.suiteCreated ?? stTs.wizardStart ?? 15;
    if (setupEnd > 2) {
      const out = segPath("setup");
      buildSegment({
        input: studioVideo, output: out,
        label: `Setup (${SPEED.studioSetup}x)`,
        startSec: 0, durationSec: setupEnd,
        speed: SPEED.studioSetup,
        chapterLabel: "SETUP",
        detailText: "Opening Studio and creating test suite",
        scaleFilter: studioScale,
      });
      if (fs.existsSync(out)) {
        segments.push(out);
        if (chapters.length > 0) chapters[chapters.length - 1].duration += setupEnd / SPEED.studioSetup;
      }
    }
  }

  // ── Chapter 6: Building a Test Scenario ──
  {
    const out = segPath("phase-build-card");
    buildCard({
      output: out, duration: 3,
      bgColor: BRAND.bgSecondary,
      lines: [
        { text: "Building a Test Scenario", size: 18, color: BRAND.info, y: H / 2 - 50 },
        { text: "IVR Support Queue — 7-Step Wizard", size: 34, color: BRAND.textPrimary, y: H / 2 - 10 },
        { text: "DTMF routing + supervisor observation", size: 16, color: BRAND.muted, y: H / 2 + 35 },
      ],
    });
    addSegment(out, "Building a Test Scenario");
  }

  // Per-wizard-step segments with lower-third annotations
  const STEP_DESCRIPTIONS = {
    "Call Setup": "Entry number and call trigger mode",
    "IVR & Routing": "DTMF digits and target queue",
    "Agent": "Screen pop and call handling",
    "Conversation": "Post-accept actions (hold, audio, transcript)",
    "Supervisor": "Queue monitoring and agent offer",
    "Details": "ID, description, execution settings",
    "Review": "Preview JSON and save to suite",
  };

  if (stTs && youtubeTimeline?.wizardScenario?.steps?.length > 0) {
    const sc = youtubeTimeline.wizardScenario;
    const t0 = youtubeTimeline.recordingStartMs;
    const toSec = (ms) => (ms ? (ms - t0) / 1000 : null);

    for (let j = 0; j < sc.steps.length; j++) {
      const stepStart = toSec(sc.steps[j].ms);
      const stepEnd = sc.steps[j + 1]?.ms
        ? toSec(sc.steps[j + 1].ms)
        : toSec(sc.savedAtMs);
      if (stepStart == null || stepEnd == null) continue;

      const stepName = sc.steps[j].step;
      const stepNum = j + 1;
      const desc = STEP_DESCRIPTIONS[stepName] ?? "";
      const dur = stepEnd - stepStart;
      if (dur < 1) continue;

      const out = segPath(`wizard-step${stepNum}`);
      buildSegment({
        input: studioVideo, output: out,
        label: `Wizard Step ${stepNum}: ${stepName}`,
        startSec: stepStart, durationSec: dur,
        speed: 1, // Already paced in recording
        chapterLabel: "BUILDING TEST",
        detailText: `Step ${stepNum}/7 — ${stepName}: ${desc}`,
        scaleFilter: studioScale,
      });
      if (fs.existsSync(out)) {
        segments.push(out);
        if (chapters.length > 0) chapters[chapters.length - 1].duration += dur;
      }
    }
  } else if (stTs && stTs.wizardStart != null) {
    // Fallback: single wizard segment
    const startSec = stTs.wizardStart;
    const endSec = stTs.wizardEnd ?? stTs.scenarioReview ?? fullDuration;
    const dur = endSec - startSec;
    if (dur > 2) {
      const out = segPath("wizard-full");
      buildSegment({
        input: studioVideo, output: out,
        label: "Wizard (full)",
        startSec, durationSec: dur,
        chapterLabel: "BUILDING TEST",
        detailText: "Building IVR Support Queue scenario via 7-step wizard",
        scaleFilter: studioScale,
      });
      if (fs.existsSync(out)) {
        segments.push(out);
        if (chapters.length > 0) chapters[chapters.length - 1].duration += dur;
      }
    }
  }

  // ── Chapter 7: Launching the Test ──
  if (stTs && stTs.runStart != null) {
    {
      const out = segPath("phase-run-card");
      buildCard({
        output: out, duration: 3,
        bgColor: BRAND.bgSecondary,
        lines: [
          { text: "Launching the Test", size: 18, color: BRAND.info, y: H / 2 - 50 },
          { text: "Live Suite Execution via SSE", size: 34, color: BRAND.textPrimary, y: H / 2 - 10 },
          { text: "Real-time streaming output in the browser", size: 16, color: BRAND.muted, y: H / 2 + 35 },
        ],
      });
      addSegment(out, "Launching the Test");
    }

    const runStart = stTs.scenarioReview ?? stTs.runStart;
    const runEnd = stTs.runComplete ?? stTs.recordingEnd ?? fullDuration;
    const dur = runEnd - runStart;
    if (dur > 2) {
      const out = segPath("run-execution");
      // First part at 1x (show the click + initial output), rest at 2x
      const firstPartEnd = Math.min(runStart + 10, runEnd);
      const firstPartDur = firstPartEnd - runStart;

      // First 10s at normal speed
      const out1 = segPath("run-start");
      buildSegment({
        input: studioVideo, output: out1,
        label: "Run start (1x)",
        startSec: runStart, durationSec: firstPartDur,
        chapterLabel: "RUNNING",
        detailText: "Suite execution launched — streaming output",
        scaleFilter: studioScale,
      });
      if (fs.existsSync(out1)) {
        segments.push(out1);
        if (chapters.length > 0) chapters[chapters.length - 1].duration += firstPartDur;
      }

      // Rest at 2x
      const restDur = runEnd - firstPartEnd;
      if (restDur > 3) {
        const out2 = segPath("run-fast");
        buildSegment({
          input: studioVideo, output: out2,
          label: "Run progress (2x)",
          startSec: firstPartEnd, durationSec: restDur,
          speed: 2,
          chapterLabel: "RUNNING",
          detailText: "Suite execution in progress (2x speed)",
          scaleFilter: studioScale,
        });
        if (fs.existsSync(out2)) {
          segments.push(out2);
          if (chapters.length > 0) chapters[chapters.length - 1].duration += restDur / 2;
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Chapters 8-12: Live E2E Execution (real call lifecycle) ──────────────
// ═══════════════════════════════════════════════════════════════════════════

if (suite) {
  const targetSc = suite.scenarios.find((sc) => sc.id === targetScenarioId)
    ?? suite.scenarios.find((sc) => sc.status === "passed");

  if (targetSc) {
    const sfVideo = targetSc.artifacts?.[0]?.salesforceVideo;
    const ccpVideo = targetSc.artifacts?.[0]?.ccpVideo;
    const supervisorVideo = findSupervisorVideo(targetSc);
    const supervisorInProgressVideo = findSupervisorInProgressVideo(targetSc);
    const tl = readTimeline(targetSc);
    const ts = timelineToVideoSec(tl);

    const hasSf = sfVideo && fs.existsSync(sfVideo);
    const hasCcp = ccpVideo && fs.existsSync(ccpVideo);
    const hasSupervisor = supervisorVideo && fs.existsSync(supervisorVideo);
    const hasSupervisorInProgress = supervisorInProgressVideo && fs.existsSync(supervisorInProgressVideo);

    console.log(`\n  Target scenario: ${targetSc.id} (${targetSc.status})`);
    console.log(`    SF: ${!!hasSf}  CCP: ${!!hasCcp}  Supervisor: ${!!hasSupervisor}  InProgress: ${!!hasSupervisorInProgress}  Timeline: ${!!ts}`);

    // ── Chapter 8: Agent Goes Online ──
    if (hasSf && ts && ts.preflightReady != null) {
      {
        const out = segPath("phase-agent-card");
        buildCard({
          output: out, duration: 3,
          bgColor: BRAND.bgSecondary,
          lines: [
            { text: "Agent Goes Online", size: 18, color: BRAND.info, y: H / 2 - 50 },
            { text: "Omni-Channel Login + Provider Status Sync", size: 34, color: BRAND.textPrimary, y: H / 2 - 10 },
            { text: "Agent becomes available for incoming calls", size: 16, color: BRAND.muted, y: H / 2 + 35 },
          ],
        });
        addSegment(out, "Agent Goes Online");
      }

      const preflightDur = ts.preflightReady + 3;
      const out = segPath("omni-login");
      buildSegment({
        input: sfVideo, output: out,
        label: "Omni-Channel login (2x)",
        startSec: 0, durationSec: preflightDur,
        speed: 2,
        chapterLabel: "AGENT ONLINE",
        detailText: "Omni-Channel login and telephony provider sync (2x speed)",
        scaleFilter: e2eScale,
      });
      if (fs.existsSync(out)) {
        segments.push(out);
        if (chapters.length > 0) chapters[chapters.length - 1].duration += preflightDur / 2;
      }
    }

    // ── Chapter 9: CCP Outbound Dial ──
    if (hasCcp) {
      {
        const out = segPath("phase-ccp-card");
        buildCard({
          output: out, duration: 3,
          bgColor: BRAND.bgSecondary,
          lines: [
            { text: "CCP Outbound Dial", size: 18, color: BRAND.info, y: H / 2 - 50 },
            { text: "Amazon Connect Places the Call", size: 34, color: BRAND.textPrimary, y: H / 2 - 10 },
            { text: "Twilio call routed through IVR to target queue", size: 16, color: BRAND.muted, y: H / 2 + 35 },
          ],
        });
        addSegment(out, "CCP Outbound Dial");
      }

      const out = segPath("ccp-dial");
      buildSegment({
        input: ccpVideo, output: out,
        label: `CCP dial (${SPEED.ccpDial}x)`,
        speed: SPEED.ccpDial,
        chapterLabel: "CCP DIALER",
        detailText: `Amazon Connect outbound dial (${SPEED.ccpDial}x speed)`,
        scaleFilter: e2eScale,
      });
      if (fs.existsSync(out)) {
        segments.push(out);
        const ccpDur = getDuration(ccpVideo, ffmpegPath);
        if (chapters.length > 0) chapters[chapters.length - 1].duration += ccpDur / SPEED.ccpDial;
      }
    }

    // ── Chapter 10: Supervisor Console ──
    // Prefer In-Progress Work video (shows count=1 reliably) over Queue Backlog
    // (Total Waiting often stays 0 for fast-routing scenarios).
    const useSupervisorInProgress = hasSupervisorInProgress;
    const supervisorSource = useSupervisorInProgress ? supervisorInProgressVideo : supervisorVideo;
    const hasSupervisorAny = hasSupervisor || hasSupervisorInProgress;

    if (hasSupervisorAny) {
      {
        const out = segPath("phase-supervisor-card");
        const subtitle = useSupervisorInProgress
          ? "In-Progress Work — Active Call Detected"
          : "Call Enters Queue — Waiting Count Increases";
        const detail = useSupervisorInProgress
          ? "Command Center In-Progress Work monitoring"
          : "Command Center real-time queue monitoring";
        buildCard({
          output: out, duration: 3,
          bgColor: BRAND.bgSecondary,
          lines: [
            { text: "Supervisor Console", size: 18, color: BRAND.info, y: H / 2 - 50 },
            { text: subtitle, size: 34, color: BRAND.textPrimary, y: H / 2 - 10 },
            { text: detail, size: 16, color: BRAND.muted, y: H / 2 + 35 },
          ],
        });
        addSegment(out, "Supervisor Console");
      }

      const supDuration = getDuration(supervisorSource, ffmpegPath);
      const startedMs = Number(tl?.supervisorObserverStartedMs ?? 0);
      const observedMs = Number(tl?.supervisorQueueObservedMs ?? 0);

      let segStart = 0;
      let segDur = Math.min(supDuration, 20);

      if (startedMs > 0 && observedMs > startedMs) {
        // The DOM-level detection (observedMs) fires several seconds before the
        // page visually refreshes to show the updated count.  For in-progress
        // work, the visual refresh lag is ~8-10s after the DOM observation.
        // Start a few seconds before the visual change and extend well past it
        // so the viewer sees the count flip from 0 → 1.
        const observedAt = (observedMs - startedMs) / 1000;
        const visualLag = useSupervisorInProgress ? 10 : 5;
        const idealEnd = observedAt + visualLag + 5;  // show 5s after visual change
        // Start ~5s before the visual change becomes visible
        segStart = Math.max(0, observedAt + visualLag - 5);
        segDur = Math.min(supDuration - segStart, idealEnd - segStart, 25);
      }

      const out = segPath("supervisor-queue");
      const supLabel = useSupervisorInProgress
        ? "Supervisor in-progress observation (1x)"
        : "Supervisor queue observation (1x)";
      const supDetail = useSupervisorInProgress
        ? "In-Progress Work — active call detected on agent"
        : "Queue waiting count changes — call detected in queue";
      buildSegment({
        input: supervisorSource, output: out,
        label: supLabel,
        startSec: segStart, durationSec: segDur,
        chapterLabel: "SUPERVISOR",
        detailText: supDetail,
        scaleFilter: e2eScale,
      });
      if (fs.existsSync(out)) {
        segments.push(out);
        if (chapters.length > 0) chapters[chapters.length - 1].duration += segDur;
      }
    }

    // ── Chapter 11: Call Acceptance ──
    if (hasSf && ts && ts.incomingDetected != null && ts.acceptClicked != null) {
      {
        const out = segPath("phase-accept-card");
        buildCard({
          output: out, duration: 3,
          bgColor: BRAND.bgSecondary,
          lines: [
            { text: "Call Acceptance", size: 18, color: BRAND.info, y: H / 2 - 50 },
            { text: "Agent Accepts Incoming Call", size: 34, color: BRAND.textPrimary, y: H / 2 - 10 },
            { text: "Omni-Channel widget displays the offer", size: 16, color: BRAND.muted, y: H / 2 + 35 },
          ],
        });
        addSegment(out, "Call Acceptance");
      }

      const acceptStart = Math.max(0, ts.incomingDetected - 2);
      const acceptEnd = ts.acceptClicked + 3;
      const acceptDur = Math.min(acceptEnd - acceptStart, 15);

      const out = segPath("omni-accept");
      buildSegment({
        input: sfVideo, output: out,
        label: "Call acceptance (1x)",
        startSec: acceptStart, durationSec: acceptDur,
        chapterLabel: "CALL ACCEPTANCE",
        detailText: "Omni-Channel offer appears — agent accepts the call",
        scaleFilter: e2eScale,
      });
      if (fs.existsSync(out)) {
        segments.push(out);
        if (chapters.length > 0) chapters[chapters.length - 1].duration += acceptDur;
      }
    }

    // ── Chapter 12: VoiceCall Record ──
    if (hasSf && ts && ts.acceptClicked != null) {
      {
        const out = segPath("phase-screenpop-card");
        buildCard({
          output: out, duration: 3,
          bgColor: BRAND.bgSecondary,
          lines: [
            { text: "VoiceCall Record", size: 18, color: BRAND.info, y: H / 2 - 50 },
            { text: "Screen Pop — Record Created from Call", size: 34, color: BRAND.textPrimary, y: H / 2 - 10 },
            { text: "VoiceCall record with contact and case details", size: 16, color: BRAND.muted, y: H / 2 + 35 },
          ],
        });
        addSegment(out, "VoiceCall Record");
      }

      const spStart = ts.acceptClicked;
      const spEnd = ts.screenPopDetected ? ts.screenPopDetected + 8 : spStart + 15;
      const spDur = Math.min(spEnd - spStart, 20);

      const out = segPath("voicecall-record");
      buildSegment({
        input: sfVideo, output: out,
        label: "VoiceCall screen pop (1x)",
        startSec: spStart, durationSec: spDur,
        chapterLabel: "SCREEN POP",
        detailText: "VoiceCall record appears — screen pop verified",
        scaleFilter: e2eScale,
      });
      if (fs.existsSync(out)) {
        segments.push(out);
        if (chapters.length > 0) chapters[chapters.length - 1].duration += spDur;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Chapter 13: Video Evidence Output ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

{
  const out = segPath("phase-evidence-card");
  buildCard({
    output: out, duration: 3,
    bgColor: BRAND.bgSecondary,
    lines: [
      { text: "Video Evidence Output", size: 18, color: BRAND.info, y: H / 2 - 50 },
      { text: "Annotated Highlight Reel", size: 34, color: BRAND.textPrimary, y: H / 2 - 10 },
      { text: "Automated speed modulation, title cards, and pass/fail overlays", size: 16, color: BRAND.muted, y: H / 2 + 35 },
    ],
  });
  addSegment(out, "Video Evidence Output");
}

// Show highlight reel sample if available
if (suiteDir) {
  const highlightReel = path.join(suiteDir, "highlight-reel.webm");
  if (fs.existsSync(highlightReel)) {
    const hlDuration = getDuration(highlightReel, ffmpegPath);
    // Show a 30s sample from the middle at 2x
    const sampleStart = Math.max(0, hlDuration / 2 - 15);
    const sampleDur = Math.min(30, hlDuration - sampleStart);

    const out = segPath("highlight-sample");
    buildSegment({
      input: highlightReel, output: out,
      label: `Highlight reel (${SPEED.highlightSample}x)`,
      startSec: sampleStart, durationSec: sampleDur,
      speed: SPEED.highlightSample,
      chapterLabel: "HIGHLIGHT REEL",
      detailText: `Automated evidence video (${SPEED.highlightSample}x speed)`,
      scaleFilter: e2eScale,
    });
    if (fs.existsSync(out)) {
      segments.push(out);
      if (chapters.length > 0) chapters[chapters.length - 1].duration += sampleDur / SPEED.highlightSample;
    }
  }
}

// Results summary card — show only the target scenario
if (suite) {
  const out = segPath("results-summary");
  const target = suite.scenarios.find((sc) => sc.id === targetScenarioId);
  const isPassed = target?.status === "passed";

  const lines = [
    { text: isPassed ? "Test Passed" : "Test Result", size: 42,
      color: isPassed ? BRAND.success : BRAND.danger, y: 120 },
    { text: TITLES[targetScenarioId] ?? targetScenarioId, size: 28,
      color: BRAND.textPrimary, y: 200 },
  ];

  if (target) {
    const assertions = buildAssertions(target);
    for (let j = 0; j < assertions.length && j < 8; j++) {
      lines.push({
        text: assertions[j],
        size: 18, color: "0x7ee787", x: "300", y: 280 + j * 36,
      });
    }
  }

  lines.push({
    text: "Real call via Amazon Connect — CCP dial + SF agent + supervisor + screen pop",
    size: 16, color: BRAND.textSecondary, y: H - 80,
  });

  buildCard({ output: out, duration: 8, bgColor: BRAND.bgPrimary, lines });
  if (fs.existsSync(out)) {
    segments.push(out);
    if (chapters.length > 0) chapters[chapters.length - 1].duration += 8;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Chapter 14: Outro (with logo) ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

{
  const out = segPath("outro");
  buildCardWithLogo(ffmpegPath, {
    output: out, duration: 8,
    bgColor: BRAND.bgPrimary,
    w: W, h: H, fps: FPS,
    logoPath, logoSize: 150, logoY: 200,
    codecArgs: h264Out(),
    lines: [
      { text: "Audrique", size: 54, color: BRAND.info, y: 420 },
      { text: "Open-Source E2E Contact Center Testing", size: 24, color: BRAND.textSecondary, y: 490 },
      { text: "Salesforce Service Cloud Voice + Amazon Connect", size: 18, color: BRAND.muted, y: 540 },
      { text: "Like & Subscribe for more demos", size: 22, color: BRAND.success, y: 620 },
      { text: "github.com/audrique", size: 16, color: BRAND.accent, y: 670 },
    ],
  });
  addSegment(out, "Outro");
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Final Concatenation ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

if (segments.length === 0) {
  console.error("\n  No segments built. Provide studio video and/or suite results.");
  process.exit(1);
}

console.log(`\n  Concatenating ${segments.length} segments ...`);
const concatList = path.join(tmpDir, "concat.txt");
fs.writeFileSync(concatList, segments.map((s) => `file '${s}'`).join("\n"));

const concatRaw = path.join(tmpDir, `concat-raw.${outputFormat}`);

// Try stream-copy concat first (fast)
let ok = ffrun(ffmpegPath,
  ["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", concatRaw],
  "Concat (stream copy)",
);

if (!ok) {
  // Fallback: re-encode concat
  ok = ffrun(ffmpegPath,
    ["-y", "-f", "concat", "-safe", "0", "-i", concatList, ...h264Out(), concatRaw],
    "Concat (re-encode)",
  );
}

if (!ok || !fs.existsSync(concatRaw)) {
  console.error("\n  Failed to concatenate segments.");
  process.exit(1);
}

// ── Mux audio track ──────────────────────────────────────────────────────

const finalOutput = path.join(youtubeDir, `youtube-video.${outputFormat}`);

if (voiceoverPath && fs.existsSync(voiceoverPath)) {
  // Merge voiceover audio
  ok = ffrun(ffmpegPath,
    ["-y", "-i", concatRaw, "-i", voiceoverPath,
     "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
     "-map", "0:v:0", "-map", "1:a:0",
     "-shortest", finalOutput],
    "Final assembly with voiceover",
  );
} else {
  // Silent audio track for YouTube compliance
  ok = ffrun(ffmpegPath,
    ["-y", "-i", concatRaw,
     "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
     "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
     "-shortest", finalOutput],
    "Final assembly with silent audio",
  );
}

if (ok && fs.existsSync(finalOutput)) {
  const stat = fs.statSync(finalOutput);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
  const durSec = getDuration(finalOutput, ffmpegPath);
  const mins = Math.floor(durSec / 60);
  const secs = Math.round(durSec % 60);

  console.log(`\n  YouTube video created!`);
  console.log(`  Output:   ${finalOutput}`);
  console.log(`  Duration: ${mins}m ${secs}s`);
  console.log(`  Size:     ${sizeMB} MB`);
  console.log(`  Segments: ${segments.length}`);

  // ── Print YouTube chapter timestamps ─────────────────────────────
  console.log(`\n=== YouTube Chapter Timestamps ===\n`);
  let elapsed = 0;
  for (const ch of chapters) {
    const mm = Math.floor(elapsed / 60);
    const ss = Math.floor(elapsed % 60);
    console.log(`${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")} ${ch.label}`);
    elapsed += ch.duration;
  }
  console.log("");

  // ── Print YouTube description template ───────────────────────────
  console.log("=== YouTube Description Template ===\n");
  console.log("Audrique — Open-Source E2E Testing for Contact Centers");
  console.log("");
  console.log("In this video, I walk through building and running an end-to-end");
  console.log("test scenario for Salesforce Service Cloud Voice + Amazon Connect.");
  console.log("");
  console.log("What you'll see:");
  console.log("- Building a test scenario from scratch using the visual Scenario Studio");
  console.log("- Real IVR routing with DTMF digit input");
  console.log("- Salesforce agent receiving an incoming call");
  console.log("- Supervisor console monitoring queue state");
  console.log("- VoiceCall record screen pop verification");
  console.log("- Automated video evidence with speed modulation");
  console.log("");
  console.log("Chapters:");
  elapsed = 0;
  for (const ch of chapters) {
    const mm = Math.floor(elapsed / 60);
    const ss = Math.floor(elapsed % 60);
    console.log(`${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")} ${ch.label}`);
    elapsed += ch.duration;
  }
  console.log("");
  console.log("#audrique #salesforce #contactcenter #e2etesting #amazonconnect");
  console.log("");
} else {
  console.error("\n  Failed to create YouTube video.");
  process.exit(1);
}
