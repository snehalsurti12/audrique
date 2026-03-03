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
 *   - 10-chapter structure with YouTube timestamps
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
  buildAssertions,
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
// ── Chapter 1: Hook/Intro (15s) ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

{
  const out = segPath("hook");
  const passedCount = suite?.totals?.passed ?? "?";
  const totalCount = suite?.totals?.scenarios ?? "?";

  buildCard({
    output: out, duration: 8,
    bgColor: BRAND.bgPrimary,
    lines: [
      { text: "Audrique", size: 64, color: BRAND.info, y: H / 2 - 120 },
      { text: "Open-Source E2E Contact Center Testing", size: 28, color: BRAND.textPrimary, y: H / 2 - 40 },
      { text: "Browser + Telephony + CRM — One Automated Test", size: 22, color: BRAND.textSecondary, y: H / 2 + 20 },
      { text: `${totalCount} Scenarios | ${passedCount} Passed | Real Calls via Amazon Connect`, size: 18, color: BRAND.success, y: H / 2 + 80 },
      { text: "Salesforce Service Cloud Voice", size: 14, color: BRAND.muted, y: H / 2 + 130 },
    ],
  });
  addSegment(out, "Intro");
}

// If we have E2E results, show a quick montage of key frames
if (suite) {
  const targetSc = suite.scenarios.find((sc) => sc.id === "ivr-support-queue-branch")
    ?? suite.scenarios.find((sc) => sc.status === "passed");

  if (targetSc) {
    const sfVideo = targetSc.artifacts?.[0]?.salesforceVideo;
    const tl = readTimeline(targetSc);
    const ts = timelineToVideoSec(tl);

    // Quick montage: 3 key moments at 2.5s each
    if (sfVideo && fs.existsSync(sfVideo) && ts) {
      const moments = [
        { sec: ts.incomingDetected, label: "Incoming Call Detection" },
        { sec: ts.acceptClicked, label: "Agent Accepts Call" },
        { sec: ts.screenPopDetected, label: "VoiceCall Screen Pop" },
      ].filter((m) => m.sec != null);

      for (const m of moments) {
        const out = segPath("montage");
        buildSegment({
          input: sfVideo, output: out,
          label: `Montage: ${m.label}`,
          startSec: Math.max(0, m.sec - 0.5),
          durationSec: 2.5,
          chapterLabel: "LIVE TEST",
          detailText: m.label,
          scaleFilter: e2eScale,
        });
        if (fs.existsSync(out)) {
          segments.push(out);
          // Don't create new chapter — still part of Intro
          if (chapters.length > 0) chapters[chapters.length - 1].duration += 2.5;
        }
      }
    }
  }
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
// ── Chapters 3-5: Studio Walkthrough ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

if (hasStudioVideo) {
  const stTs = studioTimelineToSec(youtubeTimeline);
  const fullDuration = getDuration(studioVideo, ffmpegPath);

  // ── Chapter 3: Connection Setup (landing page segment) ──
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

  // ── Chapter 4: Building a Test Scenario ──
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

  // ── Chapter 5: Launching the Test ──
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
// ── Chapters 6-8: Live E2E Execution Evidence ────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

if (suite) {
  // Find the IVR support queue scenario (focal scenario for the video)
  const targetSc = suite.scenarios.find((sc) => sc.id === "ivr-support-queue-branch")
    ?? suite.scenarios.find((sc) => sc.status === "passed");

  if (targetSc) {
    const sfVideo = targetSc.artifacts?.[0]?.salesforceVideo;
    const ccpVideo = targetSc.artifacts?.[0]?.ccpVideo;
    const supervisorVideo = findSupervisorVideo(targetSc);
    const tl = readTimeline(targetSc);
    const ts = timelineToVideoSec(tl);

    const hasSf = sfVideo && fs.existsSync(sfVideo);
    const hasCcp = ccpVideo && fs.existsSync(ccpVideo);
    const hasSupervisor = supervisorVideo && fs.existsSync(supervisorVideo);

    console.log(`\n  Target scenario: ${targetSc.id} (${targetSc.status})`);
    console.log(`    SF: ${!!hasSf}  CCP: ${!!hasCcp}  Supervisor: ${!!hasSupervisor}  Timeline: ${!!ts}`);

    // ── Chapter 6: Salesforce Call Arrival ──
    if (hasSf && ts && ts.incomingDetected != null) {
      {
        const out = segPath("phase-sf-card");
        buildCard({
          output: out, duration: 3,
          bgColor: BRAND.bgSecondary,
          lines: [
            { text: "Salesforce Call Arrival", size: 18, color: BRAND.info, y: H / 2 - 50 },
            { text: "Agent Receives Incoming Call", size: 34, color: BRAND.textPrimary, y: H / 2 - 10 },
            { text: "Omni-Channel notification in Service Console", size: 16, color: BRAND.muted, y: H / 2 + 35 },
          ],
        });
        addSegment(out, "Salesforce Call Arrival");
      }

      // Show preflight at 3x (first time seeing SF)
      if (ts.preflightReady > 5) {
        const out = segPath("sf-preflight");
        buildSegment({
          input: sfVideo, output: out,
          label: `SF preflight (${SPEED.preflight}x)`,
          startSec: 0, durationSec: ts.preflightReady,
          speed: SPEED.preflight,
          chapterLabel: "SALESFORCE",
          detailText: `Preflight setup (${SPEED.preflight}x speed)`,
          scaleFilter: e2eScale,
        });
        if (fs.existsSync(out)) {
          segments.push(out);
          if (chapters.length > 0) chapters[chapters.length - 1].duration += ts.preflightReady / SPEED.preflight;
        }
      }

      // CCP dial at 2x
      if (hasCcp) {
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

      // Dead wait at 6x
      if (ts.ccpDialConfirmed != null && ts.incomingDetected != null) {
        const deadDur = ts.incomingDetected - ts.ccpDialConfirmed;
        if (deadDur > 3) {
          const out = segPath("dead-wait");
          buildSegment({
            input: sfVideo, output: out,
            label: `Dead wait (${SPEED.deadWait}x)`,
            startSec: ts.ccpDialConfirmed, durationSec: deadDur,
            speed: SPEED.deadWait,
            chapterLabel: "WAITING",
            detailText: `Call routing through IVR (${SPEED.deadWait}x speed)`,
            scaleFilter: e2eScale,
          });
          if (fs.existsSync(out)) {
            segments.push(out);
            if (chapters.length > 0) chapters[chapters.length - 1].duration += deadDur / SPEED.deadWait;
          }
        }
      }

      // Call arrival at 1x (the key moment)
      const arrivalStart = Math.max(0, ts.incomingDetected - 1);
      const arrivalEnd = ts.acceptClicked ?? ts.incomingDetected + 5;
      const arrivalDur = arrivalEnd - arrivalStart;
      {
        const out = segPath("call-arrival");
        buildSegment({
          input: sfVideo, output: out,
          label: "Call arrival (1x)",
          startSec: arrivalStart, durationSec: Math.min(arrivalDur, 15),
          chapterLabel: "INCOMING CALL",
          detailText: "Call arrives on Salesforce agent — Omni-Channel notification",
          scaleFilter: e2eScale,
        });
        if (fs.existsSync(out)) {
          segments.push(out);
          if (chapters.length > 0) chapters[chapters.length - 1].duration += Math.min(arrivalDur, 15);
        }
      }
    }

    // ── Chapter 7: Supervisor Console ──
    if (hasSupervisor && tl) {
      {
        const out = segPath("phase-supervisor-card");
        buildCard({
          output: out, duration: 3,
          bgColor: BRAND.bgSecondary,
          lines: [
            { text: "Supervisor Console", size: 18, color: BRAND.info, y: H / 2 - 50 },
            { text: "Queue Monitoring in Command Center", size: 34, color: BRAND.textPrimary, y: H / 2 - 10 },
            { text: "Real-time queue waiting and in-progress observation", size: 16, color: BRAND.muted, y: H / 2 + 35 },
          ],
        });
        addSegment(out, "Supervisor Console");
      }

      const startedMs = Number(tl.supervisorObserverStartedMs ?? 0);
      const observedMs = Number(tl.supervisorQueueObservedMs ?? 0);
      if (startedMs > 0 && observedMs > startedMs) {
        const observedAt = (observedMs - startedMs) / 1000;
        const segStart = Math.max(0, observedAt - 8);
        const segDur = Math.max(6, observedAt + 5 - segStart);

        const out = segPath("supervisor");
        buildSegment({
          input: supervisorVideo, output: out,
          label: "Supervisor observation (1x)",
          startSec: segStart, durationSec: segDur,
          chapterLabel: "SUPERVISOR",
          detailText: "Queue waiting count changes — call detected",
          scaleFilter: e2eScale,
        });
        if (fs.existsSync(out)) {
          segments.push(out);
          if (chapters.length > 0) chapters[chapters.length - 1].duration += segDur;
        }
      }
    }

    // ── Chapter 8: Call Acceptance & Screen Pop ──
    if (hasSf && ts && ts.acceptClicked != null) {
      {
        const out = segPath("phase-accept-card");
        buildCard({
          output: out, duration: 3,
          bgColor: BRAND.bgSecondary,
          lines: [
            { text: "Call Acceptance", size: 18, color: BRAND.info, y: H / 2 - 50 },
            { text: "Agent Accepts — VoiceCall Screen Pop", size: 34, color: BRAND.textPrimary, y: H / 2 - 10 },
            { text: "VoiceCall record created with contact details", size: 16, color: BRAND.muted, y: H / 2 + 35 },
          ],
        });
        addSegment(out, "Call Acceptance");
      }

      const acceptStart = Math.max(0, ts.acceptClicked - 1);
      const acceptEnd = ts.testEnd ?? ts.screenPopDetected ? ts.screenPopDetected + 8 : acceptStart + 15;
      const acceptDur = Math.min(acceptEnd - acceptStart, 20);

      const out = segPath("accept-screenpop");
      buildSegment({
        input: sfVideo, output: out,
        label: "Accept + Screen Pop (1x)",
        startSec: acceptStart, durationSec: acceptDur,
        chapterLabel: "KEY MOMENT",
        detailText: "Agent accepts call — VoiceCall screen pop appears",
        scaleFilter: e2eScale,
      });
      if (fs.existsSync(out)) {
        segments.push(out);
        if (chapters.length > 0) chapters[chapters.length - 1].duration += acceptDur;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Chapter 9: Video Evidence Output ─────────────────────────────────────
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

// Results summary card
if (suite) {
  const out = segPath("results-summary");
  const passed = suite.scenarios.filter((sc) => sc.status === "passed");
  const failed = suite.scenarios.filter((sc) => sc.status !== "passed" && sc.status !== "allowed_failure");

  const lines = [
    { text: `${passed.length}/${suite.totals.scenarios} E2E Scenarios Passed`, size: 36,
      color: failed.length === 0 ? BRAND.success : BRAND.danger, y: 80 },
  ];

  for (let j = 0; j < passed.length; j++) {
    lines.push({
      text: `  ${TITLES[passed[j].id] ?? passed[j].id}`,
      size: 20, color: "0x7ee787", x: "200", y: 160 + j * 36,
    });
  }

  lines.push({
    text: "Real calls via Amazon Connect — CCP dial + SF agent + supervisor + screen pop",
    size: 16, color: BRAND.textSecondary, y: H - 80,
  });

  buildCard({ output: out, duration: 6, bgColor: BRAND.bgPrimary, lines });
  if (fs.existsSync(out)) {
    segments.push(out);
    if (chapters.length > 0) chapters[chapters.length - 1].duration += 6;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Chapter 10: Outro ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

{
  const out = segPath("outro");
  buildCard({
    output: out, duration: 8,
    bgColor: BRAND.bgPrimary,
    lines: [
      { text: "Audrique", size: 54, color: BRAND.info, y: H / 2 - 100 },
      { text: "Open-Source E2E Contact Center Testing", size: 24, color: BRAND.textSecondary, y: H / 2 - 30 },
      { text: "Salesforce Service Cloud Voice + Amazon Connect", size: 18, color: BRAND.muted, y: H / 2 + 20 },
      { text: "Like & Subscribe for more demos", size: 22, color: BRAND.success, y: H / 2 + 90 },
      { text: "github.com/audrique", size: 16, color: BRAND.accent, y: H / 2 + 140 },
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
