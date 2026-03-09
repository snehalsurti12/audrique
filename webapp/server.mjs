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
import { initPool, isAvailable as dbAvailable, shutdown as dbShutdown } from "./db/client.mjs";
import { runMigrations } from "./db/migrate.mjs";
import { createRun, listRuns, getRun, deleteRun } from "./db/queries/runs.mjs";
import { getScenarioResult } from "./db/queries/scenarios.mjs";
import { getPassRateTrend, getFlakyScenarios, getScenarioHistory } from "./db/queries/trends.mjs";
import { ingestSuiteSummary } from "./db/queries/ingest.mjs";
import {
  isValidUUID, sanitizePagination, sanitizeDays, sanitizeString,
  checkRateLimit, setSecurityHeaders, logAudit,
} from "./db/security.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
const PORT = portFlag >= 0 ? parseInt(args[portFlag + 1], 10) : 4200;

// ── Bundled OAuth Connected App ──────────────────────────────────────────────
// Resolved at startup from env vars or Vault. Never stored on disk.
let BUNDLED_OAUTH_CONSUMER_KEY = process.env.AUDRIQUE_OAUTH_CONSUMER_KEY || "";
let BUNDLED_OAUTH_CONSUMER_SECRET = process.env.AUDRIQUE_OAUTH_CONSUMER_SECRET || "";

async function resolveOAuthKeysFromVault() {
  if (BUNDLED_OAUTH_CONSUMER_KEY && BUNDLED_OAUTH_CONSUMER_SECRET) return;
  const addr = (process.env.VAULT_ADDR || "").trim();
  const token = (process.env.VAULT_TOKEN || "").trim();
  if (!addr || !token) return;
  try {
    const resp = await fetch(`${addr.replace(/\/+$/, "")}/v1/secret/data/voice/audrique/oauth`, {
      headers: { "X-Vault-Token": token },
    });
    if (!resp.ok) return;
    const payload = await resp.json();
    const data = payload?.data?.data ?? payload?.data ?? {};
    if (data.consumer_key) BUNDLED_OAUTH_CONSUMER_KEY = data.consumer_key;
    if (data.consumer_secret) BUNDLED_OAUTH_CONSUMER_SECRET = data.consumer_secret;
    console.log("[server] OAuth keys resolved from Vault.");
  } catch {
    // Vault not available — keys stay empty until configured
  }
}

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

function getDefaultSystemSettings() {
  return {
    callHandling: {
      VOICE_RING_TIMEOUT_SEC: 180,
      VOICE_POST_ACCEPT_HOLD_SEC: 6,
      PREFLIGHT_DETAIL_HOLD_SEC: 2,
      PROVIDER_LOGIN_TIMEOUT_SEC: 60,
      PROVIDER_SYNC_WAIT_SEC: 20,
      CONNECT_DIAL_TIMEOUT_SEC: 20,
    },
    ccpConnection: {
      CCP_READY_TIMEOUT_SEC: 45,
      CCP_AGENT_AVAILABLE_TIMEOUT_SEC: 20,
      CCP_CONNECTED_READY_TIMEOUT_SEC: 15,
      CCP_CALL_ELAPSED_TIMEOUT_SEC: 30,
      IVR_AUDIO_READY_TIMEOUT_SEC: 15,
    },
    sfNavigation: {
      SF_LOGIN_ASSERTION_TIMEOUT_SEC: 20,
      SF_APP_DETECT_TIMEOUT_SEC: 5,
      SF_APP_SWITCH_TIMEOUT_SEC: 7,
    },
    supervisor: {
      SUPERVISOR_QUEUE_WAIT_TIMEOUT_SEC: 180,
      OFFER_AFTER_QUEUE_TIMEOUT_SEC: 180,
      OBSERVER_FINALIZE_WAIT_SEC: 5,
      SUPERVISOR_POST_QUEUE_HOLD_SEC: 2,
      SUPERVISOR_BEFORE_ACCEPT_WAIT_MS: 7000,
      SUPERVISOR_POLL_INTERVAL_MS: 1200,
      SUPERVISOR_NAVIGATION_INTERVAL_MS: 6000,
      SUPERVISOR_AGENT_POLL_INTERVAL_MS: 1200,
      SUPERVISOR_AGENT_NAVIGATION_INTERVAL_MS: 6000,
      SUPERVISOR_FALLBACK_SURFACES: "Omni Supervisor,Command Center for Service",
      SUPERVISOR_DEFAULT_SEARCH_TERM: "Supervisor",
    },
    incomingDetection: {
      INCOMING_CRITICAL_WINDOW_SEC: 25,
      INCOMING_FAST_POLL_MS: 250,
      INCOMING_NORMAL_POLL_MS: 1000,
      OMNI_STRONG_REFOCUS_MS: 3000,
      SUPERVISOR_PRE_ACCEPT_POLL_MS: 250,
    },
    behaviorFlags: {
      SUPERVISOR_CHECK_BEFORE_ACCEPT: true,
      SUPERVISOR_REQUIRE_PRE_ACCEPT_OBSERVATION: true,
      ALLOW_DELTA_SIGNALS_IN_SUPERVISOR: true,
      SUPERVISOR_ALLOW_IN_PROGRESS_FALLBACK: false,
      SUPERVISOR_SKIP_QUEUE_BACKLOG: false,
      SUPERVISOR_REQUIRE_TABLE_SOURCE: true,
      SUPERVISOR_REQUIRE_TOTAL_WAITING_HEADER: true,
    },
    transcript: {
      TRANSCRIPT_WAIT_SEC: 60,
      TRANSCRIPT_MIN_GROWTH_CHARS: 12,
      PREFLIGHT_PANEL_HOLD_MS: 800,
    },
    playwright: {
      PW_VIDEO_MODE: "retain-on-failure",
      PW_HEADLESS: true,
      PW_USE_FAKE_MEDIA: true,
    },
    database: {
      DATABASE_URL: "",
    },
  };
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

// ── .env file helpers ────────────────────────────────────────────────────────

const SENSITIVE_PATTERNS = [/PASSWORD/i, /TOKEN/i, /SECRET/i, /API_KEY/i, /PRIVATE_KEY/i, /AUTH_TOKEN/i];
const SENSITIVE_KEYS = new Set([
  "SF_PASSWORD", "SF_EMAIL_CODE", "AWS_PASSWORD",
  "TWILIO_AUTH_TOKEN", "VAULT_TOKEN", "SF_OAUTH_CONSUMER_SECRET",
  "GEMINI_API_KEY",
]);

const NON_SENSITIVE_KEYS = new Set(["SECRETS_BACKEND", "REGULATED_MODE"]);

function isSensitiveKey(key) {
  if (NON_SENSITIVE_KEYS.has(key)) return false;
  if (SENSITIVE_KEYS.has(key)) return true;
  if (key.endsWith("_REF")) return false; // Vault refs are not sensitive
  return SENSITIVE_PATTERNS.some((p) => p.test(key));
}

function parseEnvFile(filePath) {
  const resolved = path.resolve(PROJECT_ROOT, filePath);
  if (!fs.existsSync(resolved)) return null;
  const content = fs.readFileSync(resolved, "utf8");
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    env[key] = val;
  }
  return env;
}

// ── Vault Auth (gitignored, stores tokens per profile) ─────────────────────
const VAULT_AUTH_PATH = path.resolve(PROJECT_ROOT, "instances", ".vault-auth.json");

function readVaultAuth() {
  if (!fs.existsSync(VAULT_AUTH_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(VAULT_AUTH_PATH, "utf8")); } catch { return {}; }
}

function writeVaultAuth(data) {
  fs.mkdirSync(path.dirname(VAULT_AUTH_PATH), { recursive: true });
  fs.writeFileSync(VAULT_AUTH_PATH, JSON.stringify(data, null, 2));
}

function getVaultToken(profileId) {
  const auth = readVaultAuth();
  return auth[profileId]?.token || "";
}

function setVaultToken(profileId, token) {
  const auth = readVaultAuth();
  if (!auth[profileId]) auth[profileId] = {};
  auth[profileId].token = token;
  writeVaultAuth(auth);
}

// ── Vault Secret Groups (matches vault-seed.sh conventions) ────────────────
const VAULT_SECRET_GROUPS = {
  salesforce: {
    subpath: "salesforce",
    fields: {
      sfUsername: "username",
      sfPassword: "password",
      oauthConsumerKey: "consumer_key",
      oauthConsumerSecret: "consumer_secret",
    },
  },
  aws: {
    subpath: "aws",
    fields: {
      awsUsername: "username",
      awsPassword: "password",
      awsAccountId: "account_id",
      awsAccessKeyId: "access_key_id",
      awsSecretAccessKey: "secret_access_key",
      connectInstanceId: "connect_instance_id",
    },
  },
  twilio: {
    subpath: "twilio",
    fields: {
      twilioSid: "account_sid",
      twilioToken: "auth_token",
    },
  },
  gemini: {
    subpath: "gemini",
    fields: {
      geminiApiKey: "api_key",
    },
  },
};

/**
 * Build _REF values from a Vault base path using grouped subpaths.
 * e.g. basePath="secret/data/voice/personal"
 *   → { oauthConsumerKeyRef: "secret/data/voice/personal/salesforce#consumer_key", ... }
 */
function buildVaultRefsFromBasePath(basePath) {
  const refs = {};
  const base = basePath.replace(/\/+$/, "");
  for (const group of Object.values(VAULT_SECRET_GROUPS)) {
    for (const [credKey, vaultField] of Object.entries(group.fields)) {
      refs[credKey + "Ref"] = `${base}/${group.subpath}#${vaultField}`;
    }
  }
  return refs;
}

/**
 * Write secrets to Vault KV v2 engine in grouped subpaths.
 * Reads existing values first to merge (won't overwrite untouched fields).
 */
async function writeSecretsToVault(vaultAddr, vaultToken, basePath, credentials) {
  const written = [];
  const errors = [];
  const addr = vaultAddr.replace(/\/+$/, "");
  const base = basePath.replace(/\/+$/, "");

  for (const group of Object.values(VAULT_SECRET_GROUPS)) {
    // Collect non-empty, non-masked values for this group
    const data = {};
    for (const [credKey, vaultField] of Object.entries(group.fields)) {
      const value = credentials[credKey];
      if (value && !value.startsWith("\u2022")) {
        data[vaultField] = value;
      }
    }

    if (Object.keys(data).length === 0) continue;

    const secretPath = `${base}/${group.subpath}`.replace(/^\/+/, "");
    const url = `${addr}/v1/${secretPath}`;

    try {
      // Read existing secrets to merge
      let existingData = {};
      try {
        const readResp = await fetch(url, {
          method: "GET",
          headers: { "X-Vault-Token": vaultToken },
          signal: AbortSignal.timeout(10000),
        });
        if (readResp.ok) {
          const payload = await readResp.json();
          existingData = payload?.data?.data ?? payload?.data ?? {};
        }
      } catch {
        // Path doesn't exist yet — fine
      }

      const merged = { ...existingData, ...data };

      const writeResp = await fetch(url, {
        method: "PUT",
        headers: { "X-Vault-Token": vaultToken, "Content-Type": "application/json" },
        body: JSON.stringify({ data: merged }),
        signal: AbortSignal.timeout(10000),
      });

      if (!writeResp.ok) {
        const text = await writeResp.text().catch(() => "");
        errors.push(`${group.subpath}: HTTP ${writeResp.status} - ${text.slice(0, 200)}`);
      } else {
        written.push(group.subpath);
      }
    } catch (err) {
      errors.push(`${group.subpath}: ${err.message}`);
    }
  }

  return { success: errors.length === 0, written, errors };
}

/**
 * Read secrets from Vault for a profile's base path. Returns masked values.
 */
async function readSecretsFromVault(vaultAddr, vaultToken, basePath) {
  const secrets = {};
  const addr = vaultAddr.replace(/\/+$/, "");
  const base = basePath.replace(/\/+$/, "");

  for (const group of Object.values(VAULT_SECRET_GROUPS)) {
    const secretPath = `${base}/${group.subpath}`.replace(/^\/+/, "");
    const url = `${addr}/v1/${secretPath}`;
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: { "X-Vault-Token": vaultToken },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const payload = await resp.json();
        const data = payload?.data?.data ?? payload?.data ?? {};
        for (const [credKey, vaultField] of Object.entries(group.fields)) {
          if (data[vaultField]) {
            secrets[credKey] = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
          }
        }
      }
    } catch {
      // Group not found — skip
    }
  }

  return secrets;
}

function maskSensitiveValues(envMap) {
  const masked = { ...envMap };
  for (const key of Object.keys(masked)) {
    if (isSensitiveKey(key) && masked[key]) {
      masked[key] = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
    }
  }
  return masked;
}

function generateEnvContent(profile, creds) {
  const backend = creds?.secretsBackend || "env";
  const isVault = backend === "vault";
  const lines = [
    `# Audrique Connection: ${profile.label}`,
    `# Generated by Scenario Studio`,
    ``,
    `# Security / secrets`,
    `SECRETS_BACKEND=${backend}`,
    `REGULATED_MODE=${isVault ? "true" : "false"}`,
  ];

  if (isVault) {
    lines.push(`VAULT_ADDR=${creds.vaultAddr || ""}`);
    // VAULT_TOKEN is stored in profiles.json vault section, NOT in .env
    // (plaintext token in .env triggers REGULATED_MODE violation)
  }

  const sfAuthMethod = creds?.sfAuthMethod || "password";
  lines.push(
    ``,
    `# Salesforce`,
    `SF_LOGIN_URL=${profile.salesforce?.loginUrl || "https://login.salesforce.com"}`,
    `SF_AUTH_METHOD=${sfAuthMethod}`,
  );

  if (sfAuthMethod === "oauth") {
    if (isVault) {
      lines.push(`SF_OAUTH_CONSUMER_KEY=`);
      lines.push(`SF_OAUTH_CONSUMER_KEY_REF=${creds?.oauthConsumerKeyRef || ""}`);
      lines.push(`SF_OAUTH_CONSUMER_SECRET=`);
      lines.push(`SF_OAUTH_CONSUMER_SECRET_REF=${creds?.oauthConsumerSecretRef || ""}`);
    } else {
      lines.push(`SF_OAUTH_CONSUMER_KEY=${creds?.sfOauthConsumerKey || ""}`);
      lines.push(`SF_OAUTH_CONSUMER_SECRET=${creds?.sfOauthConsumerSecret || ""}`);
    }
    lines.push(`SF_OAUTH_CALLBACK_URL=${creds?.sfOauthCallbackUrl || "http://localhost:4200/oauth/callback"}`);
  } else if (isVault) {
    lines.push(`SF_USERNAME_REF=${creds?.sfUsernameRef || ""}`);
    lines.push(`SF_PASSWORD_REF=${creds?.sfPasswordRef || ""}`);
  } else {
    lines.push(`SF_USERNAME=${creds?.sfUsername || ""}`);
    lines.push(`SF_PASSWORD=${creds?.sfPassword || ""}`);
  }

  lines.push(
    `SF_APP_NAME=${profile.salesforce?.appName || "Service Console"}`,
    `SF_INSTANCE_URL=${creds?.sfInstanceUrl || ""}`,
    `SF_STORAGE_STATE=.auth/sf-${profile.id}.json`,
    `SF_SKIP_LOGIN=true`,
    ``,
    `# Voice test behavior`,
    `CALL_TRIGGER_MODE=connect_ccp`,
    `OMNI_TARGET_STATUS=Available`,
    `VOICE_RING_TIMEOUT_SEC=180`,
    ``,
    `# Amazon Connect`,
    `CONNECT_INSTANCE_ALIAS=${profile.connect?.instanceAlias || ""}`,
  );

  if (isVault) {
    lines.push(`AWS_USERNAME=`);
    lines.push(`AWS_USERNAME_REF=${creds?.awsUsernameRef || ""}`);
    lines.push(`AWS_PASSWORD=`);
    lines.push(`AWS_PASSWORD_REF=${creds?.awsPasswordRef || ""}`);
    lines.push(`AWS_ACCOUNT_ID=`);
    lines.push(`AWS_ACCOUNT_ID_REF=${creds?.awsAccountIdRef || ""}`);
    lines.push(`# Connect Federation API (headless auth, no browser sign-in)`);
    lines.push(`AWS_ACCESS_KEY_ID=`);
    lines.push(`AWS_ACCESS_KEY_ID_REF=${creds?.awsAccessKeyIdRef || ""}`);
    lines.push(`AWS_SECRET_ACCESS_KEY=`);
    lines.push(`AWS_SECRET_ACCESS_KEY_REF=${creds?.awsSecretAccessKeyRef || ""}`);
    lines.push(`CONNECT_INSTANCE_ID=`);
    lines.push(`CONNECT_INSTANCE_ID_REF=${creds?.connectInstanceIdRef || ""}`);
  } else {
    lines.push(`AWS_USERNAME=${creds?.awsUsername || ""}`);
    lines.push(`AWS_PASSWORD=${creds?.awsPassword || ""}`);
    lines.push(`AWS_ACCOUNT_ID=${creds?.awsAccountId || ""}`);
  }

  lines.push(
    `CONNECT_CONSOLE_REGION=${profile.connect?.region || "us-west-2"}`,
    `CONNECT_STORAGE_STATE=.auth/connect-ccp-${profile.id}.json`,
    `CONNECT_AUTO_AWS_LOGIN=true`,
    ``,
    `# Twilio (optional)`,
  );

  if (isVault) {
    lines.push(`TWILIO_ACCOUNT_SID=`);
    lines.push(`TWILIO_ACCOUNT_SID_REF=${creds?.twilioSidRef || ""}`);
    lines.push(`TWILIO_AUTH_TOKEN=`);
    lines.push(`TWILIO_AUTH_TOKEN_REF=${creds?.twilioTokenRef || ""}`);
    lines.push(`TWILIO_FROM_NUMBER=${creds?.twilioFromNumber || ""}`);
    lines.push(`TWILIO_FROM_NUMBER_REF=`);
    lines.push(`CONNECT_ENTRYPOINT_NUMBER=${creds?.connectEntrypoint || ""}`);
    lines.push(`CONNECT_ENTRYPOINT_NUMBER_REF=`);
  } else {
    lines.push(`TWILIO_ACCOUNT_SID=${creds?.twilioSid || ""}`);
    lines.push(`TWILIO_AUTH_TOKEN=${creds?.twilioToken || ""}`);
    lines.push(`TWILIO_FROM_NUMBER=${creds?.twilioFromNumber || ""}`);
    lines.push(`CONNECT_ENTRYPOINT_NUMBER=${creds?.connectEntrypoint || ""}`);
  }

  // AI Providers (NL Caller — optional)
  const hasGemini = isVault ? creds?.geminiApiKeyRef : creds?.geminiApiKey;
  if (hasGemini) {
    lines.push(`# AI Providers (NL Caller)`);
    if (isVault) {
      lines.push(`GEMINI_API_KEY=`);
      lines.push(`GEMINI_API_KEY_REF=${creds?.geminiApiKeyRef || ""}`);
    } else {
      lines.push(`GEMINI_API_KEY=${creds?.geminiApiKey || ""}`);
    }
  }

  lines.push(``);

  return lines.join("\n");
}

// Backward-compatible wrapper
function generateSkeletonEnv(profile) {
  return generateEnvContent(profile, null);
}

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

  // GET /api/profiles — list all customer profiles (with auth status)
  if (pathname === "/api/profiles" && req.method === "GET") {
    const data = readJsonFile("instances/profiles.json") || { profiles: [] };
    // Annotate each profile with credential status
    for (const p of data.profiles) {
      const envMap = parseEnvFile(p.envFile);
      if (!envMap) {
        p._authStatus = "missing";
      } else {
        const backend = (envMap.SECRETS_BACKEND || "env").toLowerCase();
        const sfAuthMethod = (envMap.SF_AUTH_METHOD || "password").toLowerCase();
        p._authBackend = backend;
        p._sfAuthMethod = sfAuthMethod;
        if (sfAuthMethod === "oauth") {
          const hasConsumerKey = !!(envMap.SF_OAUTH_CONSUMER_KEY || envMap.SF_OAUTH_CONSUMER_KEY_REF);
          const oauthTokenFile = path.resolve(PROJECT_ROOT, `.auth/sf-oauth-${p.id}.json`);
          const hasOAuthTokens = fs.existsSync(oauthTokenFile);
          p._authStatus = hasConsumerKey ? (hasOAuthTokens ? "oauth-connected" : "oauth-configured") : "incomplete";
        } else if (backend === "vault") {
          const hasVault = (p.vault?.addr || envMap.VAULT_ADDR) && (getVaultToken(p.id) || envMap.VAULT_TOKEN);
          p._authStatus = (hasVault && envMap.SF_PASSWORD_REF) ? "configured" : "incomplete";
        } else {
          p._authStatus = (envMap.SF_USERNAME && envMap.SF_PASSWORD) ? "configured" : "incomplete";
        }
      }
    }
    sendJson(res, 200, data);
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
        connectionSetId: data?.connectionSetId || null,
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

  // PUT /api/scenario/reorder — reorder scenarios in a suite
  if (pathname === "/api/scenario/reorder" && req.method === "PUT") {
    const body = await parseBody(req);
    const { suiteFile, scenarioIds } = body;
    if (!suiteFile || !Array.isArray(scenarioIds)) {
      sendJson(res, 400, { error: "Missing suiteFile or scenarioIds array" });
      return true;
    }
    const data = readJsonFile(suiteFile);
    if (!data) {
      sendJson(res, 404, { error: `Suite not found: ${suiteFile}` });
      return true;
    }
    const byId = new Map(data.scenarios.map((s) => [s.id, s]));
    const reordered = scenarioIds.map((id) => byId.get(id)).filter(Boolean);
    // Append any scenarios not in the provided list (safety net)
    for (const s of data.scenarios) {
      if (!scenarioIds.includes(s.id)) reordered.push(s);
    }
    data.scenarios = reordered;
    writeJsonFile(suiteFile, data);
    sendJson(res, 200, { message: "Scenarios reordered", scenarioCount: data.scenarios.length });
    return true;
  }

  // PUT /api/scenario/toggle — toggle a scenario's enabled state
  if (pathname === "/api/scenario/toggle" && req.method === "PUT") {
    const body = await parseBody(req);
    const { suiteFile, scenarioId, enabled } = body;
    if (!suiteFile || !scenarioId || typeof enabled !== "boolean") {
      sendJson(res, 400, { error: "Missing suiteFile, scenarioId, or enabled (boolean)" });
      return true;
    }
    const data = readJsonFile(suiteFile);
    if (!data) {
      sendJson(res, 404, { error: `Suite not found: ${suiteFile}` });
      return true;
    }
    const scenario = data.scenarios.find((s) => s.id === scenarioId);
    if (!scenario) {
      sendJson(res, 404, { error: `Scenario "${scenarioId}" not found` });
      return true;
    }
    scenario.enabled = enabled;
    writeJsonFile(suiteFile, data);
    sendJson(res, 200, { message: `Scenario "${scenarioId}" ${enabled ? "enabled" : "disabled"}` });
    return true;
  }

  // POST /api/scenario/duplicate — clone a scenario with a new ID
  if (pathname === "/api/scenario/duplicate" && req.method === "POST") {
    const body = await parseBody(req);
    const { suiteFile, scenarioId, newId } = body;
    if (!suiteFile || !scenarioId || !newId) {
      sendJson(res, 400, { error: "Missing suiteFile, scenarioId, or newId" });
      return true;
    }
    const data = readJsonFile(suiteFile);
    if (!data) {
      sendJson(res, 404, { error: `Suite not found: ${suiteFile}` });
      return true;
    }
    const source = data.scenarios.find((s) => s.id === scenarioId);
    if (!source) {
      sendJson(res, 404, { error: `Scenario "${scenarioId}" not found` });
      return true;
    }
    if (data.scenarios.some((s) => s.id === newId)) {
      sendJson(res, 409, { error: `Scenario "${newId}" already exists` });
      return true;
    }
    const clone = JSON.parse(JSON.stringify(source));
    clone.id = newId;
    clone.description = (clone.description || "") + " (copy)";
    // Insert right after the source
    const idx = data.scenarios.indexOf(source);
    data.scenarios.splice(idx + 1, 0, clone);
    writeJsonFile(suiteFile, data);
    sendJson(res, 200, { message: `Duplicated "${scenarioId}" as "${newId}"`, scenarioCount: data.scenarios.length });
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

  // POST /api/discovery/run — run org discovery for a profile
  if (pathname === "/api/discovery/run" && req.method === "POST") {
    const body = await parseBody(req);
    const { profileId } = body;
    if (!profileId) {
      sendJson(res, 400, { error: "Missing profileId" });
      return true;
    }
    try {
      const { runOrgDiscovery } = await import(
        path.resolve(PROJECT_ROOT, "scripts/orgDiscoveryRunner.mjs")
      );
      const result = await runOrgDiscovery(profileId);
      sendJson(res, 200, result);
    } catch (err) {
      const msg = err?.message || String(err);
      const status = msg.includes("expired") || msg.includes("401") ? 401 : 500;
      sendJson(res, status, { error: msg });
    }
    return true;
  }

  // POST /api/discovery/save — save discovered vocabulary selections to profile
  if (pathname === "/api/discovery/save" && req.method === "POST") {
    const body = await parseBody(req);
    const { profileId, vocabulary, salesforce } = body;
    if (!profileId) {
      sendJson(res, 400, { error: "Missing profileId" });
      return true;
    }
    const profilesData = readJsonFile("instances/profiles.json");
    if (!profilesData) {
      sendJson(res, 404, { error: "No profiles found" });
      return true;
    }
    const profile = profilesData.profiles.find((p) => p.id === profileId);
    if (!profile) {
      sendJson(res, 404, { error: `Profile not found: ${profileId}` });
      return true;
    }
    // Merge vocabulary selections into profile
    if (vocabulary && typeof vocabulary === "object") {
      profile.vocabulary = { ...(profile.vocabulary || {}), ...vocabulary };
    }
    // Update salesforce app names if provided
    if (salesforce && typeof salesforce === "object") {
      profile.salesforce = { ...(profile.salesforce || {}), ...salesforce };
    }
    writeJsonFile("instances/profiles.json", profilesData);
    sendJson(res, 200, { message: "Vocabulary saved", profileId });
    return true;
  }

  // GET /api/discovery/status — check discovery cache age and session validity
  if (pathname === "/api/discovery/status" && req.method === "GET") {
    const params = new URLSearchParams(req.url.split("?")[1] || "");
    const profileId = params.get("profile") || "personal";
    const cachePath = path.resolve(
      PROJECT_ROOT,
      `.cache/org-vocabulary-${profileId}.json`
    );
    const storagePath = path.resolve(
      PROJECT_ROOT,
      `.auth/sf-${profileId}.json`
    );
    const result = {
      profileId,
      hasCachedDiscovery: fs.existsSync(cachePath),
      cacheAge: null,
      hasStoredSession: fs.existsSync(storagePath),
    };
    if (result.hasCachedDiscovery) {
      try {
        const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        const discoveredAt = cached.discoveredAt
          ? new Date(cached.discoveredAt)
          : null;
        if (discoveredAt) {
          result.cacheAge = Math.round(
            (Date.now() - discoveredAt.getTime()) / 60000
          );
        }
      } catch { /* ignore parse errors */ }
    }
    sendJson(res, 200, result);
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

  // ── Suite management ────────────────────────────────────────────────────

  // POST /api/suite — create a new suite
  if (pathname === "/api/suite" && req.method === "POST") {
    const body = await parseBody(req);
    const { name, connectionSetId } = body;
    if (!name || !name.trim()) {
      sendJson(res, 400, { error: "Suite name is required" });
      return true;
    }
    let slug = slugify(name);
    let filePath = `scenarios/e2e/${slug}.json`;
    let counter = 2;
    while (fs.existsSync(path.resolve(PROJECT_ROOT, filePath))) {
      filePath = `scenarios/e2e/${slug}-${counter}.json`;
      counter++;
    }
    const suite = {
      name: name.trim(),
      version: 2,
      ...(connectionSetId ? { connectionSetId } : {}),
      stopOnFailure: false,
      defaults: {
        callTrigger: { mode: "connect_ccp" },
        timeouts: { ringSec: 90, supervisorQueueSec: 90, supervisorAgentOfferSec: 90, offerAfterQueueSec: 120 },
      },
      scenarios: [],
    };
    writeJsonFile(filePath, suite);
    sendJson(res, 200, { file: filePath, name: suite.name });
    return true;
  }

  // PUT /api/suite — update suite metadata (rename, change connectionSetId)
  if (pathname === "/api/suite" && req.method === "PUT") {
    const body = await parseBody(req);
    const { file, name, connectionSetId, vocabulary, defaults } = body;
    if (!file) {
      sendJson(res, 400, { error: "Missing file parameter" });
      return true;
    }
    const data = readJsonFile(file);
    if (!data) {
      sendJson(res, 404, { error: `Suite not found: ${file}` });
      return true;
    }
    if (name !== undefined) data.name = name.trim();
    if (connectionSetId !== undefined) {
      if (connectionSetId) {
        data.connectionSetId = connectionSetId;
      } else {
        delete data.connectionSetId;
      }
    }
    if (vocabulary && typeof vocabulary === "object") {
      data.vocabulary = vocabulary;
    }
    if (defaults && typeof defaults === "object") {
      // Merge defaults — preserve existing timeouts if not provided
      if (!data.defaults) data.defaults = {};
      if (defaults.callTrigger) {
        data.defaults.callTrigger = { ...data.defaults.callTrigger, ...defaults.callTrigger };
      }
      if (defaults.timeouts) {
        data.defaults.timeouts = { ...data.defaults.timeouts, ...defaults.timeouts };
      }
    }
    writeJsonFile(file, data);
    sendJson(res, 200, { message: "Suite updated" });
    return true;
  }

  // DELETE /api/suite — delete a suite file
  if (pathname === "/api/suite" && req.method === "DELETE") {
    const body = await parseBody(req);
    const { file } = body;
    if (!file) {
      sendJson(res, 400, { error: "Missing file parameter" });
      return true;
    }
    const resolved = path.resolve(PROJECT_ROOT, file);
    if (!fs.existsSync(resolved)) {
      sendJson(res, 404, { error: `Suite not found: ${file}` });
      return true;
    }
    fs.unlinkSync(resolved);
    sendJson(res, 200, { message: `Suite deleted: ${file}` });
    return true;
  }

  // ── System Settings (Advanced Settings) ──────────────────────────────────

  // GET /api/system-settings — return merged defaults + saved values
  if (pathname === "/api/system-settings" && req.method === "GET") {
    const defaults = getDefaultSystemSettings();
    const saved = readJsonFile("instances/system-settings.json") || {};
    // Merge: saved values override defaults per-group
    const merged = {};
    for (const [group, entries] of Object.entries(defaults)) {
      merged[group] = { ...entries, ...(saved[group] || {}) };
    }
    sendJson(res, 200, merged);
    return true;
  }

  // PUT /api/system-settings — save advanced settings
  if (pathname === "/api/system-settings" && req.method === "PUT") {
    const body = await parseBody(req);
    if (!body || typeof body !== "object") {
      sendJson(res, 400, { error: "Invalid settings payload" });
      return true;
    }
    // Validate that only known groups are saved
    const defaults = getDefaultSystemSettings();
    const cleaned = {};
    for (const [group, entries] of Object.entries(body)) {
      if (defaults[group]) {
        cleaned[group] = {};
        for (const [key, value] of Object.entries(entries)) {
          if (key in defaults[group]) {
            cleaned[group][key] = value;
          }
        }
      }
    }
    writeJsonFile("instances/system-settings.json", cleaned);
    sendJson(res, 200, { message: "System settings saved" });
    return true;
  }

  // ── Profile / Connection Set management ────────────────────────────────

  // POST /api/profile — create a new connection set
  if (pathname === "/api/profile" && req.method === "POST") {
    const body = await parseBody(req);
    const { label, customer, salesforce, connect, vault } = body;
    if (!label || !label.trim()) {
      sendJson(res, 400, { error: "Connection label is required" });
      return true;
    }
    const profilesData = readJsonFile("instances/profiles.json") || { defaultInstance: "", profiles: [] };
    const id = slugify(label);
    if (profilesData.profiles.some((p) => p.id === id)) {
      sendJson(res, 409, { error: `Connection "${id}" already exists` });
      return true;
    }
    const envFile = `instances/${id}.env`;
    const profile = {
      id,
      label: label.trim(),
      customer: customer?.trim() || "",
      envFile,
      salesforce: {
        loginUrl: salesforce?.loginUrl || "https://login.salesforce.com",
        appName: salesforce?.appName || "Service Console",
      },
      connect: {
        region: connect?.region || "us-west-2",
        instanceAlias: connect?.instanceAlias || "",
      },
      vault: {
        addr: vault?.addr || "",
        basePath: vault?.basePath || "",
      },
      discovery: { autoDiscover: true, cacheFile: `.cache/org-vocabulary-${id}.json`, cacheTtlMinutes: 60 },
      vocabulary: {
        omniTargetStatus: null,
        queues: {},
        skills: {},
        ivrFlows: {},
        routing: { defaultType: "queue", skillBasedEnabled: false },
        supervisor: { surfaceName: null, appName: null },
        selectorOverrides: {},
      },
    };
    profilesData.profiles.push(profile);
    if (!profilesData.defaultInstance) profilesData.defaultInstance = id;
    // Store vault token in gitignored file (never in profiles.json)
    if (vault?.token) setVaultToken(id, vault.token);
    writeJsonFile("instances/profiles.json", profilesData);

    // Generate skeleton .env file
    const envContent = generateSkeletonEnv(profile);
    const envResolved = path.resolve(PROJECT_ROOT, envFile);
    fs.mkdirSync(path.dirname(envResolved), { recursive: true });
    fs.writeFileSync(envResolved, envContent);

    sendJson(res, 200, { id, envFile });
    return true;
  }

  // PUT /api/profile — update a connection set
  if (pathname === "/api/profile" && req.method === "PUT") {
    const body = await parseBody(req);
    const { id, label, customer, salesforce, connect, vault } = body;
    if (!id) {
      sendJson(res, 400, { error: "Missing profile id" });
      return true;
    }
    const profilesData = readJsonFile("instances/profiles.json");
    if (!profilesData) {
      sendJson(res, 404, { error: "No profiles found" });
      return true;
    }
    const profile = profilesData.profiles.find((p) => p.id === id);
    if (!profile) {
      sendJson(res, 404, { error: `Profile not found: ${id}` });
      return true;
    }
    if (label !== undefined) profile.label = label.trim();
    if (customer !== undefined) profile.customer = customer.trim();
    if (salesforce) {
      if (salesforce.loginUrl) profile.salesforce.loginUrl = salesforce.loginUrl;
      if (salesforce.appName !== undefined) profile.salesforce.appName = salesforce.appName;
    }
    if (connect) {
      if (connect.instanceAlias !== undefined) profile.connect.instanceAlias = connect.instanceAlias;
      if (connect.region) profile.connect.region = connect.region;
    }
    if (vault && typeof vault === "object") {
      if (!profile.vault) profile.vault = {};
      if (vault.addr !== undefined) profile.vault.addr = vault.addr;
      if (vault.basePath !== undefined) profile.vault.basePath = vault.basePath;
      // Vault token stored in gitignored file, not profiles.json
      if (vault.token !== undefined) setVaultToken(id, vault.token);
    }
    writeJsonFile("instances/profiles.json", profilesData);
    sendJson(res, 200, { message: "Profile updated" });
    return true;
  }

  // DELETE /api/profile — delete a connection set
  if (pathname === "/api/profile" && req.method === "DELETE") {
    const body = await parseBody(req);
    const { id } = body;
    if (!id) {
      sendJson(res, 400, { error: "Missing profile id" });
      return true;
    }
    const profilesData = readJsonFile("instances/profiles.json");
    if (!profilesData) {
      sendJson(res, 404, { error: "No profiles found" });
      return true;
    }
    // Check if any suite references this connection
    const suiteDir = path.resolve(PROJECT_ROOT, "scenarios/e2e");
    if (fs.existsSync(suiteDir)) {
      const suiteFiles = fs.readdirSync(suiteDir).filter((f) => f.endsWith(".json"));
      for (const sf of suiteFiles) {
        const suite = readJsonFile(`scenarios/e2e/${sf}`);
        if (suite?.connectionSetId === id) {
          sendJson(res, 409, { error: `Cannot delete: suite "${suite.name}" uses this connection` });
          return true;
        }
      }
    }
    const deletedProfile = profilesData.profiles.find((p) => p.id === id);
    profilesData.profiles = profilesData.profiles.filter((p) => p.id !== id);
    if (profilesData.defaultInstance === id) {
      profilesData.defaultInstance = profilesData.profiles[0]?.id || "";
    }
    writeJsonFile("instances/profiles.json", profilesData);
    // Clean up the skeleton .env file if it exists
    if (deletedProfile?.envFile) {
      const envPath = path.resolve(PROJECT_ROOT, deletedProfile.envFile);
      if (fs.existsSync(envPath)) fs.unlinkSync(envPath);
    }
    sendJson(res, 200, { message: `Connection "${id}" deleted` });
    return true;
  }

  // ── Profile env / credentials management ───────────────────────────────

  // GET /api/profile/env?id=<profileId> — read .env values for editing
  if (pathname === "/api/profile/env" && req.method === "GET") {
    const profileId = url.searchParams.get("id");
    if (!profileId) {
      sendJson(res, 400, { error: "Missing ?id= parameter" });
      return true;
    }
    const profilesData = readJsonFile("instances/profiles.json");
    const profile = profilesData?.profiles?.find((p) => p.id === profileId);
    if (!profile) {
      sendJson(res, 404, { error: `Profile not found: ${profileId}` });
      return true;
    }
    const envMap = parseEnvFile(profile.envFile);
    if (!envMap) {
      sendJson(res, 200, { backend: "env", env: {}, configured: false });
      return true;
    }
    const backend = (envMap.SECRETS_BACKEND || "env").toLowerCase();
    // Inject vault token from gitignored auth file (not stored in .env)
    if (backend === "vault") {
      const vt = getVaultToken(profileId);
      if (vt) envMap.VAULT_TOKEN = vt;
    }
    const masked = backend === "vault" ? envMap : maskSensitiveValues(envMap);
    // Mask the vault token for display
    if (masked.VAULT_TOKEN) masked.VAULT_TOKEN = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
    // Check if credentials are configured (non-empty sensitive fields)
    const sfAuthMethod = (envMap.SF_AUTH_METHOD || "password").toLowerCase();
    let configured = false;
    if (sfAuthMethod === "oauth") {
      configured = !!(envMap.SF_OAUTH_CONSUMER_KEY || envMap.SF_OAUTH_CONSUMER_KEY_REF);
    } else if (backend === "vault") {
      configured = !!(envMap.VAULT_ADDR && envMap.SF_PASSWORD_REF);
    } else {
      configured = !!(envMap.SF_USERNAME && envMap.SF_PASSWORD);
    }
    sendJson(res, 200, { backend, env: masked, configured, hasVaultToken: !!getVaultToken(profileId) });
    return true;
  }

  // POST /api/profile/env — write credentials to .env file (and optionally to Vault)
  if (pathname === "/api/profile/env" && req.method === "POST") {
    const body = await parseBody(req);
    const { id, credentials } = body;
    if (!id) {
      sendJson(res, 400, { error: "Missing profile id" });
      return true;
    }
    const profilesData = readJsonFile("instances/profiles.json");
    const profile = profilesData?.profiles?.find((p) => p.id === id);
    if (!profile) {
      sendJson(res, 404, { error: `Profile not found: ${id}` });
      return true;
    }

    const isVault = (credentials?.secretsBackend || "env") === "vault";
    const basePath = profile.vault?.basePath || "";

    // If Vault mode with basePath and actual values → write to Vault first
    let vaultWriteResult = null;
    if (isVault && basePath && credentials?._writeToVault) {
      const vaultAddr = profile.vault?.addr || credentials?.vaultAddr || "";
      const vaultToken = getVaultToken(id);
      if (!vaultAddr || !vaultToken) {
        sendJson(res, 400, { error: "Vault address and token required for Vault write" });
        return true;
      }
      vaultWriteResult = await writeSecretsToVault(vaultAddr, vaultToken, basePath, credentials);
      if (!vaultWriteResult.success) {
        sendJson(res, 500, {
          error: "Failed to write secrets to Vault",
          details: vaultWriteResult.errors,
          written: vaultWriteResult.written,
        });
        return true;
      }
      // Auto-generate refs from basePath so .env only has paths, never plaintext
      const autoRefs = buildVaultRefsFromBasePath(basePath);
      Object.assign(credentials, autoRefs);
      delete credentials._writeToVault;
    }

    const envContent = generateEnvContent(profile, credentials || {});
    const envResolved = path.resolve(PROJECT_ROOT, profile.envFile);
    fs.mkdirSync(path.dirname(envResolved), { recursive: true });
    fs.writeFileSync(envResolved, envContent);

    const result = { message: "Credentials saved", envFile: profile.envFile };
    if (vaultWriteResult) result.vaultWritten = vaultWriteResult.written;
    sendJson(res, 200, result);
    return true;
  }

  // GET /api/vault/secrets?id=<profileId> — read masked secret presence from Vault
  if (pathname === "/api/vault/secrets" && req.method === "GET") {
    const profileId = url.searchParams.get("id");
    if (!profileId) {
      sendJson(res, 400, { error: "Missing ?id= parameter" });
      return true;
    }
    const profilesData = readJsonFile("instances/profiles.json");
    const profile = profilesData?.profiles?.find((p) => p.id === profileId);
    if (!profile) {
      sendJson(res, 404, { error: `Profile not found: ${profileId}` });
      return true;
    }
    const basePath = profile.vault?.basePath;
    const vaultAddr = profile.vault?.addr;
    const vaultToken = getVaultToken(profileId);
    if (!basePath || !vaultAddr || !vaultToken) {
      sendJson(res, 200, { secrets: {}, available: false });
      return true;
    }
    const secrets = await readSecretsFromVault(vaultAddr, vaultToken, basePath);
    sendJson(res, 200, { secrets, available: true });
    return true;
  }

  // POST /api/vault/test — test vault connectivity
  if (pathname === "/api/vault/test" && req.method === "POST") {
    const body = await parseBody(req);
    const { vaultAddr, vaultToken, testRef } = body;
    if (!vaultAddr || !vaultToken) {
      sendJson(res, 400, { error: "Vault address and token are required" });
      return true;
    }
    try {
      // Test basic connectivity: GET /v1/sys/health
      const healthUrl = `${vaultAddr.replace(/\/+$/, "")}/v1/sys/health`;
      const healthResp = await fetch(healthUrl, {
        method: "GET",
        headers: { "X-Vault-Token": vaultToken },
        signal: AbortSignal.timeout(10000),
      });
      if (!healthResp.ok) {
        const text = await healthResp.text().catch(() => "");
        sendJson(res, 200, {
          success: false,
          error: `Vault returned HTTP ${healthResp.status}: ${text.slice(0, 200)}`,
        });
        return true;
      }
      const health = await healthResp.json();
      const result = { success: true, sealed: health.sealed, version: health.version };

      // Optionally test a specific secret reference
      if (testRef) {
        const ref = testRef.trim();
        const hashIdx = ref.lastIndexOf("#");
        let vaultPath, field;
        if (hashIdx > 0) {
          vaultPath = ref.slice(0, hashIdx);
          field = ref.slice(hashIdx + 1);
        } else {
          vaultPath = ref;
          field = "value";
        }
        const secretUrl = `${vaultAddr.replace(/\/+$/, "")}/v1/${vaultPath.replace(/^\/+/, "")}`;
        const secretResp = await fetch(secretUrl, {
          method: "GET",
          headers: { "X-Vault-Token": vaultToken },
          signal: AbortSignal.timeout(10000),
        });
        if (secretResp.ok) {
          const payload = await secretResp.json();
          const data = payload?.data?.data ?? payload?.data ?? {};
          result.secretAccessible = field in data;
          result.secretField = field;
        } else {
          result.secretAccessible = false;
          result.secretError = `HTTP ${secretResp.status}`;
        }
      }

      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 200, {
        success: false,
        error: err.message || "Failed to connect to Vault",
      });
    }
    return true;
  }

  // ── Salesforce OAuth ──────────────────────────────────────────────────
  // PKCE verifiers stored in memory (keyed by profileId, short-lived)
  if (!global._pkceStore) global._pkceStore = new Map();

  // GET /api/oauth/sf/config — returns bundled OAuth config (public info only)
  if (pathname === "/api/oauth/sf/config" && req.method === "GET") {
    sendJson(res, 200, {
      hasBundledApp: !!BUNDLED_OAUTH_CONSUMER_KEY,
      bundledConsumerKey: BUNDLED_OAUTH_CONSUMER_KEY || null,
      callbackUrl: `http://localhost:${PORT}/oauth/callback`,
    });
    return true;
  }

  // GET /api/oauth/sf/start — initiate OAuth flow, returns authorize URL
  if (pathname === "/api/oauth/sf/start" && req.method === "GET") {
    const profileId = url.searchParams.get("profileId");
    if (!profileId) {
      sendJson(res, 400, { error: "Missing ?profileId= parameter" });
      return true;
    }
    const profilesData = readJsonFile("instances/profiles.json");
    const profile = profilesData?.profiles?.find((p) => p.id === profileId);
    if (!profile) {
      sendJson(res, 404, { error: `Profile not found: ${profileId}` });
      return true;
    }
    const envMap = parseEnvFile(profile.envFile) || {};
    const consumerKey = envMap.SF_OAUTH_CONSUMER_KEY || envMap.SF_OAUTH_CONSUMER_KEY_REF || BUNDLED_OAUTH_CONSUMER_KEY || "";
    if (!consumerKey) {
      sendJson(res, 400, { error: "No OAuth Consumer Key available. Configure a Connected App or set AUDRIQUE_OAUTH_CONSUMER_KEY." });
      return true;
    }
    const loginUrl = envMap.SF_LOGIN_URL || profile.salesforce?.loginUrl || "https://login.salesforce.com";
    const callbackUrl = envMap.SF_OAUTH_CALLBACK_URL || `http://localhost:${PORT}/oauth/callback`;
    const { buildAuthorizeUrl, generatePkce } = await import(path.join(PROJECT_ROOT, "scripts/sf-oauth-auth.mjs"));
    const pkce = generatePkce();
    global._pkceStore.set(profileId, pkce.codeVerifier);
    // Auto-expire after 10 minutes
    setTimeout(() => global._pkceStore.delete(profileId), 10 * 60 * 1000);
    const authorizeUrl = buildAuthorizeUrl({
      consumerKey,
      callbackUrl,
      loginUrl,
      state: profileId,
      codeChallenge: pkce.codeChallenge,
    });
    sendJson(res, 200, { url: authorizeUrl });
    return true;
  }

  // POST /api/oauth/sf/callback — exchange code for tokens and create session
  if (pathname === "/api/oauth/sf/callback" && req.method === "POST") {
    const body = await parseBody(req);
    const { code, profileId } = body;
    if (!code || !profileId) {
      sendJson(res, 400, { error: "Missing code or profileId" });
      return true;
    }
    const profilesData = readJsonFile("instances/profiles.json");
    const profile = profilesData?.profiles?.find((p) => p.id === profileId);
    if (!profile) {
      sendJson(res, 404, { error: `Profile not found: ${profileId}` });
      return true;
    }
    const envMap = parseEnvFile(profile.envFile) || {};
    const consumerKey = envMap.SF_OAUTH_CONSUMER_KEY || envMap.SF_OAUTH_CONSUMER_KEY_REF || BUNDLED_OAUTH_CONSUMER_KEY || "";
    const consumerSecret = envMap.SF_OAUTH_CONSUMER_SECRET || envMap.SF_OAUTH_CONSUMER_SECRET_REF || BUNDLED_OAUTH_CONSUMER_SECRET || "";
    if (!consumerKey) {
      sendJson(res, 400, { error: "No OAuth Consumer Key available. Configure a Connected App or set AUDRIQUE_OAUTH_CONSUMER_KEY." });
      return true;
    }
    const loginUrl = envMap.SF_LOGIN_URL || profile.salesforce?.loginUrl || "https://login.salesforce.com";
    const callbackUrl = envMap.SF_OAUTH_CALLBACK_URL || `http://localhost:${PORT}/oauth/callback`;
    const storageStatePath = envMap.SF_STORAGE_STATE || `.auth/sf-${profileId}.json`;
    const appName = envMap.SF_APP_NAME || profile.salesforce?.appName || "Service Console";

    try {
      const oauth = await import(path.join(PROJECT_ROOT, "scripts/sf-oauth-auth.mjs"));

      // Step 1: Exchange code for tokens (with PKCE verifier — no secret needed for public clients)
      const codeVerifier = global._pkceStore?.get(profileId) || undefined;
      global._pkceStore?.delete(profileId);
      console.log(`[oauth] Exchanging code for tokens (profile: ${profileId})...`);
      const tokens = await oauth.exchangeCodeForTokens({
        code, consumerKey, consumerSecret: consumerSecret || undefined, callbackUrl, loginUrl, codeVerifier,
      });
      console.log(`[oauth] Tokens received. Instance: ${tokens.instance_url}`);

      // Step 2: Save tokens
      oauth.saveOAuthTokens(profileId, tokens);

      // Step 3: Create browser session via frontdoor.jsp
      console.log(`[oauth] Creating browser session via frontdoor.jsp...`);
      const session = await oauth.createSessionViaFrontdoor({
        accessToken: tokens.access_token,
        instanceUrl: tokens.instance_url,
        storageStatePath,
        appName,
      });

      if (!session.authenticated) {
        sendJson(res, 200, { success: false, error: "frontdoor.jsp session creation failed. The Connected App may need additional permissions." });
        return true;
      }

      console.log(`[oauth] Session created successfully. URL: ${session.finalUrl}`);
      sendJson(res, 200, { success: true, instanceUrl: tokens.instance_url });
    } catch (err) {
      console.error(`[oauth] Error: ${err.message}`);
      sendJson(res, 200, { success: false, error: err.message });
    }
    return true;
  }

  // POST /api/oauth/sf/refresh — refresh OAuth tokens and recreate session
  if (pathname === "/api/oauth/sf/refresh" && req.method === "POST") {
    const body = await parseBody(req);
    const profileId = body.profileId || "personal";
    const profilesData = readJsonFile("instances/profiles.json");
    const profile = profilesData?.profiles?.find((p) => p.id === profileId);
    if (!profile) {
      sendJson(res, 404, { error: `Profile not found: ${profileId}` });
      return true;
    }
    const envMap = parseEnvFile(profile.envFile) || {};
    const storageStatePath = envMap.SF_STORAGE_STATE || `.auth/sf-${profileId}.json`;

    try {
      const oauth = await import(path.join(PROJECT_ROOT, "scripts/sf-oauth-auth.mjs"));
      const result = await oauth.tryOAuthRefreshAuth({
        consumerKey: envMap.SF_OAUTH_CONSUMER_KEY || envMap.SF_OAUTH_CONSUMER_KEY_REF || BUNDLED_OAUTH_CONSUMER_KEY || "",
        consumerSecret: envMap.SF_OAUTH_CONSUMER_SECRET || envMap.SF_OAUTH_CONSUMER_SECRET_REF || BUNDLED_OAUTH_CONSUMER_SECRET || "",
        loginUrl: envMap.SF_LOGIN_URL || profile.salesforce?.loginUrl || "https://login.salesforce.com",
        storageStatePath,
        appName: envMap.SF_APP_NAME || profile.salesforce?.appName || "Service Console",
        profileId,
      });

      if (result.success) {
        sendJson(res, 200, { success: true });
      } else {
        sendJson(res, 200, { success: false, error: result.error });
      }
    } catch (err) {
      sendJson(res, 200, { success: false, error: err.message });
    }
    return true;
  }

  // GET /api/oauth/sf/status — check if OAuth tokens exist for a profile
  if (pathname === "/api/oauth/sf/status" && req.method === "GET") {
    const profileId = url.searchParams.get("profileId");
    if (!profileId) {
      sendJson(res, 400, { error: "Missing ?profileId= parameter" });
      return true;
    }
    try {
      const oauth = await import(path.join(PROJECT_ROOT, "scripts/sf-oauth-auth.mjs"));
      const tokens = oauth.loadOAuthTokens(profileId);
      if (!tokens) {
        sendJson(res, 200, { hasTokens: false });
        return true;
      }
      sendJson(res, 200, {
        hasTokens: true,
        expired: oauth.isTokenExpired(tokens),
        instanceUrl: tokens.instance_url || null,
        issuedAt: tokens.issued_at || null,
      });
    } catch (err) {
      sendJson(res, 200, { hasTokens: false, error: err.message });
    }
    return true;
  }

  // ── Auth refresh ────────────────────────────────────────────────────────

  // POST /api/auth/refresh — refresh Salesforce session, returns when done
  if (pathname === "/api/auth/refresh" && req.method === "POST") {
    const body = await parseBody(req);
    const profileId = body.profileId || "personal";

    // Load Vault config from profile settings (profiles.json vault section)
    // This avoids putting VAULT_TOKEN in the env file which triggers regulated mode violations
    const profilesData = readJsonFile("instances/profiles.json");
    const profile = profilesData?.profiles?.find((p) => p.id === profileId);
    const profileEnv = profile?.envFile ? parseEnvFile(profile.envFile) : {};

    const env = { ...process.env, INSTANCE: profileId };
    // Priority: body override > profile.vault > env file > process.env
    env.VAULT_ADDR = body.vaultAddr || profile?.vault?.addr || profileEnv?.VAULT_ADDR || env.VAULT_ADDR || "";
    env.VAULT_TOKEN = body.vaultToken || getVaultToken(profileId) || profileEnv?.VAULT_TOKEN || env.VAULT_TOKEN || "";

    const child = spawn(
      "node",
      [path.join(PROJECT_ROOT, "scripts/run-instance.mjs"), "auth:state"],
      { cwd: PROJECT_ROOT, env, stdio: ["ignore", "pipe", "pipe"] }
    );

    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });

    await new Promise((resolve) => {
      child.on("close", (code) => {
        if (code === 0) {
          sendJson(res, 200, { success: true, output });
        } else {
          sendJson(res, 500, {
            success: false,
            error: `Auth refresh failed (exit ${code})`,
            output,
          });
        }
        resolve();
      });
    });
    return true;
  }

  // ── Run management ──────────────────────────────────────────────────────

  // POST /api/run — start a suite run, returns run ID
  if (pathname === "/api/run" && req.method === "POST") {
    const body = await parseBody(req);
    const suiteFile = body.suiteFile || "scenarios/e2e/full-suite-v2.json";
    const dryRun = body.dryRun === true;
    // Resolve instance: explicit override > suite connectionSetId > env var
    let instance = body.instance || "";
    if (!instance) {
      const suiteData = readJsonFile(suiteFile);
      if (suiteData?.connectionSetId) instance = suiteData.connectionSetId;
    }
    if (!instance) instance = process.env.INSTANCE || "";

    if (activeRun) {
      sendJson(res, 409, { error: "A run is already in progress", runId: activeRun.id });
      return true;
    }

    const runId = `run-${Date.now()}`;

    // Detect if we're already inside Docker
    const insideDocker = fs.existsSync("/.dockerenv") ||
      (fs.existsSync("/proc/1/cgroup") &&
       fs.readFileSync("/proc/1/cgroup", "utf8").includes("docker"));

    // Inject Vault config from profiles.json
    const execProfileId = instance || "personal";
    const execProfilesData = readJsonFile("instances/profiles.json");
    const execProfile = execProfilesData?.profiles?.find((p) => p.id === execProfileId);
    const execVaultToken = getVaultToken(execProfileId);

    let child;
    if (insideDocker) {
      // Inside Docker: spawn suite runner directly (same container)
      const env = {
        ...process.env,
        E2E_SUITE_FILE: suiteFile,
        FORCE_COLOR: "0",
      };
      if (dryRun) env.E2E_SUITE_DRY_RUN = "true";
      if (instance) env.INSTANCE = instance;
      if (execProfile?.vault?.addr) env.VAULT_ADDR = execProfile.vault.addr;
      if (execVaultToken) env.VAULT_TOKEN = execVaultToken;

      child = spawn("node", [path.join(PROJECT_ROOT, "scripts/run-instance-e2e-suite.mjs")], {
        cwd: PROJECT_ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      // Local dev: route through Docker for headless Chromium + Vault access
      const dockerArgs = ["compose", "run", "--rm"];
      dockerArgs.push("-e", `E2E_SUITE_FILE=${suiteFile}`);
      if (dryRun) dockerArgs.push("-e", "E2E_SUITE_DRY_RUN=true");
      if (instance) dockerArgs.push("-e", `INSTANCE=${instance}`);
      if (execProfile?.vault?.addr) {
        const vaultAddr = execProfile.vault.addr
          .replace("localhost", "host.docker.internal")
          .replace("127.0.0.1", "host.docker.internal");
        dockerArgs.push("-e", `VAULT_ADDR=${vaultAddr}`);
      }
      if (execVaultToken) dockerArgs.push("-e", `VAULT_TOKEN=${execVaultToken}`);
      dockerArgs.push("test");

      child = spawn("docker", dockerArgs, {
        cwd: PROJECT_ROOT,
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    }

    const startedAt = new Date().toISOString();
    activeRun = {
      id: runId,
      suiteFile,
      dryRun,
      startedAt,
      status: "running",
      child,
      listeners: new Set(),
      lines: [],
      dbRunId: null,
    };

    // Create DB run record if database is available
    if (dbAvailable()) {
      try {
        const suiteData = readJsonFile(suiteFile);
        activeRun.dbRunId = await createRun(getTenantId(req), {
          suiteName: suiteData?.name || path.basename(suiteFile, ".json"),
          suiteFile,
          status: "running",
          startedAt,
          stopOnFailure: suiteData?.stopOnFailure || false,
          dryRun,
          connectionSet: instance || null,
          suiteConfig: suiteData,
        });
      } catch (err) {
        console.error("[db] Failed to create run record:", err.message);
      }
    }

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

        // Ingest results into database
        if (dbAvailable() && activeRun.dbRunId) {
          const capturedRunId = activeRun.dbRunId;
          // Find the most recent suite-summary.json for this suite
          const resultsRoot = path.join(PROJECT_ROOT, "test-results", "e2e-suite");
          try {
            if (fs.existsSync(resultsRoot)) {
              const dirs = fs.readdirSync(resultsRoot, { withFileTypes: true })
                .filter((d) => d.isDirectory())
                .map((d) => ({ name: d.name, mtime: fs.statSync(path.join(resultsRoot, d.name)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
              for (const dir of dirs) {
                const summaryPath = path.join(resultsRoot, dir.name, "suite-summary.json");
                if (fs.existsSync(summaryPath)) {
                  ingestSuiteSummary(getTenantId(), summaryPath, capturedRunId)
                    .then(() => console.log(`[db] Ingested results for run ${capturedRunId}`))
                    .catch((err) => console.error("[db] Ingestion failed:", err.message));
                  break;
                }
              }
            }
          } catch (err) {
            console.error("[db] Failed to find suite summary:", err.message);
          }
        }

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

  // ── Results API (PostgreSQL-backed) ──────────────────────────────────────

  // GET /api/results/status — check if database is configured
  if (pathname === "/api/results/status" && req.method === "GET") {
    sendJson(res, 200, { available: dbAvailable() });
    return true;
  }

  // GET /api/results/runs — paginated run history
  if (pathname === "/api/results/runs" && req.method === "GET") {
    if (!dbAvailable()) {
      sendJson(res, 503, { error: "Database not configured" });
      return true;
    }
    try {
      const tid = getTenantId(req);
      const { page, limit } = sanitizePagination(
        url.searchParams.get("page"),
        url.searchParams.get("limit")
      );
      const status = sanitizeString(url.searchParams.get("status") || "", 20);
      const suiteName = sanitizeString(url.searchParams.get("suite") || "", 200);
      const result = await listRuns(tid, { page, limit, status, suiteName });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/results/runs/:id — single run with scenario details
  const runDetailMatch = pathname.match(/^\/api\/results\/runs\/([0-9a-f-]{36})$/);
  if (runDetailMatch && req.method === "GET") {
    if (!dbAvailable()) {
      sendJson(res, 503, { error: "Database not configured" });
      return true;
    }
    const runId = runDetailMatch[1];
    if (!isValidUUID(runId)) {
      sendJson(res, 400, { error: "Invalid run ID format" });
      return true;
    }
    try {
      const tid = getTenantId(req);
      const run = await getRun(tid, runId);
      if (!run) {
        sendJson(res, 404, { error: "Run not found" });
      } else {
        sendJson(res, 200, { run });
      }
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // DELETE /api/results/runs/:id — delete a run and all children
  const runDeleteMatch = pathname.match(/^\/api\/results\/runs\/([0-9a-f-]{36})$/);
  if (runDeleteMatch && req.method === "DELETE") {
    if (!dbAvailable()) {
      sendJson(res, 503, { error: "Database not configured" });
      return true;
    }
    const deleteRunId = runDeleteMatch[1];
    if (!isValidUUID(deleteRunId)) {
      sendJson(res, 400, { error: "Invalid run ID format" });
      return true;
    }
    try {
      const tid = getTenantId(req);
      const deleted = await deleteRun(tid, deleteRunId);
      if (!deleted) {
        sendJson(res, 404, { error: "Run not found" });
      } else {
        logAudit(tid, "delete", "run", deleteRunId);
        sendJson(res, 200, { message: "Run deleted" });
      }
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/results/runs/:runId/scenarios/:scenarioResultId — scenario deep-dive
  const scenarioDetailMatch = pathname.match(
    /^\/api\/results\/runs\/[0-9a-f-]{36}\/scenarios\/([0-9a-f-]{36})$/
  );
  if (scenarioDetailMatch && req.method === "GET") {
    if (!dbAvailable()) {
      sendJson(res, 503, { error: "Database not configured" });
      return true;
    }
    const scenarioResultId = scenarioDetailMatch[1];
    if (!isValidUUID(scenarioResultId)) {
      sendJson(res, 400, { error: "Invalid scenario result ID format" });
      return true;
    }
    try {
      const tid = getTenantId(req);
      const scenario = await getScenarioResult(tid, scenarioResultId);
      if (!scenario) {
        sendJson(res, 404, { error: "Scenario result not found" });
      } else {
        sendJson(res, 200, { scenario });
      }
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/results/trends — pass rate trends
  if (pathname === "/api/results/trends" && req.method === "GET") {
    if (!dbAvailable()) {
      sendJson(res, 503, { error: "Database not configured" });
      return true;
    }
    try {
      const tid = getTenantId(req);
      const days = sanitizeDays(url.searchParams.get("days"), 30);
      const suiteName = sanitizeString(url.searchParams.get("suite") || "", 200);
      const trends = await getPassRateTrend(tid, { days, suiteName });
      sendJson(res, 200, trends);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/results/flaky — flaky scenario detection
  if (pathname === "/api/results/flaky" && req.method === "GET") {
    if (!dbAvailable()) {
      sendJson(res, 503, { error: "Database not configured" });
      return true;
    }
    try {
      const tid = getTenantId(req);
      let minRuns = parseInt(url.searchParams.get("minRuns"), 10);
      if (!Number.isFinite(minRuns) || minRuns < 1) minRuns = 3;
      if (minRuns > 1000) minRuns = 1000;
      const days = sanitizeDays(url.searchParams.get("days"), 30);
      const result = await getFlakyScenarios(tid, { minRuns, days });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/results/scenarios/:scenarioId/history — history for a scenario ID
  const scenarioHistoryMatch = pathname.match(/^\/api\/results\/scenarios\/([^/]+)\/history$/);
  if (scenarioHistoryMatch && req.method === "GET") {
    if (!dbAvailable()) {
      sendJson(res, 503, { error: "Database not configured" });
      return true;
    }
    try {
      const tid = getTenantId(req);
      const scenarioId = sanitizeString(decodeURIComponent(scenarioHistoryMatch[1]), 500);
      if (!scenarioId) {
        sendJson(res, 400, { error: "Invalid scenario ID" });
        return true;
      }
      let histLimit = parseInt(url.searchParams.get("limit"), 10);
      if (!Number.isFinite(histLimit) || histLimit < 1) histLimit = 20;
      if (histLimit > 100) histLimit = 100;
      const result = await getScenarioHistory(tid, scenarioId, { limit: histLimit });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  return false;
}

// ── Tenant resolution ───────────────────────────────────────────────────────
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
function getTenantId(/* req */) {
  // Future: extract from auth header or session. For now, use default tenant.
  return DEFAULT_TENANT_ID;
}

// ── Active run state ────────────────────────────────────────────────────────
let activeRun = null;

// ── HTTP Server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // Security headers on every response
  setSecurityHeaders(res);

  try {
    // API routes
    if (req.url.startsWith("/api/")) {
      // Rate limiting for API endpoints
      const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
        || req.socket.remoteAddress || "unknown";
      const rl = checkRateLimit(clientIp);
      res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
      if (!rl.allowed) {
        res.setHeader("Retry-After", String(Math.ceil((rl.resetAt - Date.now()) / 1000)));
        sendJson(res, 429, { error: "Rate limit exceeded. Try again shortly." });
        return;
      }

      const handled = await handleApi(req, res);
      if (handled) return;
      sendJson(res, 404, { error: "Unknown API endpoint" });
      return;
    }

    // OAuth callback page (served at /oauth/callback)
    if (req.url.startsWith("/oauth/callback")) {
      sendFile(res, "public/oauth-callback.html", "text/html");
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

/**
 * Auto-ingest existing JSON suite results into the database.
 * Scans test-results/e2e-suite/ for suite-summary.json files not yet in DB.
 * Runs in the background after server startup — does not block boot.
 */
async function autoIngestExistingResults() {
  if (!dbAvailable()) return;

  const resultsRoot = path.join(PROJECT_ROOT, "test-results", "e2e-suite");
  if (!fs.existsSync(resultsRoot)) return;

  try {
    const tid = getTenantId();
    const dirs = fs.readdirSync(resultsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    let ingested = 0;
    let skipped = 0;

    for (const dirName of dirs) {
      const summaryPath = path.join(resultsRoot, dirName, "suite-summary.json");
      if (!fs.existsSync(summaryPath)) { skipped++; continue; }

      try {
        await ingestSuiteSummary(tid, summaryPath);
        ingested++;
      } catch (err) {
        // Duplicate run_dir entries (already ingested) are expected — skip silently
        if (err.message?.includes("duplicate key") || err.code === "23505") {
          skipped++;
        } else {
          console.error(`[auto-ingest] Failed: ${dirName} — ${err.message}`);
        }
      }
    }

    if (ingested > 0) {
      console.log(`[auto-ingest] Backfilled ${ingested} existing runs into database (${skipped} already present)`);
    }
  } catch (err) {
    console.error("[auto-ingest] Error scanning results:", err.message);
  }
}

async function startServer() {
  await resolveOAuthKeysFromVault();

  // Initialize database (optional — server works without it)
  try {
    await initPool();
    if (dbAvailable()) {
      await runMigrations();
    }
  } catch (err) {
    console.error("[db] Database initialization failed:", err.message);
    console.log("[db] Continuing without database — results tracking disabled");
  }

  server.listen(PORT, () => {
    console.log("");
    console.log("  ┌──────────────────────────────────────────────┐");
    console.log("  │                                              │");
    console.log("  │   Audrique Scenario Studio                   │");
    console.log(`  │   http://localhost:${PORT}                      │`);
    console.log("  │                                              │");
    if (dbAvailable()) {
      console.log("  │   Database: connected                        │");
    } else {
      console.log("  │   Database: not configured                   │");
    }
    console.log("  │   Press Ctrl+C to stop                       │");
    console.log("  │                                              │");
    console.log("  └──────────────────────────────────────────────┘");
    console.log("");

    // Auto-ingest existing JSON results into DB (background, non-blocking)
    autoIngestExistingResults();
  });
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  await dbShutdown();
  process.exit(0);
});

startServer();
