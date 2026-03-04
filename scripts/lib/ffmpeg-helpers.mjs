/**
 * ffmpeg-helpers.mjs — Shared FFmpeg utilities for video scripts.
 *
 * Extracted from build-demo-video.mjs, merge-e2e-highlight.mjs, etc.
 * Import into new scripts instead of duplicating.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// ── FFmpeg binary resolution ──────────────────────────────────────────────

let _ffmpegStatic = null;
try {
  const mod = await import("ffmpeg-static");
  _ffmpegStatic = mod.default ?? mod;
} catch { /* optional dependency */ }

export function resolveFFmpeg() {
  // Prefer ffmpeg-static — it includes drawtext, freetype, and other filters
  // that system ffmpeg (e.g. homebrew) may lack.
  if (_ffmpegStatic && fs.existsSync(_ffmpegStatic)) return _ffmpegStatic;
  const sys = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"];
  for (const p of sys) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── System font resolution ────────────────────────────────────────────────

const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
];
export const FONT = FONT_CANDIDATES.find((p) => fs.existsSync(p)) ?? "";

// ── Text helpers ──────────────────────────────────────────────────────────

export function escText(str) {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\u2019");
}

export function drawtext(text, opts = {}) {
  const {
    size = 24,
    color = "white",
    x = "(w-text_w)/2",
    y = "(h-text_h)/2",
    font = FONT,
  } = opts;
  const parts = [];
  if (font) parts.push(`fontfile=${font}`);
  parts.push(`text='${escText(text)}'`);
  parts.push(`fontsize=${size}`);
  parts.push(`fontcolor=${color}`);
  parts.push(`x=${x}`);
  parts.push(`y=${y}`);
  return "drawtext=" + parts.join(":");
}

// ── FFmpeg execution ──────────────────────────────────────────────────────

export function ffrun(ffmpegPath, args, label) {
  console.log(`  [ffmpeg] ${label} ...`);
  const r = spawnSync(ffmpegPath, args, {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 600_000,
  });
  if (r.status !== 0) {
    console.error(`  FAILED: ${label}`);
    if (r.stderr) console.error(r.stderr.slice(-600));
    return false;
  }
  return true;
}

// ── Source generators ─────────────────────────────────────────────────────

export function colorSrc(duration, color = "0x0d1117", w = 1280, h = 720, fps = 24) {
  return `color=c=${color}:s=${w}x${h}:d=${duration}:r=${fps}`;
}

// ── Duration probing ──────────────────────────────────────────────────────

export function getDuration(videoPath, ffmpegPath) {
  const r = spawnSync("ffprobe", [
    "-v", "quiet", "-print_format", "json", "-show_format", videoPath,
  ], { encoding: "utf8", timeout: 10_000, stdio: "pipe" });
  if (r.status === 0) {
    try { return parseFloat(JSON.parse(r.stdout).format.duration); } catch { /* ignore */ }
  }
  if (ffmpegPath) {
    const r2 = spawnSync(ffmpegPath, ["-i", videoPath], {
      encoding: "utf8", stdio: "pipe", timeout: 10_000,
    });
    const m = r2.stderr?.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 100;
  }
  return 30;
}

// ── Timeline helpers ──────────────────────────────────────────────────────

export function readTimeline(sc) {
  const tp = sc.artifacts?.[0]?.timeline;
  if (!tp || !fs.existsSync(tp)) return null;
  try {
    return JSON.parse(fs.readFileSync(tp, "utf8"));
  } catch {
    return null;
  }
}

export function timelineToVideoSec(tl) {
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
    testEnd: s(tl.testEndMs),
  };
}

// ── Video segment builder ─────────────────────────────────────────────────

export function buildVideoSegment(ffmpegPath, {
  input, output, label,
  startSec = 0, durationSec = 0, speed = 1,
  bannerText = "", bannerColor = "0xd29922", bannerPosition = "bottom",
  scaleFilter = null, w = 1280, h = 720, fps = 24,
  codecArgs = null,
}) {
  const ssArgs = startSec > 0 ? ["-ss", startSec.toFixed(3)] : [];
  const tArgs = durationSec > 0 ? ["-t", durationSec.toFixed(3)] : [];

  const filters = [
    scaleFilter ?? `scale=${w}:${h}`,
    `fps=${fps}`,
    "format=yuv420p",
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
      y: isTop ? "10" : "h-26",
    }));
  }

  const codec = codecArgs ?? ["-c:v", "libvpx-vp9", "-crf", "34", "-b:v", "0", "-pix_fmt", "yuv420p"];

  return ffrun(ffmpegPath,
    ["-y", ...ssArgs, ...tArgs, "-i", input, "-vf", filters.join(","), ...codec, output],
    label,
  );
}

// ── Title card builder ────────────────────────────────────────────────────

export function buildTitleCard(ffmpegPath, {
  output, lines, duration = 5,
  bgColor = "0x161b22",
  w = 1280, h = 720, fps = 24,
  codecArgs = null,
}) {
  const filters = lines.map((line) =>
    drawtext(line.text, {
      size: line.size ?? 24,
      color: line.color ?? "white",
      x: line.x ?? "(w-text_w)/2",
      y: String(line.y),
    })
  );

  const codec = codecArgs ?? ["-c:v", "libvpx-vp9", "-crf", "34", "-b:v", "0", "-pix_fmt", "yuv420p"];

  return ffrun(ffmpegPath,
    ["-y", "-f", "lavfi", "-i", colorSrc(duration, bgColor, w, h, fps),
     "-vf", filters.join(","), ...codec, output],
    `Title card: ${lines[0]?.text?.slice(0, 40) ?? ""}`,
  );
}

// ── Title card with logo overlay ──────────────────────────────────────

export function buildCardWithLogo(ffmpegPath, {
  output, lines, duration = 5,
  bgColor = "0x0f1117",
  w = 1920, h = 1080, fps = 30,
  logoPath, logoSize = 200, logoY = 160,
  codecArgs = null,
}) {
  if (!logoPath || !fs.existsSync(logoPath)) {
    return buildTitleCard(ffmpegPath, { output, lines, duration, bgColor, w, h, fps, codecArgs });
  }

  const textFilters = lines.map((line) =>
    drawtext(line.text, {
      size: line.size ?? 24,
      color: line.color ?? "white",
      x: line.x ?? "(w-text_w)/2",
      y: String(line.y),
    })
  );

  const filterComplex = [
    `[1:v]scale=${logoSize}:${logoSize}[logo]`,
    `[0:v][logo]overlay=(main_w-${logoSize})/2:${logoY}[base]`,
    `[base]${textFilters.join(",")}`,
  ].join(";");

  const codec = codecArgs ?? ["-c:v", "libx264", "-crf", "18", "-preset", "slow", "-pix_fmt", "yuv420p"];

  return ffrun(ffmpegPath,
    ["-y",
     "-f", "lavfi", "-i", colorSrc(duration, bgColor, w, h, fps),
     "-i", logoPath,
     "-filter_complex", filterComplex,
     ...codec, output],
    `Title card with logo: ${lines[0]?.text?.slice(0, 40) ?? ""}`,
  );
}

// ── Supervisor video finder ───────────────────────────────────────────────

export function findSupervisorVideo(sc) {
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

// ── Supervisor In-Progress Work video finder ─────────────────────────────

export function findSupervisorInProgressVideo(sc) {
  const artDir = sc.artifacts?.[0]?.dir;
  if (!artDir) return null;
  const attDir = path.join(artDir, "attachments");
  if (!fs.existsSync(attDir)) return null;
  const files = fs.readdirSync(attDir)
    .filter((n) => /^salesforce-supervisor-in-progress-video-.*\.webm$/i.test(n))
    .map((n) => path.join(attDir, n))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ?? null;
}

// ── Assertion list builder ────────────────────────────────────────────────

export function buildAssertions(sc) {
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
