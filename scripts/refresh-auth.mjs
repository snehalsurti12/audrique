#!/usr/bin/env node

/**
 * Audrique Auth Refresh — Checks session freshness and re-captures if expired.
 *
 * Designed for Docker/CI where no human is available. Uses Vault or env
 * credentials to programmatically log into Salesforce and Connect CCP,
 * producing fresh .auth/ session files.
 *
 * Usage:
 *   node scripts/refresh-auth.mjs              # Refresh both SF and Connect
 *   node scripts/refresh-auth.mjs --sf-only    # Refresh Salesforce only
 *   node scripts/refresh-auth.mjs --connect-only  # Refresh Connect only
 *   node scripts/refresh-auth.mjs --force      # Force refresh even if sessions look fresh
 *
 * Environment:
 *   AUTH_MAX_AGE_MIN=120     Max session age in minutes before refresh (default: 120)
 *   AUTH_FORCE_REFRESH=true  Force refresh regardless of age
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(process.cwd());
const DEFAULT_MAX_AGE_MIN = 120;

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    sfOnly: args.includes("--sf-only"),
    connectOnly: args.includes("--connect-only"),
    force: args.includes("--force") || /^(true|1|yes|on)$/i.test((process.env.AUTH_FORCE_REFRESH ?? "").trim())
  };
}

function getSessionAge(filePath) {
  const resolved = path.resolve(ROOT, filePath);
  if (!fs.existsSync(resolved)) {
    return { exists: false, ageMin: Infinity, path: resolved };
  }
  const stat = fs.statSync(resolved);
  const ageMin = Math.round((Date.now() - stat.mtimeMs) / 60000);
  return { exists: true, ageMin, path: resolved };
}

function needsRefresh(session, maxAgeMin, force) {
  if (force) return true;
  if (!session.exists) return true;
  if (session.ageMin > maxAgeMin) return true;
  return false;
}

function runScript(scriptName, env) {
  return new Promise((resolve) => {
    // Route through run-instance.mjs so Vault secrets are resolved before
    // the target auth script executes. This is critical in Docker/CI where
    // credentials live in Vault, not in process.env directly.
    const runInstancePath = path.join(ROOT, "scripts/run-instance.mjs");
    console.log(`[refresh-auth] Running: node scripts/run-instance.mjs ${scriptName}`);
    const child = spawn("node", [runInstancePath, scriptName], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: "inherit"
    });
    child.on("error", (err) => {
      console.error(`[refresh-auth] Failed to start ${scriptName}: ${err.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const { sfOnly, connectOnly, force } = parseArgs();
  const maxAgeMin = parseInt(process.env.AUTH_MAX_AGE_MIN || String(DEFAULT_MAX_AGE_MIN), 10);
  const doSf = !connectOnly;
  const doConnect = !sfOnly;

  console.log("[refresh-auth] Session freshness check");
  console.log(`[refresh-auth] Max age: ${maxAgeMin} min | Force: ${force}`);

  const sfStatePath = process.env.SF_STORAGE_STATE || ".auth/sf-personal.json";
  const connectStatePath = process.env.CONNECT_STORAGE_STATE || ".auth/connect-ccp-personal.json";

  const sfSession = getSessionAge(sfStatePath);
  const connectSession = getSessionAge(connectStatePath);

  if (doSf) {
    console.log(`[refresh-auth] SF session: ${sfSession.exists ? `${sfSession.ageMin} min old` : "missing"} (${sfStatePath})`);
  }
  if (doConnect) {
    console.log(`[refresh-auth] Connect session: ${connectSession.exists ? `${connectSession.ageMin} min old` : "missing"} (${connectStatePath})`);
  }

  let sfOk = true;
  let connectOk = true;

  // Refresh Salesforce
  if (doSf && needsRefresh(sfSession, maxAgeMin, force)) {
    const reason = !sfSession.exists ? "missing" : force ? "forced" : `expired (${sfSession.ageMin} min)`;
    console.log(`\n[refresh-auth] Refreshing SF session (${reason})...`);

    const sfCode = await runScript("auth:state", {});
    if (sfCode === 0) {
      console.log("[refresh-auth] SF session captured successfully.");
    } else {
      console.error(`[refresh-auth] SF auth failed with exit code ${sfCode}.`);
      sfOk = false;
    }
  } else if (doSf) {
    console.log(`[refresh-auth] SF session is fresh (${sfSession.ageMin} min old). Skipping.`);
  }

  // Refresh Connect
  if (doConnect && needsRefresh(connectSession, maxAgeMin, force)) {
    const reason = !connectSession.exists ? "missing" : force ? "forced" : `expired (${connectSession.ageMin} min)`;
    console.log(`\n[refresh-auth] Refreshing Connect session (${reason})...`);

    const connectCode = await runScript("auth:connect-state", {
      CONNECT_AUTO_NAVIGATE_FROM_CONSOLE: "true"
    });
    if (connectCode === 0) {
      console.log("[refresh-auth] Connect session captured successfully.");
    } else {
      console.error(`[refresh-auth] Connect auth failed with exit code ${connectCode}.`);
      connectOk = false;
    }
  } else if (doConnect) {
    console.log(`[refresh-auth] Connect session is fresh (${connectSession.ageMin} min old). Skipping.`);
  }

  // Summary
  console.log("\n[refresh-auth] Summary:");
  if (doSf) console.log(`  SF:      ${sfOk ? "OK" : "FAILED"}`);
  if (doConnect) console.log(`  Connect: ${connectOk ? "OK" : "FAILED"}`);

  if (!sfOk || !connectOk) {
    console.error("\n[refresh-auth] One or more auth captures failed.");
    process.exit(1);
  }

  console.log("[refresh-auth] All sessions are fresh. Ready to run tests.");
}

main().catch((err) => {
  console.error("[refresh-auth] Fatal:", err.message);
  process.exit(1);
});
