import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const testResultsRoot = path.resolve(
  process.cwd(),
  process.env.TEST_RESULTS_ROOT?.trim() || "test-results"
);
const salesforceLeadInSec = Number(process.env.MERGE_SF_LEADIN_SEC ?? 1.5);

if (!fs.existsSync(testResultsRoot)) {
  console.log("No test-results directory found; nothing to merge.");
  process.exit(0);
}

if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
  console.error("ffmpeg binary not found (ffmpeg-static).");
  process.exit(1);
}

const resultDirs = fs
  .readdirSync(testResultsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(testResultsRoot, entry.name));

let mergedCount = 0;
for (const dir of resultDirs) {
  const salesforceVideo = path.join(dir, "video.webm");
  if (!fs.existsSync(salesforceVideo)) {
    continue;
  }

  const attachmentsDir = path.join(dir, "attachments");
  if (!fs.existsSync(attachmentsDir)) {
    continue;
  }

  const ccpVideos = fs
    .readdirSync(attachmentsDir)
    .filter((name) => /^connect-ccp-dial-video-.*\.webm$/i.test(name))
    .map((name) => path.join(attachmentsDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (ccpVideos.length === 0) {
    continue;
  }

  const ccpVideo = ccpVideos[0];
  const supervisorVideos = fs
    .readdirSync(attachmentsDir)
    .filter((name) => /^salesforce-supervisor-video-.*\.webm$/i.test(name))
    .map((name) => path.join(attachmentsDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const supervisorVideo = supervisorVideos[0];
  const output = path.join(dir, "merged-e2e.webm");
  const timelineMeta = readTimelineMeta(dir, attachmentsDir);
  const salesforceTrimSec = resolveSalesforceTrimSeconds(timelineMeta?.timeline);
  const preflightSec = resolveSalesforcePreflightSeconds(timelineMeta?.timeline);
  const supervisorSegment = resolveSupervisorSegmentSeconds(timelineMeta?.timeline);
  const supervisorSec = supervisorSegment.durationSec;
  const supervisorStartSec = supervisorSegment.startSec;
  const selectedMode =
    preflightSec > 1.5 && salesforceTrimSec > 0 && supervisorVideo
      ? "story-supervisor"
      : preflightSec > 1.5 && salesforceTrimSec > 0
        ? "story"
        : "legacy";
  console.log(
    JSON.stringify({
      event: "merge-mode-decision",
      dir,
      selectedMode,
      hasSalesforceVideo: fs.existsSync(salesforceVideo),
      hasCcpVideo: Boolean(ccpVideo),
      hasSupervisorVideo: Boolean(supervisorVideo),
      hasTimeline: Boolean(timelineMeta),
      preflightSec,
      salesforceTrimSec,
      supervisorSec,
      supervisorStartSec,
      timelineKeys: timelineMeta?.timeline ? Object.keys(timelineMeta.timeline) : []
    })
  );

  const ffmpegArgs =
    preflightSec > 1.5 && salesforceTrimSec > 0 && supervisorVideo
      ? buildStoryWithSupervisorConcatArgs({
          salesforceVideo,
          ccpVideo,
          supervisorVideo,
          output,
          preflightSec,
          supervisorStartSec,
          supervisorSec,
          salesforceTrimSec
        })
      : preflightSec > 1.5 && salesforceTrimSec > 0
      ? buildStoryConcatArgs({
          salesforceVideo,
          ccpVideo,
          output,
          preflightSec,
          salesforceTrimSec
        })
      : buildLegacyConcatArgs({
          salesforceVideo,
          ccpVideo,
          output,
          salesforceTrimSec
        });

  const run = spawnSync(ffmpegPath, ffmpegArgs, {
    stdio: "pipe",
    encoding: "utf8"
  });

  if (run.status !== 0) {
    console.error(`Failed merging videos in ${dir}`);
    if (run.stderr) {
      console.error(run.stderr.slice(-1200));
    }
    continue;
  }

  mergedCount += 1;
  console.log(
    JSON.stringify(
      {
        merged: true,
        dir,
        ccpVideo,
        supervisorVideo: supervisorVideo ?? null,
        mergeMode:
          preflightSec > 1.5 && salesforceTrimSec > 0 && supervisorVideo
            ? "story-supervisor"
            : preflightSec > 1.5 && salesforceTrimSec > 0
              ? "story"
              : "legacy",
        preflightSec,
        supervisorSec,
        salesforceTrimSec,
        timelinePath: timelineMeta?.path ?? null,
        salesforceVideo,
        output
      },
      null,
      2
    )
  );
}

if (mergedCount === 0) {
  console.log("No merge candidates found (expected Salesforce video + CCP attachment video).");
}

function readTimelineMeta(dir, attachmentsDir) {
  const directPath = path.join(dir, "e2e-timeline.json");
  if (fs.existsSync(directPath)) {
    const timeline = parseJsonFile(directPath);
    if (timeline) {
      return { path: directPath, timeline };
    }
  }

  const attachmentCandidates = fs
    .readdirSync(attachmentsDir)
    .filter((name) => /^e2e-timeline-.*\.json$/i.test(name))
    .map((name) => path.join(attachmentsDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const candidate of attachmentCandidates) {
    const timeline = parseJsonFile(candidate);
    if (timeline) {
      return { path: candidate, timeline };
    }
  }
  return null;
}

function parseJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function resolveSalesforceTrimSeconds(timeline) {
  if (!timeline || typeof timeline !== "object") {
    return 0;
  }

  const testStartMs = Number(timeline.testStartMs ?? 0);
  if (!Number.isFinite(testStartMs) || testStartMs <= 0) {
    return 0;
  }

  const triggerMs = Number(
    timeline.callTriggerStartMs ?? timeline.ccpDialConfirmedMs ?? timeline.preflightReadyMs ?? 0
  );
  if (!Number.isFinite(triggerMs) || triggerMs <= testStartMs) {
    return 0;
  }

  return Math.max(0, (triggerMs - testStartMs) / 1000 - salesforceLeadInSec);
}

function resolveSalesforcePreflightSeconds(timeline) {
  if (!timeline || typeof timeline !== "object") {
    return 0;
  }

  const testStartMs = Number(timeline.testStartMs ?? 0);
  const triggerMs = Number(
    timeline.callTriggerStartMs ?? timeline.ccpDialConfirmedMs ?? timeline.preflightReadyMs ?? 0
  );
  if (!Number.isFinite(testStartMs) || !Number.isFinite(triggerMs) || triggerMs <= testStartMs) {
    return 0;
  }

  // Include the preflight window plus a short lead-out so transition is understandable.
  return Math.max(0, (triggerMs - testStartMs) / 1000 + 0.8);
}

function resolveSupervisorSegmentSeconds(timeline) {
  if (!timeline || typeof timeline !== "object") {
    return { startSec: 0, durationSec: 10 };
  }

  const startedMs = Number(timeline.supervisorObserverStartedMs ?? 0);
  const observedMs = Number(timeline.supervisorQueueObservedMs ?? 0);
  if (!Number.isFinite(startedMs) || !Number.isFinite(observedMs) || observedMs <= startedMs) {
    return { startSec: 0, durationSec: 10 };
  }

  const observedAtSec = (observedMs - startedMs) / 1000;
  // Show 8 seconds before observation (baseline state) through 5 seconds after (observed state).
  const segStart = Math.max(0, observedAtSec - 8);
  const segEnd = observedAtSec + 5;
  return { startSec: segStart, durationSec: Math.max(6, segEnd - segStart) };
}

function buildLegacyConcatArgs(input) {
  return [
    "-y",
    "-i",
    input.ccpVideo,
    ...(input.salesforceTrimSec > 0 ? ["-ss", input.salesforceTrimSec.toFixed(3)] : []),
    "-i",
    input.salesforceVideo,
    "-filter_complex",
    "[0:v:0]scale=1280:720,fps=24,format=yuv420p[v0];[1:v:0]scale=1280:720,fps=24,format=yuv420p[v1];[v0][v1]concat=n=2:v=1:a=0[v]",
    "-map",
    "[v]",
    "-c:v",
    "libvpx-vp9",
    "-crf",
    "34",
    "-b:v",
    "0",
    input.output
  ];
}

function buildStoryConcatArgs(input) {
  return [
    "-y",
    "-t",
    input.preflightSec.toFixed(3),
    "-i",
    input.salesforceVideo,
    "-i",
    input.ccpVideo,
    "-ss",
    input.salesforceTrimSec.toFixed(3),
    "-i",
    input.salesforceVideo,
    "-filter_complex",
    "[0:v:0]scale=1280:720,fps=24,format=yuv420p[v0];[1:v:0]scale=1280:720,fps=24,format=yuv420p[v1];[2:v:0]scale=1280:720,fps=24,format=yuv420p[v2];[v0][v1][v2]concat=n=3:v=1:a=0[v]",
    "-map",
    "[v]",
    "-c:v",
    "libvpx-vp9",
    "-crf",
    "34",
    "-b:v",
    "0",
    input.output
  ];
}

function buildStoryWithSupervisorConcatArgs(input) {
  return [
    "-y",
    "-t",
    input.preflightSec.toFixed(3),
    "-i",
    input.salesforceVideo,
    "-i",
    input.ccpVideo,
    "-ss",
    (input.supervisorStartSec ?? 0).toFixed(3),
    "-t",
    input.supervisorSec.toFixed(3),
    "-i",
    input.supervisorVideo,
    "-ss",
    input.salesforceTrimSec.toFixed(3),
    "-i",
    input.salesforceVideo,
    "-filter_complex",
    "[0:v:0]scale=1280:720,fps=24,format=yuv420p[v0];[1:v:0]scale=1280:720,fps=24,format=yuv420p[v1];[2:v:0]scale=1280:720,fps=24,format=yuv420p[v2];[3:v:0]scale=1280:720,fps=24,format=yuv420p[v3];[v0][v1][v2][v3]concat=n=4:v=1:a=0[v]",
    "-map",
    "[v]",
    "-c:v",
    "libvpx-vp9",
    "-crf",
    "34",
    "-b:v",
    "0",
    input.output
  ];
}
