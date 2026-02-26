#!/usr/bin/env node
/**
 * Audrique Scenario Studio — Express server
 *
 * Serves the interactive scenario builder UI and provides API routes
 * for reading profiles, suites, and saving generated scenarios.
 *
 * Usage:
 *   node webapp/server.mjs
 *   node webapp/server.mjs --port 4200
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
const PORT = portFlag >= 0 ? parseInt(args[portFlag + 1], 10) : 4200;

// ── Helpers ─────────────────────────────────────────────────────────────────

function readJsonFile(filePath) {
  const resolved = path.resolve(PROJECT_ROOT, filePath);
  if (!fs.existsSync(resolved)) return null;
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function writeJsonFile(filePath, data) {
  const resolved = path.resolve(PROJECT_ROOT, filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(data, null, 2) + "\n");
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath, contentType) {
  const resolved = path.resolve(__dirname, filePath);
  if (!fs.existsSync(resolved)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(resolved).pipe(res);
}

// ── MIME types ───────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ── API Routes ──────────────────────────────────────────────────────────────

async function handleApi(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return true;
  }

  // GET /api/profiles — list all customer profiles
  if (pathname === "/api/profiles" && req.method === "GET") {
    const profiles = readJsonFile("instances/profiles.json");
    sendJson(res, 200, profiles || { profiles: [] });
    return true;
  }

  // GET /api/suites — list available suite files
  if (pathname === "/api/suites" && req.method === "GET") {
    const suiteDir = path.resolve(PROJECT_ROOT, "scenarios/e2e");
    const files = fs.existsSync(suiteDir)
      ? fs.readdirSync(suiteDir).filter((f) => f.endsWith(".json"))
      : [];
    const suites = files.map((f) => {
      const data = readJsonFile(`scenarios/e2e/${f}`);
      return {
        file: `scenarios/e2e/${f}`,
        name: data?.name || f,
        version: data?.version || 1,
        scenarioCount: data?.scenarios?.length || 0,
      };
    });
    sendJson(res, 200, { suites });
    return true;
  }

  // GET /api/suite?file=scenarios/e2e/full-suite-v2.json — load a suite
  if (pathname === "/api/suite" && req.method === "GET") {
    const file = url.searchParams.get("file");
    if (!file) {
      sendJson(res, 400, { error: "Missing ?file= parameter" });
      return true;
    }
    const data = readJsonFile(file);
    if (!data) {
      sendJson(res, 404, { error: `Suite not found: ${file}` });
      return true;
    }
    sendJson(res, 200, data);
    return true;
  }

  // POST /api/scenario — save a scenario to a suite
  if (pathname === "/api/scenario" && req.method === "POST") {
    const body = await parseBody(req);
    const { scenario, suiteFile } = body;
    if (!scenario || !suiteFile) {
      sendJson(res, 400, { error: "Missing scenario or suiteFile" });
      return true;
    }

    const resolved = path.resolve(PROJECT_ROOT, suiteFile);
    let suite;
    if (fs.existsSync(resolved)) {
      suite = JSON.parse(fs.readFileSync(resolved, "utf8"));
      const existing = suite.scenarios.findIndex((s) => s.id === scenario.id);
      if (existing >= 0) {
        suite.scenarios[existing] = scenario;
      } else {
        suite.scenarios.push(scenario);
      }
    } else {
      suite = {
        name: "Custom Test Suite",
        version: 2,
        stopOnFailure: false,
        defaults: {
          callTrigger: { mode: "connect_ccp" },
          timeouts: {
            ringSec: 90,
            supervisorQueueSec: 90,
            supervisorAgentOfferSec: 90,
            offerAfterQueueSec: 120,
          },
        },
        scenarios: [scenario],
      };
    }

    writeJsonFile(suiteFile, suite);
    sendJson(res, 200, {
      message: `Scenario "${scenario.id}" saved to ${suiteFile}`,
      scenarioCount: suite.scenarios.length,
    });
    return true;
  }

  // DELETE /api/scenario — remove a scenario from a suite
  if (pathname === "/api/scenario" && req.method === "DELETE") {
    const body = await parseBody(req);
    const { scenarioId, suiteFile } = body;
    if (!scenarioId || !suiteFile) {
      sendJson(res, 400, { error: "Missing scenarioId or suiteFile" });
      return true;
    }
    const data = readJsonFile(suiteFile);
    if (!data) {
      sendJson(res, 404, { error: `Suite not found: ${suiteFile}` });
      return true;
    }
    data.scenarios = data.scenarios.filter((s) => s.id !== scenarioId);
    writeJsonFile(suiteFile, data);
    sendJson(res, 200, {
      message: `Scenario "${scenarioId}" removed`,
      scenarioCount: data.scenarios.length,
    });
    return true;
  }

  // GET /api/profiles — list all customer profiles
  if (pathname === "/api/profiles" && req.method === "GET") {
    const profilesPath = path.resolve(PROJECT_ROOT, "instances/profiles.json");
    if (fs.existsSync(profilesPath)) {
      const data = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
      sendJson(res, 200, data);
    } else {
      sendJson(res, 200, { defaultInstance: "personal", profiles: [] });
    }
    return true;
  }

  // GET /api/vocabulary — get cached org vocabulary for a profile
  if (pathname === "/api/vocabulary" && req.method === "GET") {
    const params = new URLSearchParams(req.url.split("?")[1] || "");
    const profileId = params.get("profile") || "personal";
    const cachePath = path.resolve(
      PROJECT_ROOT,
      `.cache/org-vocabulary-${profileId}.json`
    );
    if (fs.existsSync(cachePath)) {
      const data = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      sendJson(res, 200, { cached: true, vocabulary: data });
    } else {
      sendJson(res, 200, { cached: false, vocabulary: null });
    }
    return true;
  }

  // GET /api/env-preview — dry-run: show env vars for a scenario
  if (pathname === "/api/env-preview" && req.method === "POST") {
    const body = await parseBody(req);
    const { scenario, defaults } = body;
    if (!scenario) {
      sendJson(res, 400, { error: "Missing scenario" });
      return true;
    }
    // Dynamically import the bridge
    const bridge = await import(
      path.resolve(PROJECT_ROOT, "scripts/scenario-bridge.mjs")
    );
    const env = bridge.scenarioToEnv(scenario, defaults || {});
    sendJson(res, 200, { env });
    return true;
  }

  // ── Run management ──────────────────────────────────────────────────────

  // POST /api/run — start a suite run, returns run ID
  if (pathname === "/api/run" && req.method === "POST") {
    const body = await parseBody(req);
    const suiteFile = body.suiteFile || "scenarios/e2e/full-suite-v2.json";
    const dryRun = body.dryRun === true;
    const instance = body.instance || process.env.INSTANCE || "";

    if (activeRun) {
      sendJson(res, 409, { error: "A run is already in progress", runId: activeRun.id });
      return true;
    }

    const runId = `run-${Date.now()}`;
    const env = {
      ...process.env,
      E2E_SUITE_FILE: suiteFile,
      FORCE_COLOR: "0",
    };
    if (dryRun) env.E2E_SUITE_DRY_RUN = "true";
    if (instance) env.INSTANCE = instance;

    const child = spawn("node", [path.join(PROJECT_ROOT, "scripts/run-instance-e2e-suite.mjs")], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    activeRun = {
      id: runId,
      suiteFile,
      dryRun,
      startedAt: new Date().toISOString(),
      status: "running",
      child,
      listeners: new Set(),
      lines: [],
    };

    const broadcast = (data) => {
      const msg = `data: ${JSON.stringify(data)}\n\n`;
      activeRun.lines.push(data);
      for (const listener of activeRun.listeners) {
        try { listener.write(msg); } catch (_) { /* client gone */ }
      }
    };

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        // Parse scenario status from suite runner output
        const scenarioMatch = line.match(/^(?:Running|PASS|FAIL|SKIP)\b/);
        broadcast({
          type: scenarioMatch ? "scenario" : "log",
          text: line,
          ts: Date.now(),
        });
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        broadcast({ type: "error", text: line, ts: Date.now() });
      }
    });

    child.on("close", (code) => {
      const status = code === 0 ? "passed" : "failed";
      broadcast({ type: "done", code, status, ts: Date.now() });
      if (activeRun) {
        activeRun.status = status;
        activeRun.exitCode = code;
        // Clean up listeners after a delay
        setTimeout(() => {
          if (activeRun?.id === runId) {
            for (const listener of activeRun.listeners) {
              try { listener.end(); } catch (_) {}
            }
            activeRun = null;
          }
        }, 5000);
      }
    });

    sendJson(res, 200, { runId, suiteFile, dryRun, status: "running" });
    return true;
  }

  // GET /api/run/stream — SSE stream of live output
  if (pathname === "/api/run/stream" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    if (!activeRun) {
      res.write(`data: ${JSON.stringify({ type: "error", text: "No active run" })}\n\n`);
      res.end();
      return true;
    }

    // Send buffered lines first (for late-joining clients)
    for (const line of activeRun.lines) {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
    }

    activeRun.listeners.add(res);
    req.on("close", () => {
      activeRun?.listeners.delete(res);
    });

    return true;
  }

  // POST /api/run/stop — stop the active run
  if (pathname === "/api/run/stop" && req.method === "POST") {
    if (!activeRun) {
      sendJson(res, 404, { error: "No active run" });
      return true;
    }
    activeRun.child.kill("SIGTERM");
    sendJson(res, 200, { message: "Run stopped", runId: activeRun.id });
    return true;
  }

  // GET /api/run/status — check current run status
  if (pathname === "/api/run/status" && req.method === "GET") {
    if (!activeRun) {
      sendJson(res, 200, { running: false });
      return true;
    }
    sendJson(res, 200, {
      running: activeRun.status === "running",
      runId: activeRun.id,
      suiteFile: activeRun.suiteFile,
      dryRun: activeRun.dryRun,
      status: activeRun.status,
      startedAt: activeRun.startedAt,
      lineCount: activeRun.lines.length,
    });
    return true;
  }

  return false;
}

// ── Active run state ────────────────────────────────────────────────────────
let activeRun = null;

// ── HTTP Server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    // API routes
    if (req.url.startsWith("/api/")) {
      const handled = await handleApi(req, res);
      if (handled) return;
      sendJson(res, 404, { error: "Unknown API endpoint" });
      return;
    }

    // Static files
    let filePath = req.url === "/" ? "/index.html" : req.url;
    // Strip query strings
    filePath = filePath.split("?")[0];
    const ext = path.extname(filePath);
    const contentType = MIME[ext] || "application/octet-stream";
    sendFile(res, `public${filePath}`, contentType);
  } catch (err) {
    console.error("Server error:", err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log("");
  console.log("  ┌──────────────────────────────────────────────┐");
  console.log("  │                                              │");
  console.log("  │   Audrique Scenario Studio                   │");
  console.log(`  │   http://localhost:${PORT}                      │`);
  console.log("  │                                              │");
  console.log("  │   Press Ctrl+C to stop                       │");
  console.log("  │                                              │");
  console.log("  └──────────────────────────────────────────────┘");
  console.log("");
});
