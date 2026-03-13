/**
 * Platform system_settings CRUD — replaces file-based system-settings.json.
 *
 * Each setting stored as a separate row: (tenant_id, setting_group, setting_key, setting_value).
 * Supports typed values (string, number, boolean) stored as text with cast on read.
 */

import { query, getPool } from "../client.mjs";
import { setTenantContext } from "../security.mjs";

const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";

/**
 * Get all settings for a tenant, grouped by setting_group.
 * Returns { callHandling: { KEY: value, ... }, ... }.
 */
export async function getAllSettings(tenantId) {
  const tid = tenantId || DEFAULT_TENANT;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setTenantContext(client, tid);
    const { rows } = await client.query(
      `SELECT setting_group, setting_key, setting_value, value_type
       FROM platform.system_settings
       ORDER BY setting_group, setting_key`
    );
    await client.query("COMMIT");

    // Group into nested object with typed values
    const result = {};
    for (const row of rows) {
      if (!result[row.setting_group]) result[row.setting_group] = {};
      result[row.setting_group][row.setting_key] = castValue(row.setting_value, row.value_type);
    }
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Check if any settings exist for this tenant (used for DB-first vs file fallback).
 */
export async function hasSettings(tenantId) {
  const tid = tenantId || DEFAULT_TENANT;
  const { rows } = await query(
    `SELECT EXISTS(SELECT 1 FROM platform.system_settings WHERE tenant_id = $1) AS has`,
    [tid]
  );
  return rows[0].has;
}

/**
 * Bulk upsert settings from a grouped object.
 * Input shape: { callHandling: { KEY: value, ... }, ... }
 */
export async function bulkUpsertSettings(tenantId, settingsObj, updatedBy = null) {
  const tid = tenantId || DEFAULT_TENANT;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setTenantContext(client, tid);

    for (const [group, entries] of Object.entries(settingsObj)) {
      if (!entries || typeof entries !== "object") continue;
      for (const [key, value] of Object.entries(entries)) {
        const valueType = inferType(value);
        const strValue = String(value);
        await client.query(
          `INSERT INTO platform.system_settings
             (tenant_id, setting_group, setting_key, setting_value, value_type, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, setting_group, setting_key)
           DO UPDATE SET setting_value = $4, value_type = $5, updated_by = $6, updated_at = now()`,
          [tid, group, key, strValue, valueType, updatedBy]
        );
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Delete all settings for a specific group (reset to defaults).
 */
export async function resetGroup(tenantId, group) {
  const tid = tenantId || DEFAULT_TENANT;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setTenantContext(client, tid);
    await client.query(
      `DELETE FROM platform.system_settings WHERE setting_group = $1`,
      [group]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Delete all settings for a tenant (full reset).
 */
export async function resetAll(tenantId) {
  const tid = tenantId || DEFAULT_TENANT;
  await query(
    `DELETE FROM platform.system_settings WHERE tenant_id = $1`,
    [tid]
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function castValue(strValue, valueType) {
  switch (valueType) {
    case "number": return Number(strValue);
    case "boolean": return strValue === "true";
    default: return strValue;
  }
}

function inferType(value) {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
}
