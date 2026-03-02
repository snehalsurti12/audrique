/**
 * vocabularyLoader.mjs — Loads org vocabulary from suite and profile, maps to env vars.
 *
 * Priority: suite vocabulary > profile salesforce config > defaults.
 * The suite vocabulary is set via Suite Settings in Scenario Studio.
 */

import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = process.cwd();

/**
 * Load vocabulary from a suite file and return env var overrides.
 *
 * @param {Object} suite — Parsed suite JSON (must have .vocabulary)
 * @param {string} profileId — Profile ID for fallback values
 * @returns {{ [key: string]: string }} — env var key/value pairs
 */
export function loadVocabularyEnv(profileId, suite) {
  const env = {};

  // Suite-level vocabulary (set in Suite Settings)
  const sv = suite?.vocabulary || {};

  if (sv.agentApp) {
    env.SF_APP_NAME = sv.agentApp;
  }
  if (sv.supervisorSurface) {
    env.SUPERVISOR_SURFACE_NAME = sv.supervisorSurface;
  }
  if (sv.supervisorAppName) {
    env.SUPERVISOR_APP_NAME = sv.supervisorAppName;
  }
  if (sv.omniStatus) {
    env.OMNI_TARGET_STATUS = sv.omniStatus;
  }
  if (sv.defaultQueue) {
    env.SUPERVISOR_QUEUE_BASIC_NAME = sv.defaultQueue;
  }
  if (sv.supportQueue) {
    env.SUPERVISOR_QUEUE_SUPPORT_NAME = sv.supportQueue;
  }
  if (sv.entryNumber) {
    env.CONNECT_ENTRYPOINT_NUMBER = sv.entryNumber;
  }

  // Fall back to profile salesforce.appName if suite doesn't specify
  if (!env.SF_APP_NAME) {
    const profilesPath = path.resolve(PROJECT_ROOT, "instances", "profiles.json");
    if (fs.existsSync(profilesPath)) {
      const config = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
      const profile = (config.profiles || []).find((p) => p.id === profileId);
      if (profile?.salesforce?.appName) {
        env.SF_APP_NAME = profile.salesforce.appName;
      }
    }
  }

  return env;
}

/**
 * Load global system settings (Advanced Settings) and flatten to env var map.
 * Settings from this file are base-layer defaults — suite/scenario overrides win.
 * CLI env vars (process.env) also win over system settings.
 *
 * @returns {{ [key: string]: string }} — env var key/value pairs
 */
export function loadSystemSettingsEnv() {
  const settingsPath = path.resolve(PROJECT_ROOT, "instances", "system-settings.json");
  if (!fs.existsSync(settingsPath)) return {};

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const env = {};
    for (const group of Object.values(settings)) {
      if (!group || typeof group !== "object") continue;
      for (const [key, value] of Object.entries(group)) {
        // Only inject if not already set via CLI/Docker env (manual override wins)
        if (!process.env[key]) {
          env[key] = String(value);
        }
      }
    }
    return env;
  } catch (err) {
    console.warn(`[vocabularyLoader] Failed to load system settings: ${err.message}`);
    return {};
  }
}
