#!/usr/bin/env node
/**
 * merge-e2e-highlight.mjs
 *
 * Creates a ~3–5 minute highlight reel from E2E suite results.
 * - Shows preflight ONCE (scenario 1 only, at 3x speed)
 * - Replaces preflight for scenarios 2+ with title cards
 * - Speeds up dead wait (dial→incoming) at 4x
 * - Speeds up CCP dial segments at 2x
 * - Keeps all key moments (accept, screen pop, supervisor) at full speed
 *
 * Usage: node scripts/merge-e2e-highlight.mjs [suite-dir]
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

// ── Speedup factors ────────────────────────────────────────
const PREFLIGHT_SPEED = 3;
const DEAD_WAIT_SPEED = 4;
const CCP_SPEED = 2;

// ── Usable system font ─────────────────────────────────────
const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf"
];
const FONT = FONT_CANDIDATES.find((p) => fs.existsSync(p)) ?? "";

// ── Scenario display names ──────────────────────────────────
const TITLES = {
  "inbound-agent-offer": "Inbound Agent Offer",
  "ivr-support-queue-branch": "IVR Support Queue (DTMF 1)",
  "ivr-timeout-default-queue-branch": "IVR Timeout Default Queue"
};

// ── Resolve suite directory ─────────────────────────────────
const e2eRoot = path.resolve(process.cwd(), "test-results", "e2e-suite");
const suiteDir = path.resolve(
  process.argv[2] ??
  fs
    .readdirSync(e2eRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(e2eRoot, d.name))
    .sort()
    .pop() ??
  ""
);

if (!suiteDir || !fs.existsSync(suiteDir)) {
  console.error("No suite directory found.");
  process.exit(1);
}

if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
  console.error("ffmpeg binary not found (ffmpeg-static).");
  process.exit(1);
}

const suite = JSON.parse(
  fs.readFileSync(path.join(suiteDir, "suite-summary.json"), "utf8")
);

const tmpDir = path.join(suiteDir, "_highlight-build");
if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });

// ── FFmpeg helpers ──────────────────────────────────────────

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
  console.log(`  [highlight] ${label} ...`);
  const r = spawnSync(ffmpegPath, args, {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 300_000
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

// ── Timeline helpers ────────────────────────────────────────

function readTimeline(sc) {
  const tp = sc.artifacts?.[0]?.timeline;
  if (!tp || !fs.existsSync(tp)) return null;
  try {
    return JSON.parse(fs.readFileSync(tp, "utf8"));
  } catch {
    return null;
  }
}

/** Convert absolute ms timestamps to seconds relative to video start. */
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

// ── Assertion list builder ──────────────────────────────────

function buildAssertions(sc) {
  const env = sc.appliedEnv ?? {};
  const items = [];
  if (env.CONNECT_CCP_IVR_DIGITS) {
    items.push(`CCP dial + DTMF ${env.CONNECT_CCP_IVR_DIGITS}`);
  } else {
    items.push(sc.id.includes("timeout")
      ? "CCP dial (no DTMF - timeout)"
      : "CCP outbound dial");
  }
  if (env.VERIFY_SUPERVISOR_QUEUE_WAITING === "true") {
    items.push(`Supervisor: ${env.SUPERVISOR_QUEUE_NAME ?? "queue"}`);
  }
  items.push("Incoming call + accept");
  if (env.VERIFY_SUPERVISOR_AGENT_OFFER === "true") {
    items.push("Supervisor: agent offer");
  }
  items.push("VoiceCall screen pop");
  return items;
}

// ── Build a video segment with optional speed + banner ──────

function buildVideoSegment({
  input, output, label,
  startSec = 0, durationSec = 0, speed = 1,
  bannerText = "", bannerColor = "0xd29922", bannerPosition = "bottom"
}) {
  const ssArgs = startSec > 0 ? ["-ss", startSec.toFixed(3)] : [];
  const tArgs = durationSec > 0 ? ["-t", durationSec.toFixed(3)] : [];

  const filters = [`scale=${W}:${H}`, `fps=${FPS}`, "format=yuv420p"];

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

// ── Build a title card ────────────────────────��─────────────

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

// ── Find supervisor video in artifact attachments ───────────

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
// ── Main build ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

console.log("\n=== Building Highlight Reel ===\n");
const segments = [];
let segIdx = 0;

function segPath(name) {
  return path.join(tmpDir, `${String(segIdx++).padStart(3, "0")}-${name}.webm`);
}

// ── INTRO CARD (5s) ─────────────────────────────────────────
{
  const out = segPath("intro");
  const vf = [
    drawtext("SCV End-to-End Automated Testing", { size: 42, y: "h/2-55" }),
    drawtext("Highlight Reel", { size: 26, color: "0x58a6ff", y: "h/2-5" }),
    drawtext(
      `${suite.totals.scenarios} Scenarios | ${suite.totals.passed} Passed | ${Math.round(suite.durationSec)}s total`,
      { size: 18, color: "0x3fb950", y: "h/2+45" }
    )
  ].join(",");

  if (ffrun(["-y", "-f", "lavfi", "-i", colorSrc(5), "-vf", vf, ...vpxOut(), out], "Intro card")) {
    segments.push(out);
  }
}

// ── EACH SCENARIO ───────────────────────────────────────────
for (let i = 0; i < suite.scenarios.length; i++) {
  const sc = suite.scenarios[i];
  const num = i + 1;
  const title = TITLES[sc.id] ?? sc.id;
  const passed = sc.status === "passed";
  const assertions = buildAssertions(sc);
  const timeline = readTimeline(sc);
  const ts = timelineToVideoSec(timeline);

  const sfVideo = sc.artifacts?.[0]?.salesforceVideo;
  const ccpVideo = sc.artifacts?.[0]?.ccpVideo;
  const mergedVideo = sc.artifacts?.[0]?.mergedVideo;
  const supervisorVideo = findSupervisorVideo(sc);

  const hasSf = sfVideo && fs.existsSync(sfVideo);
  const hasCcp = ccpVideo && fs.existsSync(ccpVideo);
  const hasMerged = mergedVideo && fs.existsSync(mergedVideo);

  console.log(`\n  --- Scenario ${num}: ${title} ---`);
  console.log(`  SF: ${!!hasSf}  CCP: ${!!hasCcp}  Timeline: ${!!ts}  Supervisor: ${!!supervisorVideo}`);
  if (ts) {
    console.log(`  Preflight: ${ts.preflightReady?.toFixed(1) ?? "-"}s  Dial→Incoming: ${
      ts.ccpDialConfirmed && ts.incomingDetected
        ? (ts.incomingDetected - ts.ccpDialConfirmed).toFixed(1) + "s"
        : "-"
    }  Key: ${
      ts.incomingDetected && ts.testEnd
        ? (ts.testEnd - ts.incomingDetected).toFixed(1) + "s"
        : "-"
    }`);
  }

  // ── Fallback: no timeline → use merged video with title card ──
  if (!ts || !hasSf) {
    const titleOut = segPath("title-card");
    buildTitleCard({ output: titleOut, scenarioNum: num, title, description: sc.description, assertions, passed, duration: sc.durationSec });
    if (fs.existsSync(titleOut)) segments.push(titleOut);

    const fallbackVideo = hasMerged ? mergedVideo : hasSf ? sfVideo : null;
    if (fallbackVideo) {
      const out = segPath("fallback");
      buildVideoSegment({
        input: fallbackVideo, output: out,
        label: `S${num} fallback video`,
        bannerText: `Scenario ${num} - ${title}`,
        bannerColor: "0x58a6ff"
      });
      if (fs.existsSync(out)) segments.push(out);
    }
    continue;
  }

  // ── SCENARIO 1: include preflight at 3x ───────────────────
  if (i === 0) {
    if (ts.preflightReady > 5) {
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
  } else {
    // ── SCENARIOS 2+: title card instead of preflight ────────
    const titleOut = segPath("title-card");
    buildTitleCard({ output: titleOut, scenarioNum: num, title, description: sc.description, assertions, passed, duration: sc.durationSec });
    if (fs.existsSync(titleOut)) segments.push(titleOut);
  }

  // ── CCP dial at 2x ────────────────────────────────────────
  if (hasCcp) {
    const out = segPath("ccp-dial");
    buildVideoSegment({
      input: ccpVideo, output: out,
      label: `S${num} CCP dial (${CCP_SPEED}x)`,
      speed: CCP_SPEED,
      bannerText: i === 0
        ? `>> CCP Outbound Dial (${CCP_SPEED}x speed)`
        : `>> Scenario ${num} - CCP Dial (${CCP_SPEED}x speed)`,
      bannerColor: "0xd29922",
      bannerPosition: "top"
    });
    if (fs.existsSync(out)) segments.push(out);
  }

  // ── Dead wait at 4x (ccpDialConfirmed → incomingDetected in SF video) ──
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

  // ── Supervisor segment at 1x (trimmed ±8s/+5s around observation) ──
  // Shown BEFORE key moments: supervisor sees call in queue, then agent accepts.
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
        bannerText: `Scenario ${num} - Supervisor Queue Observation`,
        bannerColor: "0xbc8cff"
      });
      if (fs.existsSync(out)) segments.push(out);
    }
  }

  // ── Key moments at 1x (from ~1s before incoming to end) ───
  if (ts.incomingDetected != null) {
    const keyStart = Math.max(0, ts.incomingDetected - 1);
    const out = segPath("key-moments");
    buildVideoSegment({
      input: sfVideo, output: out,
      label: `S${num} key moments`,
      startSec: keyStart,
      bannerText: i === 0
        ? "Salesforce - Call Accept & Screen Pop"
        : `Scenario ${num} - Accept & Screen Pop`,
      bannerColor: "0x3fb950"
    });
    if (fs.existsSync(out)) segments.push(out);
  }
}

// ── OUTRO CARD (5s) ─────────────────────────────────────────
{
  const out = segPath("outro");
  const allPassed = suite.totals.passed === suite.totals.scenarios;
  const vf = [
    drawtext(
      allPassed
        ? `All ${suite.totals.scenarios} Scenarios PASSED`
        : `${suite.totals.passed}/${suite.totals.scenarios} Passed`,
      { size: 42, color: allPassed ? "0x3fb950" : "0xf85149", y: "h/2-45" }
    ),
    drawtext(`Total Duration - ${Math.round(suite.durationSec)} seconds`, {
      size: 22, color: "0xaaaaaa", y: "h/2+15"
    }),
    drawtext("SCV End-to-End Automated Testing", {
      size: 16, color: "0x555555", y: "h/2+55"
    })
  ].join(",");

  if (ffrun(["-y", "-f", "lavfi", "-i", colorSrc(5), "-vf", vf, ...vpxOut(), out], "Outro card")) {
    segments.push(out);
  }
}

// ── CONCATENATE ALL SEGMENTS ────────────────────────────────
console.log(`\n  Concatenating ${segments.length} segments ...`);
const concatList = path.join(tmpDir, "concat.txt");
fs.writeFileSync(concatList, segments.map((s) => `file '${s}'`).join("\n"));

const finalOutput = path.join(suiteDir, "highlight-reel.webm");

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
  console.log(`\n  Highlight reel created!`);
  console.log(`  Output:   ${finalOutput}`);
  console.log(`  Duration: ${mins}m ${secs}s`);
  console.log(`  Size:     ${sizeMB} MB\n`);
} else {
  console.error("\n  Failed to create highlight reel.\n");
  process.exit(1);
}
