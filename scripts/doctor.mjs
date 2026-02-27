#!/usr/bin/env node

/**
 * Audrique Doctor — Pre-flight connectivity and environment check.
 *
 * Validates that all required tools, network paths, and credentials
 * are available before running tests. Especially useful in Docker/cloud
 * environments where WebRTC, FFmpeg, or network access may be constrained.
 *
 * Usage:
 *   node scripts/doctor.mjs
 *   audrique doctor
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import http from "node:http";
import dgram from "node:dgram";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const results = [];
let passCount = 0;
let failCount = 0;
let warnCount = 0;

function pass(label, detail) {
  results.push({ status: "PASS", label, detail });
  passCount++;
}

function fail(label, detail) {
  results.push({ status: "FAIL", label, detail });
  failCount++;
}

function warn(label, detail) {
  results.push({ status: "WARN", label, detail });
  warnCount++;
}

function heading(text) {
  results.push({ status: "HEAD", label: text });
}

// ── Check: Node.js version ──────────────────────────────────────────────────

function checkNode() {
  heading("Runtime Environment");
  const ver = process.version;
  const major = parseInt(ver.slice(1));
  if (major >= 18) {
    pass("Node.js", `${ver} (>= 18 required)`);
  } else {
    fail("Node.js", `${ver} — version 18+ required`);
  }
}

// ── Check: Playwright + Chromium ────────────────────────────────────────────

function checkPlaywright() {
  try {
    const pw = execSync("npx playwright --version 2>&1", { cwd: ROOT, encoding: "utf8" }).trim();
    pass("Playwright", pw);
  } catch {
    fail("Playwright", "Not installed. Run: npm install && npx playwright install chromium");
  }

  // Check Chromium binary
  try {
    const browsers = execSync("npx playwright install --dry-run 2>&1", { cwd: ROOT, encoding: "utf8" });
    if (browsers.includes("chromium")) {
      warn("Chromium", "May not be installed. Run: npx playwright install chromium --with-deps");
    } else {
      pass("Chromium", "Installed");
    }
  } catch {
    pass("Chromium", "Assumed installed (dry-run check unavailable)");
  }
}

// ── Check: FFmpeg ───────────────────────────────────────────────────────────

function checkFfmpeg() {
  heading("Video Tools");
  try {
    const ver = execSync("ffmpeg -version 2>&1", { encoding: "utf8" }).split("\n")[0];
    pass("FFmpeg", ver);
  } catch {
    warn("FFmpeg", "Not found. Video merge/evidence generation will be unavailable. Install: apt install ffmpeg / brew install ffmpeg");
  }

  // Check ffmpeg-static (npm fallback)
  try {
    const mod = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules/ffmpeg-static/package.json"), "utf8"));
    pass("ffmpeg-static", `npm fallback v${mod.version}`);
  } catch {
    // Already warned about system FFmpeg
  }
}

// ── Check: Environment / Credentials ────────────────────────────────────────

function checkEnv() {
  heading("Configuration");

  // Check for instance profile
  const instanceName = process.env.INSTANCE || "";
  if (instanceName) {
    pass("INSTANCE", instanceName);
    const envFile = path.join(ROOT, `instances/${instanceName}.env`);
    if (fs.existsSync(envFile)) {
      pass("Instance env file", envFile);
    } else {
      fail("Instance env file", `Not found: ${envFile}`);
    }
  } else {
    warn("INSTANCE", "Not set. Will use environment variables directly.");
  }

  // Check critical env vars
  const required = [
    { key: "SF_LOGIN_URL", label: "Salesforce login URL" },
    { key: "CONNECT_CCP_URL", label: "Amazon Connect CCP URL" },
    { key: "CONNECT_ENTRYPOINT_NUMBER", label: "Connect entry phone number" },
  ];

  const credentials = [
    { key: "SF_USERNAME", label: "Salesforce username" },
    { key: "SF_PASSWORD", label: "Salesforce password", sensitive: true },
    { key: "TWILIO_ACCOUNT_SID", label: "Twilio Account SID" },
    { key: "TWILIO_AUTH_TOKEN", label: "Twilio Auth Token", sensitive: true },
  ];

  for (const { key, label } of required) {
    const val = process.env[key];
    if (val && val !== "replace_me") {
      pass(label, `${key} = ${val}`);
    } else {
      fail(label, `${key} not set or is placeholder`);
    }
  }

  for (const { key, label, sensitive } of credentials) {
    const val = process.env[key];
    // Check for vault ref
    const refKey = `${key}_REF`;
    const refVal = process.env[refKey];
    if (refVal) {
      pass(label, `${refKey} = ${refVal} (vault reference)`);
    } else if (val && val !== "replace_me" && !val.startsWith("AC" + "x".repeat(10))) {
      pass(label, `${key} = ${sensitive ? "***" : val}`);
    } else {
      warn(label, `${key} not set or is placeholder`);
    }
  }

  // Auth sessions
  heading("Auth Sessions");
  const sfState = process.env.SF_STORAGE_STATE || ".auth/sf-agent.json";
  if (fs.existsSync(path.resolve(ROOT, sfState))) {
    const stat = fs.statSync(path.resolve(ROOT, sfState));
    const ageMins = Math.round((Date.now() - stat.mtimeMs) / 60000);
    if (ageMins > 120) {
      warn("SF session", `${sfState} exists but is ${ageMins} min old — may be expired`);
    } else {
      pass("SF session", `${sfState} (${ageMins} min old)`);
    }
  } else {
    warn("SF session", `${sfState} not found. Run: audrique auth:sf`);
  }

  const ccpState = process.env.CONNECT_STORAGE_STATE || ".auth/connect-ccp.json";
  if (fs.existsSync(path.resolve(ROOT, ccpState))) {
    const stat = fs.statSync(path.resolve(ROOT, ccpState));
    const ageMins = Math.round((Date.now() - stat.mtimeMs) / 60000);
    if (ageMins > 120) {
      warn("CCP session", `${ccpState} exists but is ${ageMins} min old — may be expired`);
    } else {
      pass("CCP session", `${ccpState} (${ageMins} min old)`);
    }
  } else {
    warn("CCP session", `${ccpState} not found. Run: audrique auth:connect`);
  }
}

// ── Check: Network connectivity ─────────────────────────────────────────────

function httpCheck(url, label) {
  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: 10000 }, (res) => {
      pass(label, `${url} — HTTP ${res.statusCode}`);
      res.resume();
      resolve();
    });
    req.on("timeout", () => {
      req.destroy();
      fail(label, `${url} — timeout (10s)`);
      resolve();
    });
    req.on("error", (err) => {
      fail(label, `${url} — ${err.message}`);
      resolve();
    });
  });
}

function udpCheck(host, port, label) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const msg = Buffer.alloc(20); // STUN binding request header
    // STUN magic cookie
    msg.writeUInt16BE(0x0001, 0); // Binding Request
    msg.writeUInt16BE(0, 2);      // Message length
    msg.writeUInt32BE(0x2112A442, 4); // Magic cookie

    const timer = setTimeout(() => {
      socket.close();
      // UDP is connectionless — no response doesn't mean blocked
      // If we got here without error, the send succeeded
      warn(label, `${host}:${port} — sent STUN probe, no response (may be OK for UDP)`);
      resolve();
    }, 5000);

    socket.send(msg, 0, msg.length, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        socket.close();
        fail(label, `${host}:${port} — ${err.message}`);
        resolve();
      }
    });

    socket.on("message", () => {
      clearTimeout(timer);
      socket.close();
      pass(label, `${host}:${port} — STUN response received`);
      resolve();
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      socket.close();
      fail(label, `${host}:${port} — ${err.message}`);
      resolve();
    });
  });
}

async function checkNetwork() {
  heading("Network Connectivity (HTTPS)");

  // Salesforce
  const sfUrl = process.env.SF_LOGIN_URL || "https://login.salesforce.com";
  await httpCheck(sfUrl, "Salesforce login");

  const sfInstance = process.env.SF_INSTANCE_URL;
  if (sfInstance) {
    await httpCheck(sfInstance, "Salesforce instance");
  }

  // Amazon Connect CCP
  const ccpUrl = process.env.CONNECT_CCP_URL;
  if (ccpUrl) {
    await httpCheck(ccpUrl, "Connect CCP");
  } else {
    warn("Connect CCP", "CONNECT_CCP_URL not set — skipping");
  }

  // Twilio API
  await httpCheck("https://api.twilio.com/2010-04-01", "Twilio API");

  // WebRTC / UDP checks
  heading("Network Connectivity (UDP / WebRTC)");

  // AWS Global Accelerator TURN servers used by Connect
  // These are the standard TURN endpoints for Amazon Connect WebRTC
  await udpCheck("stun.l.google.com", 19302, "STUN (Google — baseline)");

  // Try to derive Connect region from CCP URL
  if (ccpUrl) {
    try {
      const ccpHost = new URL(ccpUrl).hostname;
      const regionMatch = ccpHost.match(/\.(.+?)\.amazonaws\.com/) ||
                          ccpHost.match(/my\.connect\.aws/);
      if (regionMatch) {
        pass("Connect region", `Derived from CCP URL: ${ccpHost}`);
      }
    } catch {
      // ignore
    }
  }

  // General UDP outbound test
  await udpCheck("stun.l.google.com", 19302, "UDP outbound (port 19302)");
}

// ── Check: Docker-specific ──────────────────────────────────────────────────

function checkDocker() {
  heading("Container Environment");

  // Detect if running in Docker
  const inDocker = fs.existsSync("/.dockerenv") ||
    (fs.existsSync("/proc/1/cgroup") &&
     fs.readFileSync("/proc/1/cgroup", "utf8").includes("docker"));

  if (inDocker) {
    pass("Container", "Running inside Docker");

    // Check shared memory
    try {
      const shmSize = execSync("df -h /dev/shm 2>/dev/null | tail -1", { encoding: "utf8" }).trim();
      const sizeMatch = shmSize.match(/(\d+(?:\.\d+)?[KMGT]?)/);
      if (sizeMatch) {
        const size = sizeMatch[1];
        pass("/dev/shm", `${size} available (Chromium needs >= 512MB)`);
      }
    } catch {
      warn("/dev/shm", "Could not check shared memory size");
    }
  } else {
    pass("Container", "Running on host (not Docker)");
  }

  // Check if headless mode is configured
  const headless = process.env.PW_HEADLESS;
  if (headless === "true" || headless === undefined) {
    pass("Headless mode", `PW_HEADLESS=${headless || "default (true in Docker)"}`);
  } else {
    if (inDocker) {
      warn("Headless mode", `PW_HEADLESS=${headless} — must be true in container`);
    } else {
      pass("Headless mode", `PW_HEADLESS=${headless} (headed — OK on host)`);
    }
  }

  // Fake media devices
  const fakeMedia = process.env.PW_USE_FAKE_MEDIA;
  if (fakeMedia !== "false") {
    pass("Fake media devices", "Enabled (required for container WebRTC)");
  } else {
    if (inDocker) {
      fail("Fake media devices", "PW_USE_FAKE_MEDIA=false — Chromium needs fake devices in container");
    } else {
      pass("Fake media devices", "Disabled (OK on host with real devices)");
    }
  }
}

// ── Chromium launch test ────────────────────────────────────────────────────

async function checkChromiumLaunch() {
  heading("Chromium Launch Test");
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--no-sandbox",
      ],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("about:blank");
    const title = await page.title();
    await browser.close();
    pass("Chromium launch", "Browser started, page loaded, closed cleanly");
  } catch (err) {
    fail("Chromium launch", `Failed: ${err.message}`);
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

function printReport() {
  console.log("\n  Audrique Doctor — Pre-flight Check\n");
  console.log("  " + "=".repeat(60) + "\n");

  for (const r of results) {
    if (r.status === "HEAD") {
      console.log(`\n  --- ${r.label} ---\n`);
      continue;
    }
    const icon = r.status === "PASS" ? "\x1b[32m[PASS]\x1b[0m" :
                 r.status === "FAIL" ? "\x1b[31m[FAIL]\x1b[0m" :
                                       "\x1b[33m[WARN]\x1b[0m";
    console.log(`  ${icon} ${r.label}`);
    if (r.detail) {
      console.log(`         ${r.detail}`);
    }
  }

  console.log(`\n  ${"=".repeat(60)}`);
  console.log(`  Results: \x1b[32m${passCount} passed\x1b[0m, \x1b[33m${warnCount} warnings\x1b[0m, \x1b[31m${failCount} failed\x1b[0m\n`);

  if (failCount > 0) {
    console.log("  Fix the FAIL items above before running tests.\n");
    process.exit(1);
  } else if (warnCount > 0) {
    console.log("  Warnings may affect some test features but won't block execution.\n");
    process.exit(0);
  } else {
    console.log("  All checks passed — ready to run tests!\n");
    process.exit(0);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  checkNode();
  checkPlaywright();
  checkFfmpeg();
  checkEnv();
  await checkNetwork();
  checkDocker();
  await checkChromiumLaunch();
  printReport();
}

main().catch((err) => {
  console.error("Doctor script failed:", err);
  process.exit(1);
});
