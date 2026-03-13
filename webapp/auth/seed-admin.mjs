#!/usr/bin/env node
/**
 * Seed the first admin user — CLI tool for bootstrapping.
 *
 * Usage:
 *   node webapp/auth/seed-admin.mjs --email admin@company.com --password SecurePass123 --name "Admin User"
 *
 * Requires DATABASE_URL to be set. Creates the admin user + tenant directly.
 */

import { initPool, query, shutdown } from "../db/client.mjs";
import { runMigrations } from "../db/migrate.mjs";
import { hashPassword, validatePasswordStrength } from "./password.mjs";
import { getUserByEmail } from "../db/queries/users.mjs";

// ── Parse CLI args ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const email = getArg("--email");
const password = getArg("--password");
const displayName = getArg("--name") || "Admin";

if (!email || !password) {
  console.error("Usage: node webapp/auth/seed-admin.mjs --email <email> --password <password> [--name <name>]");
  process.exit(1);
}

const pwError = validatePasswordStrength(password);
if (pwError) {
  console.error(`Password error: ${pwError}`);
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await initPool();
  await runMigrations();

  // Check if user already exists
  const existing = await getUserByEmail(email);
  if (existing) {
    console.error(`User with email ${email} already exists (role: ${existing.role})`);
    process.exit(1);
  }

  // Create tenant from email domain
  const domain = email.split("@")[1];
  const tenantName = domain.split(".")[0].charAt(0).toUpperCase() + domain.split(".")[0].slice(1);
  const tenantSlug = domain.split(".")[0].toLowerCase();

  // Check if tenant already exists with this slug
  const { rows: existingTenants } = await query(
    `SELECT id FROM tenants WHERE slug = $1`,
    [tenantSlug]
  );

  let tenantId;
  if (existingTenants.length > 0) {
    tenantId = existingTenants[0].id;
    console.log(`Using existing tenant: ${tenantName} (${tenantId})`);
  } else {
    const { rows: newTenant } = await query(
      `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [tenantName, tenantSlug]
    );
    tenantId = newTenant[0].id;
    console.log(`Created tenant: ${tenantName} (${tenantId})`);
  }

  // Create admin user
  const passwordHash = await hashPassword(password);
  const { rows } = await query(
    `INSERT INTO users (tenant_id, email, password_hash, display_name, role, email_verified, is_active)
     VALUES ($1, $2, $3, $4, 'admin', true, true)
     RETURNING id, email, role`,
    [tenantId, email.toLowerCase().trim(), passwordHash, displayName.trim()]
  );

  const user = rows[0];
  console.log(`\nAdmin user created:`);
  console.log(`  ID:    ${user.id}`);
  console.log(`  Email: ${user.email}`);
  console.log(`  Role:  ${user.role}`);
  console.log(`  Tenant: ${tenantId}`);
  console.log(`\nYou can now log in at the Studio.`);

  await shutdown();
}

main().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
