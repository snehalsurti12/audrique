/**
 * Pure profile migration and conversion helpers.
 * DB calls are injected as dependencies so this module is unit-testable.
 */

/**
 * Convert a DB row (from platform.connection_profiles) to the profile shape
 * the rest of the app expects.
 */
export function buildProfileFromDbRow(row) {
  return {
    id: row.profile_slug,
    label: row.label,
    customer: row.customer,
    _isDefault: row.is_default,
    _source: "db",
    salesforce: {
      loginUrl: row.sf_login_url,
      appName: row.sf_app_name,
    },
    connect: {
      region: row.connect_region,
      instanceAlias: row.connect_instance_alias || "",
    },
    vault: {
      addr: row.vault_addr || "",
      basePath: row.vault_base_path || "",
    },
    discovery: {
      autoDiscover: row.discovery_auto,
      cacheFile: `.cache/org-vocabulary-${row.profile_slug}.json`,
      cacheTtlMinutes: row.discovery_cache_ttl,
    },
    vocabulary: row.vocabulary || {},
    _authStatus: "configured",
  };
}

/**
 * One-time migration: import any profiles from profiles.json that are not
 * already in the DB.
 *
 * Dependencies are injected so this function is fully unit-testable without
 * a real database connection.
 *
 * @param {object} deps
 * @param {Function} deps.listProfiles  - async (tenantId) => DB row[]
 * @param {Function} deps.createProfile - async (tenantId, data) => void
 * @param {object}   deps.fileData      - parsed profiles.json { defaultInstance, profiles[] }
 * @param {string}   deps.tenantId
 * @param {Function} [deps.log]         - optional logger (defaults to console.log)
 * @returns {{ migrated: string[], skipped: string[], errors: string[] }}
 */
export async function migrateFileProfilesToDb({ listProfiles, createProfile, fileData, tenantId, log = console.log }) {
  const result = { migrated: [], skipped: [], errors: [] };

  if (!fileData?.profiles?.length) return result;

  let existing;
  try {
    existing = await listProfiles(tenantId);
  } catch (err) {
    result.errors.push(`listProfiles failed: ${err.message}`);
    return result;
  }

  const existingSlugs = new Set(existing.map((r) => r.profile_slug));

  for (const fp of fileData.profiles) {
    if (existingSlugs.has(fp.id)) {
      result.skipped.push(fp.id);
      continue;
    }
    try {
      await createProfile(tenantId, {
        profileSlug: fp.id,
        label: fp.label,
        customer: fp.customer || "",
        isDefault: fileData.defaultInstance === fp.id,
        sfLoginUrl: fp.salesforce?.loginUrl || "https://login.salesforce.com",
        sfAppName: fp.salesforce?.appName || "Service Console",
        connectRegion: fp.connect?.region || "us-west-2",
        connectInstanceAlias: fp.connect?.instanceAlias || "",
        vaultAddr: fp.vault?.addr || "",
        vaultBasePath: fp.vault?.basePath || "",
        discoveryAuto: fp.discovery?.autoDiscover !== false,
        discoveryCacheTtl: fp.discovery?.cacheTtlMinutes || 60,
        vocabulary: fp.vocabulary || {},
      });
      log(`[migrate] Imported profile from file: ${fp.id}`);
      result.migrated.push(fp.id);
    } catch (err) {
      result.errors.push(`${fp.id}: ${err.message}`);
    }
  }

  return result;
}
