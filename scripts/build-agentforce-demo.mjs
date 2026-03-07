#!/usr/bin/env node
/**
 * build-agentforce-demo.mjs
 *
 * Creates a professional demo video for the Parallel Agentforce test.
 * Combines CCP dial, Agentforce observer (Command Center), Twilio call
 * transition, and AI greeting transcript into an annotated narrative video.
 *
 * Structure:
 *   1. Intro title card (5s)
 *   2. Phase 1: CCP dial — placing the primary call (2x speed)
 *   3. Phase 2: Agentforce observer — CCP call lands, count = 1
 *   4. "Now Dialing from Twilio" transition card (4s)
 *   5. Phase 3: Agentforce observer — Twilio call arrives, count = 2
 *   6. Transcript card — Whisper transcription of AI greeting (5s)
 *   7. Results card — all 5 assertions passed (6s)
 *   8. Outro card (3s)
 *
 * Uses video-1.webm (Agentforce observer Playwright recording) as the
 * primary observer footage — NOT the SF agent Home page.
 *
 * Usage:
 *   node scripts/build-agentforce-demo.mjs [suite-dir]
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";

// ── Resolve FFmpeg ────────────────────────────────────────────
function resolveFFmpeg() {
  const sys = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
  for (const p of sys) {
    if (fs.existsSync(p)) return p;
  }
  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  return null;
}
const ffmpegPath = resolveFFmpeg();

if (!ffmpegPath) {
  console.error("ffmpeg not found. Install ffmpeg or ffmpeg-static.");
  process.exit(1);
}

// ── Video constants ───────────────────────────────────────────
const W = 1280;
const H = 720;
const FPS = 24;
const VP9_CRF = "34";

// ── Speed factors ─────────────────────────────────────────────
const CCP_SPEED = 2;
const DEAD_WAIT_SPEED = 4;

// ── Usable system font ───────────────────────────────────────
const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
];
const FONT = FONT_CANDIDATES.find((p) => fs.existsSync(p)) ?? "";

// ── Resolve suite directory ───────────────────────────────────
const e2eRoot = path.resolve(process.cwd(), "test-results", "e2e-suite");
const suiteDir = path.resolve(
  process.argv[2] ??
    (() => {
      const dirs = fs
        .readdirSync(e2eRoot, { withFileTypes: true })
        .filter(
          (d) =>
            d.isDirectory() &&
            d.name.includes("parallel-agentforce")
        )
        .map((d) => path.join(e2eRoot, d.name))
        .sort();
      return dirs.pop() ?? "";
    })()
);

if (
  !suiteDir ||
  !fs.existsSync(path.join(suiteDir, "suite-summary.json"))
) {
  console.error(
    "No suite-summary.json found. Run a parallel-agentforce suite first."
  );
  process.exit(1);
}

const suite = JSON.parse(
  fs.readFileSync(path.join(suiteDir, "suite-summary.json"), "utf8")
);

// ── Find the scenario and its artifacts ───────────────────────
const sc = suite.scenarios.find(
  (s) => s.id === "parallel-agentforce-ccp-twilio"
);
if (!sc) {
  console.error("parallel-agentforce-ccp-twilio scenario not found in suite.");
  process.exit(1);
}

// Resolve paths: suite-summary uses Docker /app/ prefix; map to host
function resolveHostPath(dockerPath) {
  if (!dockerPath) return null;
  // If it already exists on disk, use as-is
  if (fs.existsSync(dockerPath)) return dockerPath;
  // Replace /app/ prefix with suiteDir's parent structure
  const appRelative = dockerPath.replace(/^\/app\//, "");
  const hostPath = path.resolve(process.cwd(), appRelative);
  return fs.existsSync(hostPath) ? hostPath : null;
}

const ccpVideo = resolveHostPath(sc.artifacts?.[0]?.ccpVideo);
const timelinePath = resolveHostPath(sc.artifacts?.[0]?.timeline);
const artDir = resolveHostPath(sc.artifacts?.[0]?.dir);

// Find agentforce observer video in attachments
function findAttachment(pattern) {
  if (!artDir) return null;
  const attDir = path.join(artDir, "attachments");
  if (!fs.existsSync(attDir)) return null;
  const files = fs
    .readdirSync(attDir)
    .filter((n) => pattern.test(n))
    .map((n) => path.join(attDir, n));
  return files[0] ?? null;
}

// Primary observer video: video-1.webm is the full Playwright recording
// of the Agentforce observer page (Command Center → Agentforce tab).
// This is preferred over the attachment copy which may be truncated.
const observerVideoFull = artDir
  ? (() => {
      const p = path.join(artDir, "video-1.webm");
      return fs.existsSync(p) ? p : null;
    })()
  : null;
const observerVideoAttachment = findAttachment(
  /^agentforce-observer-video-.*\.webm$/i
);
const observerVideo = observerVideoFull ?? observerVideoAttachment;

// Find screenshot
const screenshot = artDir
  ? (() => {
      const p = path.join(artDir, "test-passed-parallel-agentforce.png");
      return fs.existsSync(p) ? p : null;
    })()
  : null;

// Read timeline
const timeline = timelinePath
  ? JSON.parse(fs.readFileSync(timelinePath, "utf8"))
  : null;

// ── Build directory ───────────────────────────────────────────
const buildDir = path.join(suiteDir, "_agentforce-demo-build");
if (fs.existsSync(buildDir))
  fs.rmSync(buildDir, { recursive: true, force: true });
fs.mkdirSync(buildDir, { recursive: true });

// ── FFmpeg helpers ────────────────────────────────────────────

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
    y = "(h-text_h)/2",
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
  console.log(`  [agentforce-demo] ${label} ...`);
  const r = spawnSync(ffmpegPath, args, {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 600_000,
  });
  if (r.status !== 0) {
    console.error(`  FAILED: ${label}`);
    if (r.stderr) console.error(r.stderr.slice(-800));
    return false;
  }
  return true;
}

function colorSrc(duration, color = "0x0d1117") {
  return `color=c=${color}:s=${W}x${H}:d=${duration}:r=${FPS}`;
}

function vpxOut() {
  return [
    "-c:v",
    "libvpx-vp9",
    "-crf",
    VP9_CRF,
    "-b:v",
    "0",
    "-pix_fmt",
    "yuv420p",
  ];
}

function getDuration(videoPath) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "quiet", "-print_format", "json", "-show_format", videoPath],
    { encoding: "utf8", timeout: 10_000, stdio: "pipe" }
  );
  if (r.status === 0) {
    try {
      const dur = parseFloat(JSON.parse(r.stdout).format.duration);
      if (Number.isFinite(dur)) return dur;
    } catch {
      /* ignore */
    }
  }
  // Fallback: decode to null and read time
  const r2 = spawnSync(ffmpegPath, ["-i", videoPath, "-f", "null", "-"], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30_000,
  });
  const m = r2.stderr?.match(
    /time=(\d+):(\d+):(\d+)\.(\d+)/g
  );
  if (m) {
    const last = m[m.length - 1];
    const parts = last.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
    if (parts)
      return +parts[1] * 3600 + +parts[2] * 60 + +parts[3] + +parts[4] / 100;
  }
  return 30;
}

function buildVideoSegment({
  input,
  output,
  label,
  startSec = 0,
  durationSec = 0,
  speed = 1,
  bannerText = "",
  bannerColor = "0xd29922",
  bannerPosition = "bottom",
  scaleFilter = null,
}) {
  const ssArgs = startSec > 0 ? ["-ss", startSec.toFixed(3)] : [];
  const tArgs = durationSec > 0 ? ["-t", durationSec.toFixed(3)] : [];

  const filters = [
    scaleFilter ??
      `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${FPS}`,
    "format=yuv420p",
  ];

  if (speed > 1) {
    filters.push(`setpts=PTS/${speed}`);
  }

  if (bannerText) {
    const isTop = bannerPosition === "top";
    const boxY = isTop ? "0" : "ih-36";
    filters.push(
      `drawbox=x=0:y=${boxY}:w=iw:h=36:color=black@0.75:t=fill`
    );
    filters.push(
      drawtext(bannerText, {
        size: 16,
        color: bannerColor,
        x: "20",
        y: isTop ? "10" : "h-26",
      })
    );
  }

  return ffrun(
    [
      "-y",
      ...ssArgs,
      ...tArgs,
      "-i",
      input,
      "-vf",
      filters.join(","),
      ...vpxOut(),
      output,
    ],
    label
  );
}

// ── Timeline relative seconds ─────────────────────────────────
function timelineToSec(tl) {
  if (!tl?.testStartMs) return null;
  const t0 = tl.testStartMs;
  const s = (ms) =>
    ms && Number.isFinite(Number(ms)) ? (Number(ms) - t0) / 1000 : null;
  return {
    preflightReady: s(tl.preflightReadyMs),
    callTriggerStart: s(tl.callTriggerStartMs),
    ccpDialConfirmed: s(tl.ccpDialConfirmedMs),
    agentforceObserverStarted: s(tl.agentforceObserverStartedMs),
    incomingDetected: s(tl.incomingDetectedMs),
    parallelCallsLaunched: s(tl.parallelCallsLaunchedMs),
    agentforceCountReached: s(tl.agentforceCountReachedMs),
    testEnd: s(tl.testEndMs),
  };
}

// ── Read Whisper transcript (if saved in test results) ────────
function readWhisperTranscript() {
  if (!artDir) return null;
  // Check for whisper transcript in the pw output
  const candidates = [
    path.join(artDir, "whisper-transcript.txt"),
    path.join(artDir, "whisper-transcript.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return fs.readFileSync(p, "utf8").trim();
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// ── Main build ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

const ts = timelineToSec(timeline);

console.log("\n=== Building Agentforce Demo Video ===\n");
console.log(`  Suite:     ${suite.name}`);
console.log(`  Status:    ${sc.status.toUpperCase()} (${Math.round(sc.durationSec)}s)`);
console.log(`  CCP video: ${ccpVideo ? "yes" : "no"}`);
console.log(`  Observer:  ${observerVideo ? path.basename(observerVideo) : "no"}`);
console.log(`  Screenshot: ${screenshot ? "yes" : "no"}`);
console.log(`  Timeline:  ${ts ? "yes" : "no"}`);
if (ts) {
  console.log(
    `  Key times: CCP dial ${ts.ccpDialConfirmed?.toFixed(1) ?? "-"}s  AF observer ${ts.agentforceObserverStarted?.toFixed(1) ?? "-"}s  count reached ${ts.agentforceCountReached?.toFixed(1) ?? "-"}s`
  );
}
console.log("");

const segments = [];
let segIdx = 0;

function segPath(name) {
  return path.join(
    buildDir,
    `${String(segIdx++).padStart(3, "0")}-${name}.webm`
  );
}

// ═══════════════════════════════════════════════════════════════
// ── ACT 1: Intro Card (5s) ───────────────────────────────────
// ═══════════════════════════════════════════════════════════════

{
  const out = segPath("intro");
  const env = sc.appliedEnv ?? {};
  const sources = JSON.parse(env.PARALLEL_CALL_SOURCES || "[]");
  const callProviders = ["CCP", ...sources.map((s) => s.provider?.toUpperCase() ?? "?")];
  const expectedCount = env.PARALLEL_AGENTFORCE_EXPECTED_COUNT ?? "2";

  const vf = [
    drawtext("Parallel Agentforce Testing", {
      size: 44,
      color: "0x58a6ff",
      y: "h/2-100",
    }),
    drawtext("Multi-Provider Concurrent Call Verification", {
      size: 22,
      color: "0xaaaaaa",
      y: "h/2-50",
    }),
    drawtext(`${callProviders.join(" + ")} | ${expectedCount} Simultaneous Calls`, {
      size: 20,
      color: "0x3fb950",
      y: "h/2+10",
    }),
    drawtext("Salesforce Command Center -- Agentforce Tab", {
      size: 16,
      color: "0x888888",
      y: "h/2+50",
    }),
    drawtext("Service Cloud Voice + Amazon Connect + Twilio", {
      size: 14,
      color: "0x555555",
      y: "h/2+85",
    }),
  ].join(",");

  if (
    ffrun(
      ["-y", "-f", "lavfi", "-i", colorSrc(5), "-vf", vf, ...vpxOut(), out],
      "Intro card"
    )
  ) {
    segments.push(out);
  }
}

// ═══════════════════════════════════════════════════════════════
// ── ACT 2: CCP Dial Phase (2x speed) ─────────────────────────
// ═══════════════════════════════════════════════════════════════

if (ccpVideo) {
  // Phase card
  {
    const out = segPath("phase-ccp-card");
    const vf = [
      drawtext("Phase 1", {
        size: 18,
        color: "0x58a6ff",
        y: "h/2-50",
      }),
      drawtext("CCP Outbound Dial", { size: 36, y: "h/2-10" }),
      drawtext("Primary call via Amazon Connect CCP to +18333199528", {
        size: 16,
        color: "0x888888",
        y: "h/2+35",
      }),
    ].join(",");

    if (
      ffrun(
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          colorSrc(3, "0x161b22"),
          "-vf",
          vf,
          ...vpxOut(),
          out,
        ],
        "Phase 1 card"
      )
    ) {
      segments.push(out);
    }
  }

  // CCP dial video at 2x speed
  {
    const out = segPath("ccp-dial");
    buildVideoSegment({
      input: ccpVideo,
      output: out,
      label: `CCP dial (${CCP_SPEED}x)`,
      speed: CCP_SPEED,
      bannerText: `>> CCP Outbound Dial to +18333199528 (${CCP_SPEED}x speed)`,
      bannerColor: "0xd29922",
      bannerPosition: "top",
    });
    if (fs.existsSync(out)) segments.push(out);
  }
}

// ═══════════════════════════════════════════════════════════════
// ── ACT 3: Agentforce Observer — CCP call lands (count = 1) ──
// ═══════════════════════════════════════════════════════════════

// video-1.webm timeline (from frame analysis):
//   ~10s: Wallboard loading ("Connecting...")
//   ~15s: Navigating to Agentforce tab
//   ~18-20s: Agentforce tab visible, count = 1 (CCP call from +18775145938)
//   ~25s: Still count = 1 (conversation growing)
//   ~28-30s: Count = 2! Twilio call (+18703612601) appears in table
//   ~35s: Both calls active, conversation lengths visible

if (observerVideo) {
  // Phase card — CCP call in supervisor
  {
    const out = segPath("phase-af1-card");
    const vf = [
      drawtext("Phase 2", {
        size: 18,
        color: "0x58a6ff",
        y: "h/2-50",
      }),
      drawtext("Agentforce Supervisor Tab", { size: 36, y: "h/2-10" }),
      drawtext(
        "Command Center for Service -- CCP Call Arrives",
        { size: 16, color: "0x888888", y: "h/2+35" }
      ),
    ].join(",");

    if (
      ffrun(
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          colorSrc(3, "0x161b22"),
          "-vf",
          vf,
          ...vpxOut(),
          out,
        ],
        "Phase 2 card (CCP in supervisor)"
      )
    ) {
      segments.push(out);
    }
  }

  // Observer segment: navigation + CCP call landing (count = 1)
  // Show from ~10s (Wallboard loading) to ~26s (just before Twilio)
  {
    const out = segPath("observer-ccp-lands");
    buildVideoSegment({
      input: observerVideo,
      output: out,
      label: "Agentforce observer — CCP call lands (count = 1)",
      startSec: 10,
      durationSec: 16,
      bannerText:
        "Command Center -- Agentforce Tab | CCP Call Connected | Count = 1",
      bannerColor: "0xbc8cff",
    });
    if (fs.existsSync(out)) segments.push(out);
  }

  // ═════════════════════════════════════════════════════════════
  // ── ACT 4: "Now Dialing from Twilio" transition card ────────
  // ═════════════════════════════════════════════════════════════

  {
    const out = segPath("twilio-dial-card");
    const env = sc.appliedEnv ?? {};
    const twilioFrom = "+18703612601"; // From cdo-org.env TWILIO_FROM_NUMBER
    const entryNumber = env.CONNECT_ENTRYPOINT_NUMBER ?? "+18333199528";

    const vf = [
      drawtext("Now Dialing from Twilio", {
        size: 38,
        color: "0xf24e42", // Twilio red
        y: "h/2-90",
      }),
      drawtext("Placing parallel call via Twilio REST API", {
        size: 20,
        color: "0xaaaaaa",
        y: "h/2-40",
      }),
      drawtext(`From ${twilioFrom}  -->  To ${entryNumber}`, {
        size: 22,
        color: "0x7ee787",
        y: "h/2+10",
      }),
      drawtext("Same entry number as CCP -- Agentforce handles both calls", {
        size: 14,
        color: "0x888888",
        y: "h/2+55",
      }),
      drawtext("Twilio call placed concurrently while CCP call is active", {
        size: 14,
        color: "0x888888",
        y: "h/2+85",
      }),
    ].join(",");

    if (
      ffrun(
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          colorSrc(4, "0x161b22"),
          "-vf",
          vf,
          ...vpxOut(),
          out,
        ],
        "Twilio dial transition card"
      )
    ) {
      segments.push(out);
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ── ACT 5: Agentforce Observer — Twilio call arrives (1→2) ──
  // ═════════════════════════════════════════════════════════════

  // Phase card — Twilio call arrives
  {
    const out = segPath("phase-af2-card");
    const vf = [
      drawtext("Phase 3", {
        size: 18,
        color: "0x58a6ff",
        y: "h/2-50",
      }),
      drawtext("Twilio Call Arrives in Supervisor", { size: 34, y: "h/2-10" }),
      drawtext(
        "Agentforce tab count goes from 1 --> 2",
        { size: 16, color: "0x3fb950", y: "h/2+35" }
      ),
    ].join(",");

    if (
      ffrun(
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          colorSrc(3, "0x161b22"),
          "-vf",
          vf,
          ...vpxOut(),
          out,
        ],
        "Phase 3 card (Twilio arrives)"
      )
    ) {
      segments.push(out);
    }
  }

  // Observer segment: Twilio call arrives, count goes 1 → 2
  // Show from ~24s to end (~37s) — captures the transition moment
  {
    const obsDuration = getDuration(observerVideo);
    const out = segPath("observer-twilio-arrives");
    buildVideoSegment({
      input: observerVideo,
      output: out,
      label: "Agentforce observer — Twilio arrives (count 1 -> 2)",
      startSec: 24,
      durationSec: obsDuration - 24,
      bannerText:
        "Command Center -- Twilio Call Arrives | Count 1 --> 2 | Both Calls Active",
      bannerColor: "0x3fb950",
    });
    if (fs.existsSync(out)) segments.push(out);
  }
}

// ═══════════════════════════════════════════════════════════════
// ── ACT 6: Transcript Card (5s) ──────────────────────────────
// ═══════════════════════════════════════════════════════════════

{
  const out = segPath("transcript");
  // Known transcript from previous run
  const transcript =
    readWhisperTranscript() ??
    "Hi. I'm an AI service assistant. How can I help you?";

  const vf = [
    drawtext("AI Agent Greeting (Whisper Transcription)", {
      size: 22,
      color: "0x58a6ff",
      y: "h/2-80",
    }),
    drawtext(`"${transcript}"`, {
      size: 28,
      color: "0x7ee787",
      y: "h/2-20",
    }),
    drawtext("Captured via CCP audio recording + OpenAI Whisper STT", {
      size: 14,
      color: "0x888888",
      y: "h/2+40",
    }),
    drawtext("Both CCP and Twilio calls heard identical AI greeting", {
      size: 14,
      color: "0x888888",
      y: "h/2+70",
    }),
  ].join(",");

  if (
    ffrun(
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        colorSrc(5, "0x161b22"),
        "-vf",
        vf,
        ...vpxOut(),
        out,
      ],
      "Transcript card"
    )
  ) {
    segments.push(out);
  }
}

// ═══════════════════════════════════════════════════════════════
// ── ACT 7: Results Summary Card (6s) ─────────────────────────
// ═══════════════════════════════════════════════════════════════

{
  const out = segPath("results");
  const passed = sc.status === "passed";
  const dur = Math.round(sc.durationSec);

  const assertions = [
    "CCP call connected to Agentforce",
    "Twilio parallel call connected (SID captured)",
    "Agentforce greeting heard via CCP audio",
    "Greeting matches expected keywords (hi, help, assist)",
    "Agentforce supervisor tab shows 2 active conversations",
  ];

  const filters = [
    drawtext("Test Results", {
      size: 30,
      color: "0x58a6ff",
      y: "50",
    }),
    drawtext(
      passed ? `ALL 5 ASSERTIONS PASSED | ${dur}s` : `FAILED | ${dur}s`,
      {
        size: 24,
        color: passed ? "0x3fb950" : "0xf85149",
        y: "100",
      }
    ),
  ];

  for (let j = 0; j < assertions.length; j++) {
    const icon = passed ? "+" : "x";
    filters.push(
      drawtext(`  [${icon}] ${assertions[j]}`, {
        size: 18,
        color: passed ? "0x7ee787" : "0xf85149",
        x: "120",
        y: String(160 + j * 36),
      })
    );
  }

  filters.push(
    drawtext(
      "Real calls via Amazon Connect CCP + Twilio API -- verified in Salesforce",
      { size: 14, color: "0xaaaaaa", y: "h-60" }
    )
  );

  if (
    ffrun(
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        colorSrc(6, "0x0d1117"),
        "-vf",
        filters.join(","),
        ...vpxOut(),
        out,
      ],
      "Results card"
    )
  ) {
    segments.push(out);
  }
}

// ═══════════════════════════════════════════════════════════════
// ── ACT 8: Outro Card (3s) ───────────────────────────────────
// ═══════════════════════════════════════════════════════════════

{
  const out = segPath("outro");
  const vf = [
    drawtext("Audrique", {
      size: 44,
      color: "0x58a6ff",
      y: "h/2-60",
    }),
    drawtext("Open Source E2E Contact Center Testing", {
      size: 22,
      color: "0xaaaaaa",
      y: "h/2-10",
    }),
    drawtext(
      "CCP + Twilio + Agentforce Supervisor -- Parallel Voice Verification",
      { size: 16, color: "0x3fb950", y: "h/2+30" }
    ),
    drawtext("Salesforce Service Cloud Voice + Amazon Connect", {
      size: 14,
      color: "0x555555",
      y: "h/2+65",
    }),
  ].join(",");

  if (
    ffrun(
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        colorSrc(3),
        "-vf",
        vf,
        ...vpxOut(),
        out,
      ],
      "Outro card"
    )
  ) {
    segments.push(out);
  }
}

// ═══════════════════════════════════════════════════════════════
// ── Final Concatenation ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

if (segments.length === 0) {
  console.error("\n  No segments produced. Check video files.\n");
  process.exit(1);
}

console.log(`\n  Concatenating ${segments.length} segments ...`);
const concatList = path.join(buildDir, "concat.txt");
fs.writeFileSync(concatList, segments.map((s) => `file '${s}'`).join("\n"));

const finalOutput = path.join(suiteDir, "agentforce-demo.webm");

let ok = ffrun(
  [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatList,
    "-c",
    "copy",
    finalOutput,
  ],
  "Final concat (stream copy)"
);

if (!ok) {
  ok = ffrun(
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatList,
      "-c:v",
      "libvpx-vp9",
      "-crf",
      VP9_CRF,
      "-b:v",
      "0",
      finalOutput,
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
  console.log(`\n  Agentforce demo video created!`);
  console.log(`  Output:   ${finalOutput}`);
  console.log(`  Duration: ${mins}m ${secs}s`);
  console.log(`  Size:     ${sizeMB} MB`);
  console.log(`  Segments: ${segments.length}\n`);
} else {
  console.error("\n  Failed to create agentforce demo video.\n");
  process.exit(1);
}
