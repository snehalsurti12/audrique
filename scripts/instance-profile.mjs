import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const PROFILES_PATH = path.resolve(process.cwd(), "instances", "profiles.json");
const ACTIVE_PROFILE_PATH = path.resolve(process.cwd(), ".instance-profile");

async function main() {
  const command = (process.argv[2] || "list").trim().toLowerCase();
  const config = readProfilesConfig();

  if (command === "list") {
    printProfiles(config);
    return;
  }

  if (command === "current") {
    const active = resolveActiveProfile(config).id;
    console.log(active);
    return;
  }

  if (command === "use") {
    const maybeId = process.argv[3]?.trim();
    const targetId = maybeId || (await promptForProfile(config));
    const profile = config.profiles.find((entry) => entry.id === targetId);
    if (!profile) {
      throw new Error(
        `Unknown profile "${targetId}". Available: ${config.profiles.map((entry) => entry.id).join(", ")}`
      );
    }

    fs.writeFileSync(ACTIVE_PROFILE_PATH, `${targetId}\n`, "utf8");
    console.log(`Selected profile: ${targetId}`);
    return;
  }

  throw new Error("Usage: node scripts/instance-profile.mjs [list|current|use <id>]");
}

function readProfilesConfig() {
  if (!fs.existsSync(PROFILES_PATH)) {
    throw new Error(`Missing profiles config: ${PROFILES_PATH}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to parse ${PROFILES_PATH}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const profiles = Array.isArray(parsed?.profiles)
    ? parsed.profiles
        .map((profile) => normalizeProfile(profile))
        .filter((profile) => profile != null)
    : [];

  if (profiles.length === 0) {
    throw new Error(`No profiles found in ${PROFILES_PATH}`);
  }

  const defaultInstance =
    typeof parsed?.defaultInstance === "string" ? parsed.defaultInstance.trim() : "";
  return { profiles, defaultInstance };
}

function normalizeProfile(profile) {
  if (!profile || typeof profile !== "object") {
    return null;
  }

  const id = typeof profile.id === "string" ? profile.id.trim() : "";
  if (!id) {
    return null;
  }

  const label = typeof profile.label === "string" && profile.label.trim() ? profile.label.trim() : id;
  const customer =
    typeof profile.customer === "string" && profile.customer.trim() ? profile.customer.trim() : "";
  const envFile =
    typeof profile.envFile === "string" && profile.envFile.trim()
      ? profile.envFile.trim()
      : `instances/${id}.env`;

  return { id, label, customer, envFile };
}

function resolveActiveProfile(config) {
  const fromSelection = readActiveProfileSelection();
  if (fromSelection && config.profiles.some((profile) => profile.id === fromSelection)) {
    return { id: fromSelection, source: ".instance-profile" };
  }

  if (config.defaultInstance && config.profiles.some((profile) => profile.id === config.defaultInstance)) {
    return { id: config.defaultInstance, source: "profiles.defaultInstance" };
  }

  return { id: config.profiles[0].id, source: "profiles[0]" };
}

function readActiveProfileSelection() {
  if (!fs.existsSync(ACTIVE_PROFILE_PATH)) {
    return "";
  }
  return fs.readFileSync(ACTIVE_PROFILE_PATH, "utf8").trim();
}

function printProfiles(config) {
  const active = resolveActiveProfile(config);
  console.log(`Active profile: ${active.id} (${active.source})`);

  for (const profile of config.profiles) {
    const marker = profile.id === active.id ? "*" : " ";
    const envPath = path.resolve(process.cwd(), profile.envFile);
    const envStatus = fs.existsSync(envPath) ? "ok" : "missing";
    const customerSuffix = profile.customer ? ` | customer: ${profile.customer}` : "";
    console.log(
      `${marker} ${profile.id} | ${profile.label}${customerSuffix} | env: ${profile.envFile} (${envStatus})`
    );
  }
}

async function promptForProfile(config) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive selection needs a TTY. Use: npm run instance:use -- <profile-id>");
  }

  console.log("Select profile:");
  config.profiles.forEach((profile, index) => {
    console.log(`${index + 1}) ${profile.id} - ${profile.label}`);
  });

  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question("Enter number: ")).trim();
    const index = Number.parseInt(answer, 10);
    if (!Number.isInteger(index) || index < 1 || index > config.profiles.length) {
      throw new Error("Invalid selection.");
    }
    return config.profiles[index - 1].id;
  } finally {
    rl.close();
  }
}

void main();
