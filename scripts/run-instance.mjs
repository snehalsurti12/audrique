import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const REF_SUFFIX = "_REF";
const PROFILES_PATH = path.resolve(process.cwd(), "instances", "profiles.json");
const ACTIVE_PROFILE_PATH = path.resolve(process.cwd(), ".instance-profile");
const SENSITIVE_KEYS = new Set([
  "AWS_USERNAME",
  "AWS_PASSWORD",
  "SF_USERNAME",
  "SF_PASSWORD",
  "SF_EMAIL_CODE",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "VAULT_TOKEN"
]);
const NON_SECRET_CONFIG_KEYS = new Set([
  "SECRETS_BACKEND",
  "REGULATED_MODE"
]);
const SENSITIVE_KEY_PATTERNS = [/PASSWORD/i, /TOKEN/i, /SECRET/i, /API_KEY/i, /PRIVATE_KEY/i];

async function main() {
  const targetScript = process.argv[2];
  if (!targetScript) {
    throw new Error(
      "Usage: node scripts/run-instance.mjs <npm-script> [-- <extra npm args>]"
    );
  }

  const extraArgs = readExtraArgs(process.argv);
  const { envFile, instance, source } = resolveEnvFile();
  const instanceEnv = parseEnvFile(envFile);
  const mergedEnv = { ...instanceEnv, ...process.env };
  const regulatedMode = isTruthy(mergedEnv.REGULATED_MODE);
  enforceRegulatedModeGuardrails(instanceEnv, regulatedMode);
  const secretsBackend = (mergedEnv.SECRETS_BACKEND || "env").trim().toLowerCase();
  const resolvedSecrets = await resolveSecretReferences(mergedEnv, secretsBackend);
  const env = deriveConnectEnvDefaults({ ...mergedEnv, ...resolvedSecrets });

  console.log(`Using instance profile: ${instance} (${source})`);
  console.log(`Using instance env: ${envFile}`);
  console.log(
    `Secrets backend: ${secretsBackend}${regulatedMode ? " (regulated mode)" : ""}; resolved refs: ${
      Object.keys(resolvedSecrets).length
    }`
  );
  await runNpmScript(targetScript, extraArgs, env);
}

function readExtraArgs(argv) {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex === -1) {
    return [];
  }
  return argv.slice(separatorIndex + 1);
}

function resolveEnvFile() {
  const fromPath = process.env.INSTANCE_ENV_FILE?.trim();
  if (fromPath) {
    const absolutePath = path.resolve(process.cwd(), fromPath);
    assertFileExists(
      absolutePath,
      `INSTANCE_ENV_FILE is set but file was not found: ${absolutePath}`
    );
    return {
      envFile: absolutePath,
      instance: path.basename(absolutePath).replace(/\.env$/i, ""),
      source: "INSTANCE_ENV_FILE"
    };
  }

  const profilesConfig = loadProfilesConfig();
  const { instance, source } = resolveInstanceSelection(profilesConfig);
  const candidate = resolveInstanceEnvPath(instance, profilesConfig);
  assertFileExists(
    candidate,
    `Instance file not found: ${candidate}\nCreate it from instances/default.env.example`
  );
  return { envFile: candidate, instance, source };
}

function loadProfilesConfig() {
  if (!fs.existsSync(PROFILES_PATH)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8"));
    if (!Array.isArray(parsed?.profiles)) {
      return null;
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Failed to parse ${PROFILES_PATH}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function resolveInstanceSelection(profilesConfig) {
  const fromEnv = process.env.INSTANCE?.trim();
  if (fromEnv) {
    return { instance: fromEnv, source: "INSTANCE" };
  }

  const fromSelectedProfile = readActiveProfile();
  if (fromSelectedProfile) {
    return { instance: fromSelectedProfile, source: ".instance-profile" };
  }

  const fromProfilesDefault = profilesConfig?.defaultInstance?.trim?.();
  if (fromProfilesDefault) {
    return { instance: fromProfilesDefault, source: "profiles.defaultInstance" };
  }

  return { instance: "default", source: "fallback" };
}

function readActiveProfile() {
  if (!fs.existsSync(ACTIVE_PROFILE_PATH)) {
    return "";
  }

  const profile = fs.readFileSync(ACTIVE_PROFILE_PATH, "utf8").trim();
  return profile;
}

function resolveInstanceEnvPath(instance, profilesConfig) {
  const profile = profilesConfig?.profiles?.find((entry) => entry?.id === instance);
  if (typeof profile?.envFile === "string" && profile.envFile.trim().length > 0) {
    return path.resolve(process.cwd(), profile.envFile.trim());
  }
  return path.resolve(process.cwd(), "instances", `${instance}.env`);
}

function assertFileExists(filePath, message) {
  if (!fs.existsSync(filePath)) {
    throw new Error(message);
  }
}

function parseEnvFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const output = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const normalized = line.startsWith("export ") ? line.slice(7) : line;
    const eqIndex = normalized.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = normalized.slice(0, eqIndex).trim();
    const rawValue = normalized.slice(eqIndex + 1).trim();
    output[key] = stripQuotes(rawValue);
  }

  return output;
}

function stripQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function runNpmScript(script, extraArgs, env) {
  return new Promise((resolve, reject) => {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const args = ["run", script, ...buildNpmExtraArgTail(extraArgs)];
    const child = spawn(npmCmd, args, {
      stdio: "inherit",
      env
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`npm run ${script} failed with exit code ${code ?? 1}`));
    });
  });
}

function buildNpmExtraArgTail(extraArgs) {
  if (extraArgs.length === 0) {
    return [];
  }
  return ["--", ...extraArgs];
}

function deriveConnectEnvDefaults(env) {
  const next = { ...env };
  const region = (next.CONNECT_CONSOLE_REGION || next.AWS_REGION || "").trim();
  const aliasOrHost = (next.CONNECT_INSTANCE_ALIAS || "").trim();

  if (!hasValue(next.CONNECT_CCP_URL) && aliasOrHost) {
    const host = aliasOrHost.includes(".") ? aliasOrHost : `${aliasOrHost}.my.connect.aws`;
    next.CONNECT_CCP_URL = `https://${host.replace(/\/+$/, "")}/ccp-v2/`;
  }

  const normalizedStart = normalizeConnectStartUrl(next.CONNECT_START_URL, region);
  if (hasValue(normalizedStart)) {
    next.CONNECT_START_URL = normalizedStart;
  } else if (region) {
    next.CONNECT_START_URL = `https://${region}.console.aws.amazon.com/connect/v2/app/instances?region=${region}`;
  } else {
    next.CONNECT_START_URL = "https://console.aws.amazon.com/connect/home";
  }

  return next;
}

function normalizeConnectStartUrl(rawStartUrl, region) {
  const candidate = (rawStartUrl || "").trim();
  if (!candidate) {
    return "";
  }

  if (!region) {
    return candidate;
  }

  try {
    const url = new URL(candidate);
    const host = url.host.toLowerCase();
    const path = url.pathname.toLowerCase();

    const isAwsSignin = host === "signin.aws.amazon.com" || host.endsWith(".signin.aws.amazon.com");
    const isConnectConsole =
      (host === "console.aws.amazon.com" || host.endsWith(".console.aws.amazon.com")) &&
      path.startsWith("/connect");

    if (isAwsSignin || isConnectConsole) {
      return `https://${region}.console.aws.amazon.com/connect/v2/app/instances?region=${region}`;
    }
    return candidate;
  } catch {
    return candidate;
  }
}

function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

function isSensitiveKey(key) {
  if (key.endsWith(REF_SUFFIX)) {
    return false;
  }
  if (NON_SECRET_CONFIG_KEYS.has(key)) {
    return false;
  }
  if (SENSITIVE_KEYS.has(key)) {
    return true;
  }
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function enforceRegulatedModeGuardrails(instanceEnv, regulatedMode) {
  if (!regulatedMode) {
    return;
  }

  const plaintextViolations = [];
  for (const [key, value] of Object.entries(instanceEnv)) {
    if (!isSensitiveKey(key)) {
      continue;
    }
    if (!hasValue(value)) {
      continue;
    }
    const refKey = `${key}${REF_SUFFIX}`;
    if (hasValue(instanceEnv[refKey])) {
      continue;
    }
    plaintextViolations.push(key);
  }

  if (plaintextViolations.length > 0) {
    throw new Error(
      [
        "REGULATED_MODE=true blocks plaintext sensitive values in instances/*.env.",
        `Move these keys to *_REF or inject at runtime: ${plaintextViolations.join(", ")}`
      ].join(" ")
    );
  }
}

async function resolveSecretReferences(env, backend) {
  const resolved = {};
  const cache = new Map();

  for (const [key, refValue] of Object.entries(env)) {
    if (!key.endsWith(REF_SUFFIX)) {
      continue;
    }
    if (!hasValue(refValue)) {
      continue;
    }

    const targetKey = key.slice(0, -REF_SUFFIX.length);
    if (hasValue(env[targetKey])) {
      continue;
    }

    const secretRef = refValue.trim();
    const cacheKey = `${backend}:${secretRef}`;
    if (!cache.has(cacheKey)) {
      cache.set(cacheKey, await readSecretValue({ backend, secretRef, env }));
    }
    resolved[targetKey] = cache.get(cacheKey);
  }

  return resolved;
}

async function readSecretValue({ backend, secretRef, env }) {
  if (backend === "env") {
    const value = process.env[secretRef] ?? env[secretRef];
    if (!hasValue(value)) {
      throw new Error(`Missing env-backed secret for ref "${secretRef}".`);
    }
    return value;
  }

  if (backend === "vault") {
    const addr = (process.env.VAULT_ADDR ?? env.VAULT_ADDR ?? "").trim();
    const token = (process.env.VAULT_TOKEN ?? env.VAULT_TOKEN ?? "").trim();
    if (!addr) {
      throw new Error("SECRETS_BACKEND=vault requires VAULT_ADDR.");
    }
    if (!token) {
      throw new Error("SECRETS_BACKEND=vault requires VAULT_TOKEN.");
    }

    const { vaultPath, field } = parseVaultRef(secretRef);
    const requestUrl = `${addr.replace(/\/+$/, "")}/v1/${vaultPath.replace(/^\/+/, "")}`;
    const response = await fetch(requestUrl, {
      method: "GET",
      headers: {
        "X-Vault-Token": token
      }
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(
        `Vault secret read failed for "${secretRef}" (HTTP ${response.status}). ${message.slice(0, 160)}`
      );
    }

    const payload = await response.json();
    const data = payload?.data?.data ?? payload?.data ?? {};
    if (!(field in data)) {
      throw new Error(`Vault secret "${secretRef}" missing field "${field}".`);
    }

    const value = data[field];
    if (value == null || String(value).trim().length === 0) {
      throw new Error(`Vault secret "${secretRef}" field "${field}" is empty.`);
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  throw new Error(`Unsupported SECRETS_BACKEND: ${backend}. Supported: env, vault`);
}

function parseVaultRef(secretRef) {
  const ref = secretRef.trim();
  if (!ref) {
    throw new Error("Vault secret ref is empty.");
  }

  const hashIndex = ref.lastIndexOf("#");
  if (hashIndex > 0 && hashIndex < ref.length - 1) {
    return {
      vaultPath: ref.slice(0, hashIndex),
      field: ref.slice(hashIndex + 1)
    };
  }

  const colonIndex = ref.lastIndexOf(":");
  if (colonIndex > 0 && colonIndex < ref.length - 1 && !ref.includes("://")) {
    return {
      vaultPath: ref.slice(0, colonIndex),
      field: ref.slice(colonIndex + 1)
    };
  }

  return { vaultPath: ref, field: "value" };
}

void main();
