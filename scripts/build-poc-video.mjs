#!/usr/bin/env node
/**
 * build-poc-video.mjs
 *
 * Creates a single combined POC demo video from all E2E suite results.
 * Adds title cards with scenario descriptions and assertion checklists,
 * annotated merged videos with banners, and a summary outro.
 *
 * Usage: node scripts/build-poc-video.mjs [suite-dir]
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

// ── Find a usable system font ──────────────────────────────
const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf"
];
const FONT = FONT_CANDIDATES.find((p) => fs.existsSync(p)) ?? "";

// ── Resolve suite directory ────────────────────────────────
const e2eRoot = path.resolve(process.cwd(), "test-results", "e2e-suite");
const suiteDir =
  process.argv[2] ??
  fs
    .readdirSync(e2eRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(e2eRoot, d.name))
    .sort()
    .pop();

if (!suiteDir || !fs.existsSync(suiteDir)) {
  console.error("No suite directory found.");
  process.exit(1);
}

const suite = JSON.parse(
  fs.readFileSync(path.join(suiteDir, "suite-summary.json"), "utf8")
);

const tmpDir = path.join(suiteDir, "_poc-build");
if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });

// ── Scenario display names ─────────────────────────────────
const TITLES = {
  "inbound-agent-offer": "Inbound Agent Offer",
  "ivr-support-queue-branch": "IVR Support Queue (DTMF 1)",
  "ivr-timeout-default-queue-branch": "IVR Timeout Default Queue"
};

// ── Build assertion list per scenario ──────────────────────
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

function readTimeline(sc) {
  const tp = sc.artifacts?.[0]?.timeline;
  if (!tp || !fs.existsSync(tp)) return null;
  try {
    return JSON.parse(fs.readFileSync(tp, "utf8"));
  } catch {
    return null;
  }
}

// ── FFmpeg helpers ─────────────────────────────────────────
function escText(str) {
  // Escape for drawtext text= inside single quotes.
  // Handle backslash, colon (parameter separator), and single quotes.
  return str
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\u2019"); // replace apostrophe with unicode right-quote
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
  console.log(`  [build] ${label} ...`);
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
  // Try ffprobe first
  const r = spawnSync("ffprobe", [
    "-v", "quiet", "-print_format", "json", "-show_format", videoPath
  ], { encoding: "utf8", timeout: 10_000, stdio: "pipe" });
  if (r.status === 0) {
    try { return parseFloat(JSON.parse(r.stdout).format.duration); } catch {}
  }
  // Fallback: parse ffmpeg stderr
  const r2 = spawnSync(ffmpegPath, ["-i", videoPath], {
    encoding: "utf8", stdio: "pipe", timeout: 10_000
  });
  const m = r2.stderr?.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 100;
  return 30;
}

// ── Build all segments ─────────────────────────────────────
console.log("\n=== Building POC Demo Video ===\n");
const segments = [];

// ── INTRO CARD (5s) ────────────────────────────────────────
const introOut = path.join(tmpDir, "00-intro.webm");
{
  const vf = [
    drawtext("SCV End-to-End Automated Testing", { size: 44, y: "h/2-60" }),
    drawtext("Salesforce Service Cloud Voice + Amazon Connect", {
      size: 22, color: "0xaaaaaa", y: "h/2"
    }),
    drawtext(
      `${suite.totals.scenarios} Scenarios | ${suite.totals.passed} Passed | ${Math.round(suite.durationSec)}s total`,
      { size: 18, color: "0x3fb950", y: "h/2+50" }
    )
  ].join(",");

  ffrun(
    ["-y", "-f", "lavfi", "-i", colorSrc(5), "-vf", vf, ...vpxOut(), introOut],
    "Intro card"
  );
  segments.push(introOut);
}

// ── EACH SCENARIO ──────────────────────────────────────────
for (let i = 0; i < suite.scenarios.length; i++) {
  const sc = suite.scenarios[i];
  const num = i + 1;
  const title = TITLES[sc.id] ?? sc.id;
  const assertions = buildAssertions(sc);
  const merged = sc.artifacts?.[0]?.mergedVideo;
  const passed = sc.status === "passed";

  // ── Title card ───────────────────────────────────────────
  const titleOut = path.join(tmpDir, `${String(num).padStart(2, "0")}-title.webm`);
  {
    const dur = Math.max(5, 3 + assertions.length * 0.8);
    const filters = [
      drawtext(`Scenario ${num}`, { size: 42, color: "0x58a6ff", y: "70" }),
      drawtext(title, { size: 34, y: "130" }),
      drawtext(sc.description.replace(/[:.]/g, " ").trim(), {
        size: 15, color: "0x888888", y: "180"
      })
    ];

    // Assertion checklist
    for (let j = 0; j < assertions.length; j++) {
      filters.push(
        drawtext(`[${j + 1}] ${assertions[j]}`, {
          size: 20,
          color: "0x7ee787",
          x: "160",
          y: String(240 + j * 36)
        })
      );
    }

    // Result badge at bottom
    filters.push(
      drawtext(passed ? "RESULT - PASSED" : "RESULT - FAILED", {
        size: 24,
        color: passed ? "0x3fb950" : "0xf85149",
        y: "h-60"
      })
    );

    ffrun(
      [
        "-y", "-f", "lavfi", "-i", colorSrc(dur, "0x161b22"),
        "-vf", filters.join(","),
        ...vpxOut(),
        titleOut
      ],
      `Scenario ${num} title card`
    );
    segments.push(titleOut);
  }

  // ── Annotated merged video ───────────────────────────────
  if (merged && fs.existsSync(merged)) {
    const videoOut = path.join(tmpDir, `${String(num).padStart(2, "0")}-video.webm`);

    const filters = [
      `scale=${W}:${H}`,
      `fps=${FPS}`,
      "format=yuv420p",
      // Semi-transparent bottom banner
      `drawbox=x=0:y=ih-48:w=iw:h=48:color=black@0.7:t=fill`,
      // Banner text - scenario label
      drawtext(`Scenario ${num} - ${title}`, {
        size: 18, x: "20", y: "h-35"
      }),
      // Status badge at bottom-right
      drawtext(`${passed ? "PASSED" : "FAILED"} | ${Math.round(sc.durationSec)}s`, {
        size: 16,
        color: passed ? "0x3fb950" : "0xf85149",
        x: "w-text_w-20",
        y: "h-35"
      })
    ];

    ffrun(
      [
        "-y", "-i", merged,
        "-vf", filters.join(","),
        "-c:v", "libvpx-vp9", "-crf", VP9_CRF, "-b:v", "0",
        videoOut
      ],
      `Scenario ${num} annotated video`
    );
    segments.push(videoOut);
  }
}

// ── OUTRO CARD (5s) ────────────────────────────────────────
const outroOut = path.join(tmpDir, "99-outro.webm");
{
  const allPassed = suite.totals.passed === suite.totals.scenarios;
  const vf = [
    drawtext(
      allPassed
        ? `All ${suite.totals.scenarios} Scenarios PASSED`
        : `${suite.totals.passed}/${suite.totals.scenarios} Passed`,
      { size: 44, color: allPassed ? "0x3fb950" : "0xf85149", y: "h/2-50" }
    ),
    drawtext(`Total Duration - ${Math.round(suite.durationSec)} seconds`, {
      size: 22, color: "0xaaaaaa", y: "h/2+10"
    }),
    drawtext("SCV End-to-End Automated Testing POC", {
      size: 16, color: "0x555555", y: "h/2+55"
    })
  ].join(",");

  ffrun(
    ["-y", "-f", "lavfi", "-i", colorSrc(5), "-vf", vf, ...vpxOut(), outroOut],
    "Outro card"
  );
  segments.push(outroOut);
}

// ── CONCATENATE ALL SEGMENTS ───────────────────────────────
console.log("\n  Concatenating all segments ...");
const concatList = path.join(tmpDir, "concat.txt");
fs.writeFileSync(
  concatList,
  segments.map((s) => `file '${s}'`).join("\n")
);

const finalOutput = path.join(suiteDir, "poc-demo.webm");

// Try stream-copy first (faster, works when all segments match)
let ok = ffrun(
  ["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", finalOutput],
  "Final concat (stream copy)"
);

if (!ok) {
  // Fall back to re-encode if formats don't match exactly
  ok = ffrun(
    [
      "-y", "-f", "concat", "-safe", "0", "-i", concatList,
      "-c:v", "libvpx-vp9", "-crf", VP9_CRF, "-b:v", "0",
      finalOutput
    ],
    "Final concat (re-encode)"
  );
}

if (ok) {
  const stat = fs.statSync(finalOutput);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
  console.log(`\n  POC video created successfully!`);
  console.log(`  Output: ${finalOutput}`);
  console.log(`  Size:   ${sizeMB} MB\n`);
} else {
  console.error("\n  Failed to create POC video.\n");
  process.exit(1);
}
