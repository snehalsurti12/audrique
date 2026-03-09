#!/usr/bin/env node
/**
 * merge-nlm-demo.mjs
 *
 * Merges a NotebookLM cinematic overview video with the existing
 * build-agentforce-demo.mjs output into a single combined video.
 *
 * Pipeline:
 *   1. NotebookLM video — trimmed (12s-90s), watermark removed
 *   2. Transition slide — "Live Test Recording" bridge card (4s)
 *   3. Existing demo video — the agentforce-demo.webm from build-agentforce-demo.mjs
 *
 * Usage:
 *   node scripts/merge-nlm-demo.mjs [nlm-video-path] [demo-video-path]
 *
 *   Defaults:
 *     nlm-video:  ~/Downloads/Agentforce_Call_Test.mp4
 *     demo-video: latest agentforce-demo.webm in test-results/
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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

function resolveFFprobe() {
  const sys = ["/usr/bin/ffprobe", "/usr/local/bin/ffprobe"];
  for (const p of sys) {
    if (fs.existsSync(p)) return p;
  }
  // Try alongside ffmpeg-static
  if (ffmpegStatic) {
    const dir = path.dirname(ffmpegStatic);
    const probe = path.join(dir, "ffprobe");
    if (fs.existsSync(probe)) return probe;
  }
  return "ffprobe"; // hope it's on PATH
}

const ffmpeg = resolveFFmpeg();
const ffprobe = resolveFFprobe();

if (!ffmpeg) {
  console.error("ffmpeg not found. Install ffmpeg or ffmpeg-static.");
  process.exit(1);
}

// ── Constants ────────────────────────────────────────────────
const W = 1280;
const H = 720;
const FPS = 24;

// ── Watermark removal coordinates ───────────────────────────
// NotebookLM watermark: bottom-right, "🔊 NotebookLM"
// Verified position in 1280x720: x=1080, y=650, 200x70px
const WM_X = 1080;
const WM_Y = 650;
const WM_W = 200;
const WM_H = 70;

// ── Trim boundaries ────────────────────────────────────────
const TRIM_START = 12;
const TRIM_END = 90;

// ── Helpers ─────────────────────────────────────────────────
function run(cmd, args, label) {
  console.log(`  → ${label}`);
  const r = spawnSync(cmd, args, { stdio: "pipe", timeout: 300_000 });
  if (r.status !== 0) {
    console.error(`  ✗ ${label} failed (exit ${r.status})`);
    if (r.stderr) console.error(r.stderr.toString().slice(-500));
    process.exit(1);
  }
  return r;
}

function getVideoDuration(filePath) {
  const r = spawnSync(ffprobe, [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    filePath,
  ], { stdio: "pipe" });
  if (r.status !== 0) return null;
  try {
    const info = JSON.parse(r.stdout.toString());
    return parseFloat(info.format.duration);
  } catch {
    return null;
  }
}

/** Generate a solid-color card with centered text lines */
function makeCard(outPath, durationSec, lines, opts = {}) {
  const bgColor = opts.bgColor || "0x0d1117";
  const filters = [];

  // Base color source
  filters.push(`color=c=${bgColor}:s=${W}x${H}:d=${durationSec}:r=${FPS}`);

  // Add text lines
  let drawFilters = "";
  for (const line of lines) {
    const escaped = line.text.replace(/'/g, "'\\''").replace(/:/g, "\\:");
    const color = line.color || "white";
    const size = line.size || 48;
    const yExpr = line.y || `(h-text_h)/2`;
    drawFilters += `,drawtext=text='${escaped}':fontcolor=${color}:fontsize=${size}:x=(w-text_w)/2:y=${yExpr}`;
  }

  const filterComplex = filters[0] + drawFilters + `,format=yuv420p[v]`;

  const args = [
    "-y",
    "-f", "lavfi",
    "-i", `anullsrc=r=44100:cl=stereo`,
    "-filter_complex", filterComplex,
    "-map", "[v]",
    "-map", "0:a",
    "-c:v", "libx264", "-preset", "fast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k",
    "-t", String(durationSec),
    "-shortest",
    outPath,
  ];

  run(ffmpeg, args, `Card: ${lines[0]?.text?.slice(0, 40)}...`);
}

// ── Main ────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);

  // Resolve NLM video
  const nlmDefault = path.join(os.homedir(), "Downloads", "Agentforce_Call_Test.mp4");
  const nlmPath = args[0] || nlmDefault;
  if (!fs.existsSync(nlmPath)) {
    console.error(`NotebookLM video not found: ${nlmPath}`);
    process.exit(1);
  }

  // Resolve demo video
  let demoPath = args[1];
  if (!demoPath) {
    // Find latest agentforce-demo.webm
    const resultsDir = path.resolve("test-results/e2e-suite");
    if (fs.existsSync(resultsDir)) {
      const dirs = fs.readdirSync(resultsDir)
        .filter(d => d.includes("parallel-agentforce"))
        .sort()
        .reverse();
      for (const d of dirs) {
        const candidate = path.join(resultsDir, d, "agentforce-demo.webm");
        if (fs.existsSync(candidate)) {
          demoPath = candidate;
          break;
        }
      }
    }
  }
  if (!demoPath || !fs.existsSync(demoPath)) {
    console.error("Demo video not found. Run build-agentforce-demo.mjs first, or pass path as 2nd arg.");
    process.exit(1);
  }

  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║   Merge NotebookLM Overview + Demo Video     ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
  console.log(`  NLM video:  ${nlmPath}`);
  console.log(`  Demo video: ${demoPath}\n`);

  const nlmDur = getVideoDuration(nlmPath);
  const demoDur = getVideoDuration(demoPath);
  console.log(`  NLM duration:  ${nlmDur?.toFixed(1)}s (trimming ${TRIM_START}s–${TRIM_END}s = ${TRIM_END - TRIM_START}s)`);
  console.log(`  Demo duration: ${demoDur?.toFixed(1)}s\n`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlm-merge-"));
  const outputDir = path.dirname(demoPath);
  const outputPath = path.join(outputDir, "agentforce-full-demo.mp4");

  // ── Step 0: Branded intro card ──────────────────────────
  console.log("Step 0: Create branded intro card\n");

  const introCard = path.join(tmpDir, "intro.mp4");
  makeCard(introCard, 5, [
    { text: "Audrique", color: "0x58a6ff", size: 72, y: "(h/2)-100" },
    { text: "──────────────────────", color: "0x30363d", size: 24, y: "(h/2)-25" },
    { text: "Testing Agentic Voice AI", color: "white", size: 40, y: "(h/2)+20" },
    { text: "Parallel Agentforce Call Verification", color: "0x8b949e", size: 24, y: "(h/2)+80" },
  ]);

  // ── Step 1: Process NLM video ──────────────────────────
  console.log("\nStep 1: Process NotebookLM video (trim + remove watermark)\n");

  const nlmProcessed = path.join(tmpDir, "nlm-processed.mp4");

  // Trim 12s-90s and remove watermark using delogo filter
  // Also add a subtle blur fallback in case delogo leaves artifacts:
  // we use a box blur on the watermark region
  run(ffmpeg, [
    "-y",
    "-ss", String(TRIM_START),
    "-to", String(TRIM_END),
    "-i", nlmPath,
    "-filter_complex", [
      // Split video for overlay approach
      `[0:v]split[base][wm]`,
      // Create blurred version of watermark region
      `[wm]crop=${WM_W}:${WM_H}:${WM_X}:${WM_Y},avgblur=sizeX=20:sizeY=20[blurred]`,
      // Overlay blurred region back onto base
      `[base][blurred]overlay=${WM_X}:${WM_Y},format=yuv420p[v]`,
    ].join(";"),
    "-map", "[v]",
    "-map", "0:a?",
    "-c:v", "libx264", "-preset", "fast", "-crf", "22",
    "-c:a", "aac", "-b:a", "128k",
    "-r", String(FPS),
    nlmProcessed,
  ], "Trim + remove watermark");

  // ── Step 2: Create transition slide ────────────────────
  console.log("\nStep 2: Create transition slide\n");

  const transitionCard = path.join(tmpDir, "transition.mp4");
  makeCard(transitionCard, 4, [
    { text: "Live Test Recording", color: "0x58a6ff", size: 56, y: "(h/2)-60" },
    { text: "──────────────────", color: "0x30363d", size: 28, y: "(h/2)+5" },
    { text: "Automated parallel call test captured by Audrique", color: "0x8b949e", size: 26, y: "(h/2)+50" },
  ]);

  // ── Step 3: Normalize demo video to H264/MP4 ──────────
  console.log("\nStep 3: Normalize demo video to H264/MP4\n");

  const demoNormalized = path.join(tmpDir, "demo-normalized.mp4");

  // The existing demo is VP9/WebM with no audio — add silent audio track
  run(ffmpeg, [
    "-y",
    "-i", demoPath,
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-c:v", "libx264", "-preset", "fast", "-crf", "22",
    "-c:a", "aac", "-b:a", "128k",
    "-r", String(FPS),
    "-shortest",
    "-pix_fmt", "yuv420p",
    demoNormalized,
  ], "Normalize demo VP9→H264");

  // ── Step 4: Concatenate all segments ───────────────────
  console.log("\nStep 4: Concatenate segments\n");

  const concatList = path.join(tmpDir, "concat.txt");
  fs.writeFileSync(concatList, [
    `file '${introCard}'`,
    `file '${nlmProcessed}'`,
    `file '${transitionCard}'`,
    `file '${demoNormalized}'`,
  ].join("\n"));

  run(ffmpeg, [
    "-y",
    "-f", "concat", "-safe", "0",
    "-i", concatList,
    "-c:v", "libx264", "-preset", "medium", "-crf", "22",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    "-pix_fmt", "yuv420p",
    outputPath,
  ], "Concatenate: Intro → NLM → Transition → Demo");

  // ── Summary ────────────────────────────────────────────
  const finalDur = getVideoDuration(outputPath);
  const stats = fs.statSync(outputPath);
  const sizeMB = (stats.size / 1e6).toFixed(1);

  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║   Done!                                      ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
  console.log(`\n  Output:   ${outputPath}`);
  console.log(`  Duration: ${finalDur?.toFixed(1)}s`);
  console.log(`  Size:     ${sizeMB} MB`);
  console.log(`\n  Segments:`);
  console.log(`    1. Branded intro:       5s`);
  console.log(`    2. NotebookLM overview: ${TRIM_END - TRIM_START}s (${TRIM_START}s–${TRIM_END}s, watermark removed)`);
  console.log(`    3. Transition card:     4s`);
  console.log(`    4. Demo recording:      ${demoDur?.toFixed(1)}s\n`);

  // Cleanup tmp
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main();
