/**
 * Platform connection profiles, credentials, and vault token CRUD.
 *
 * Replaces file-based:
 *   - instances/profiles.json      → connection_profiles
 *   - instances/<profile>.env      → connection_credentials
 *   - instances/.vault-auth.json   → vault_tokens (encrypted at rest)
 */

import { query, getPool } from "../client.mjs";
import { setTenantContext } from "../security.mjs";
import { encrypt, decrypt } from "./platform-crypto.mjs";

const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";

// ── Connection Profiles ─────────────────────────────────────────────────────

/**
 * List all profiles for a tenant.
 */
export async function listProfiles(tenantId) {
  const tid = tenantId || DEFAULT_TENANT;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setTenantContext(client, tid);
    const { rows } = await client.query(
      `SELECT id, profile_slug, label, customer, is_default,
              sf_login_url, sf_app_name, sf_auth_method, sf_instance_url,
              connect_region, connect_instance_alias,
              vault_addr, vault_base_path,
              discovery_auto, discovery_cache_ttl,
              vocabulary,
              created_at, updated_at
       FROM platform.connection_profiles
       ORDER BY created_at ASC`
    );
    await client.query("COMMIT");
    return rows;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Check if any profiles exist for this tenant (used for DB-first vs file fallback).
 */
export async function hasProfiles(tenantId) {
  const tid = tenantId || DEFAULT_TENANT;
  const { rows } = await query(
    `SELECT EXISTS(SELECT 1 FROM platform.connection_profiles WHERE tenant_id = $1) AS has`,
    [tid]
  );
  return rows[0].has;
}

/**
 * Get a single profile by slug.
 */
export async function getProfileBySlug(tenantId, slug) {
  const tid = tenantId || DEFAULT_TENANT;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setTenantContext(client, tid);
    const { rows } = await client.query(
      `SELECT * FROM platform.connection_profiles WHERE profile_slug = $1`,
      [slug]
    );
    await client.query("COMMIT");
    return rows[0] || null;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Create a new connection profile.
 */
export async function createProfile(tenantId, data, createdBy = null) {
  const tid = tenantId || DEFAULT_TENANT;
  const { rows } = await query(
    `INSERT INTO platform.connection_profiles
       (tenant_id, profile_slug, label, customer, is_default,
        sf_login_url, sf_app_name, sf_auth_method, sf_instance_url,
        connect_region, connect_instance_alias,
        vault_addr, vault_base_path,
        discovery_auto, discovery_cache_ttl,
        vocabulary, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)
     RETURNING id, profile_slug`,
    [
      tid,
      data.profileSlug,
      data.label,
      data.customer || "",
      data.isDefault || false,
      data.sfLoginUrl || "https://login.salesforce.com",
      data.sfAppName || "Service Console",
      data.sfAuthMethod || "credentials",
      data.sfInstanceUrl || null,
      data.connectRegion || "us-west-2",
      data.connectInstanceAlias || null,
      data.vaultAddr || null,
      data.vaultBasePath || null,
      data.discoveryAuto !== false,
      data.discoveryCacheTtl || 60,
      JSON.stringify(data.vocabulary || {}),
      createdBy,
    ]
  );
  return rows[0];
}

/**
 * Update an existing connection profile.
 */
export async function updateProfile(tenantId, slug, data, updatedBy = null) {
  const tid = tenantId || DEFAULT_TENANT;
  const sets = [];
  const params = [];
  let idx = 1;

  const fieldMap = {
    label: "label",
    customer: "customer",
    isDefault: "is_default",
    sfLoginUrl: "sf_login_url",
    sfAppName: "sf_app_name",
    sfAuthMethod: "sf_auth_method",
    sfInstanceUrl: "sf_instance_url",
    connectRegion: "connect_region",
    connectInstanceAlias: "connect_instance_alias",
    vaultAddr: "vault_addr",
    vaultBasePath: "vault_base_path",
    discoveryAuto: "discovery_auto",
    discoveryCacheTtl: "discovery_cache_ttl",
  };

  for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
    if (data[jsKey] !== undefined) {
      sets.push(`${dbCol} = $${idx++}`);
      params.push(data[jsKey]);
    }
  }

  if (data.vocabulary !== undefined) {
    sets.push(`vocabulary = $${idx++}`);
    params.push(JSON.stringify(data.vocabulary));
  }

  if (sets.length === 0) return;

  sets.push(`updated_by = $${idx++}`);
  params.push(updatedBy);
  sets.push(`updated_at = now()`);

  params.push(tid, slug);
  await query(
    `UPDATE platform.connection_profiles
     SET ${sets.join(", ")}
     WHERE tenant_id = $${idx++} AND profile_slug = $${idx}`,
    params
  );
}

/**
 * Delete a profile and cascade to credentials + vault tokens.
 */
export async function deleteProfile(tenantId, slug) {
  const tid = tenantId || DEFAULT_TENANT;
  const { rowCount } = await query(
    `DELETE FROM platform.connection_profiles WHERE tenant_id = $1 AND profile_slug = $2`,
    [tid, slug]
  );
  return rowCount > 0;
}

// ── Connection Credentials ──────────────────────────────────────────────────

/**
 * Get all credentials for a profile. Sensitive values are masked.
 */
export async function getCredentials(tenantId, profileId, unmask = false) {
  const tid = tenantId || DEFAULT_TENANT;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setTenantContext(client, tid);
    const { rows } = await client.query(
      `SELECT id, cred_key, cred_value, is_sensitive, is_vault_ref, updated_at
       FROM platform.connection_credentials
       WHERE profile_id = $1
       ORDER BY cred_key`,
      [profileId]
    );
    await client.query("COMMIT");

    if (!unmask) {
      for (const row of rows) {
        if (row.is_sensitive && !row.is_vault_ref) {
          row.cred_value = "••••••••";
        }
      }
    }
    return rows;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Upsert credentials for a profile. Accepts array of { key, value, isSensitive, isVaultRef }.
 */
export async function upsertCredentials(tenantId, profileId, credentials, updatedBy = null) {
  const tid = tenantId || DEFAULT_TENANT;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setTenantContext(client, tid);

    for (const cred of credentials) {
      // Skip masked values (don't overwrite existing secrets with mask string)
      if (cred.value === "••••••••") continue;

      await client.query(
        `INSERT INTO platform.connection_credentials
           (tenant_id, profile_id, cred_key, cred_value, is_sensitive, is_vault_ref, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (profile_id, cred_key)
         DO UPDATE SET cred_value = $4, is_sensitive = $5, is_vault_ref = $6,
                       updated_by = $7, updated_at = now()`,
        [tid, profileId, cred.key, cred.value, cred.isSensitive || false, cred.isVaultRef || false, updatedBy]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ── Vault Tokens ────────────────────────────────────────────────────────────

/**
 * Get the vault token for a profile (decrypted).
 */
export async function getVaultToken(tenantId, profileId) {
  const tid = tenantId || DEFAULT_TENANT;
  const { rows } = await query(
    `SELECT encrypted_token FROM platform.vault_tokens
     WHERE tenant_id = $1 AND profile_id = $2`,
    [tid, profileId]
  );
  if (!rows[0]) return null;
  return decrypt(rows[0].encrypted_token);
}

/**
 * Set (upsert) the vault token for a profile (encrypted at rest).
 */
export async function setVaultToken(tenantId, profileId, plainToken, updatedBy = null) {
  const tid = tenantId || DEFAULT_TENANT;
  const encryptedToken = encrypt(plainToken);

  await query(
    `INSERT INTO platform.vault_tokens (tenant_id, profile_id, encrypted_token, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (profile_id)
     DO UPDATE SET encrypted_token = $3, updated_by = $4, updated_at = now()`,
    [tid, profileId, encryptedToken, updatedBy]
  );
}

/**
 * Delete the vault token for a profile.
 */
export async function deleteVaultToken(tenantId, profileId) {
  await query(
    `DELETE FROM platform.vault_tokens WHERE tenant_id = $1 AND profile_id = $2`,
    [tenantId || DEFAULT_TENANT, profileId]
  );
}
