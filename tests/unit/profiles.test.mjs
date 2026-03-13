/**
 * Unit tests for webapp/lib/profiles.mjs
 *
 * Covers the bug: profiles created via UI were saved to DB, but existing
 * file-based profiles (profiles.json) disappeared because the DB-first
 * read ignored the file entirely once the DB had any data.
 *
 * Rules enforced by these tests:
 *   1. New profiles are saved to the DB (createProfile called)
 *   2. Profiles are read from DB when DB is available (_source: "db")
 *   3. profiles.json is NOT the source of truth when DB has data
 *   4. Migration is a no-op for profiles already in DB
 *   5. Migration imports ALL file profiles not yet in DB
 *   6. Migration errors on one profile don't abort the rest
 *
 * Run: node --test tests/unit/profiles.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { migrateFileProfilesToDb, buildProfileFromDbRow } from "../../webapp/lib/profiles.mjs";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FILE_DATA = {
  defaultInstance: "personal",
  profiles: [
    {
      id: "personal",
      label: "Personal Org",
      customer: "Internal",
      salesforce: { loginUrl: "https://login.salesforce.com", appName: "Service Console" },
      connect: { region: "us-west-2", instanceAlias: "personal.my.connect.aws" },
      vault: { addr: "", basePath: "" },
      discovery: { autoDiscover: true, cacheTtlMinutes: 60 },
      vocabulary: {},
    },
    {
      id: "agentforce-org2",
      label: "Agentforce org2",
      customer: "",
      salesforce: { loginUrl: "https://login.salesforce.com", appName: "Service Console" },
      connect: { region: "us-west-2", instanceAlias: "" },
      vault: { addr: "http://127.0.0.1:8200", basePath: "secret/data/voice/agentforce-org2" },
      discovery: { autoDiscover: true, cacheTtlMinutes: 60 },
      vocabulary: {},
    },
    {
      id: "cdo-org",
      label: "CDO Org",
      customer: "",
      salesforce: { loginUrl: "https://login.salesforce.com", appName: "Service Console" },
      connect: { region: "us-west-2", instanceAlias: "" },
      vault: { addr: "", basePath: "" },
      discovery: { autoDiscover: true, cacheTtlMinutes: 60 },
      vocabulary: {},
    },
  ],
};

const DB_ROW_SAMPLE = {
  profile_slug: "agentforce-org2",
  label: "Agentforce org2",
  customer: "",
  is_default: false,
  sf_login_url: "https://login.salesforce.com",
  sf_app_name: "Service Console",
  sf_auth_method: "oauth",
  sf_instance_url: null,
  connect_region: "us-west-2",
  connect_instance_alias: "",
  vault_addr: "http://127.0.0.1:8200",
  vault_base_path: "secret/data/voice/agentforce-org2",
  discovery_auto: true,
  discovery_cache_ttl: 60,
  vocabulary: {},
};

// ── Problem: profiles.json used when DB has data (the original bug) ──────────

describe("DB-first profile reads — _source must be 'db' (Problem: file used instead of DB)", () => {
  it("buildProfileFromDbRow sets _source: 'db'", () => {
    const profile = buildProfileFromDbRow(DB_ROW_SAMPLE);
    assert.equal(profile._source, "db",
      "Profiles from DB must have _source='db' so we know they came from the database");
  });

  it("buildProfileFromDbRow never sets _source: 'file'", () => {
    const profile = buildProfileFromDbRow(DB_ROW_SAMPLE);
    assert.notEqual(profile._source, "file");
  });

  it("buildProfileFromDbRow maps all required fields correctly", () => {
    const profile = buildProfileFromDbRow(DB_ROW_SAMPLE);
    assert.equal(profile.id, "agentforce-org2");
    assert.equal(profile.label, "Agentforce org2");
    assert.equal(profile.salesforce.loginUrl, "https://login.salesforce.com");
    assert.equal(profile.connect.region, "us-west-2");
    assert.equal(profile.vault.addr, "http://127.0.0.1:8200");
    assert.equal(profile.vault.basePath, "secret/data/voice/agentforce-org2");
    assert.equal(profile.discovery.autoDiscover, true);
    assert.equal(profile.discovery.cacheFile, ".cache/org-vocabulary-agentforce-org2.json");
    assert.equal(profile._authStatus, "configured");
  });

  it("buildProfileFromDbRow handles null/missing optional fields", () => {
    const profile = buildProfileFromDbRow({
      ...DB_ROW_SAMPLE,
      connect_instance_alias: null,
      vault_addr: null,
      vault_base_path: null,
      vocabulary: null,
    });
    assert.equal(profile.connect.instanceAlias, "");
    assert.equal(profile.vault.addr, "");
    assert.equal(profile.vault.basePath, "");
    assert.deepEqual(profile.vocabulary, {});
  });
});

// ── Problem: new profiles must be saved to DB, not just profiles.json ────────

describe("migrateFileProfilesToDb — new profiles saved to DB (Problem: file-only profiles disappeared)", () => {
  it("calls createProfile for each profile not already in DB", async () => {
    const created = [];
    const result = await migrateFileProfilesToDb({
      listProfiles: async () => [], // DB is empty
      createProfile: async (tid, data) => { created.push(data.profileSlug); },
      fileData: FILE_DATA,
      tenantId: "test-tenant",
      log: () => {},
    });

    assert.deepEqual(created.sort(), ["agentforce-org2", "cdo-org", "personal"].sort(),
      "All 3 file profiles must be imported when DB is empty");
    assert.deepEqual(result.migrated.sort(), ["agentforce-org2", "cdo-org", "personal"].sort());
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.errors, []);
  });

  it("skips profiles already in DB — does not call createProfile for them", async () => {
    const created = [];
    // DB already has agentforce-org2 and cdo-org
    const existingInDb = [
      { profile_slug: "agentforce-org2" },
      { profile_slug: "cdo-org" },
    ];

    const result = await migrateFileProfilesToDb({
      listProfiles: async () => existingInDb,
      createProfile: async (tid, data) => { created.push(data.profileSlug); },
      fileData: FILE_DATA,
      tenantId: "test-tenant",
      log: () => {},
    });

    // Only personal (missing from DB) should be created
    assert.deepEqual(created, ["personal"],
      "Only profiles not in DB should be migrated");
    assert.deepEqual(result.migrated, ["personal"]);
    assert.deepEqual(result.skipped.sort(), ["agentforce-org2", "cdo-org"].sort());
  });

  it("is a no-op when all profiles already exist in DB", async () => {
    let createCalled = false;
    const existingInDb = FILE_DATA.profiles.map((p) => ({ profile_slug: p.id }));

    const result = await migrateFileProfilesToDb({
      listProfiles: async () => existingInDb,
      createProfile: async () => { createCalled = true; },
      fileData: FILE_DATA,
      tenantId: "test-tenant",
      log: () => {},
    });

    assert.equal(createCalled, false, "createProfile must not be called when all profiles exist in DB");
    assert.deepEqual(result.migrated, []);
    assert.equal(result.skipped.length, 3);
  });

  it("is a no-op when fileData is empty or null", async () => {
    let createCalled = false;
    const noop = async () => { createCalled = true; };

    await migrateFileProfilesToDb({ listProfiles: async () => [], createProfile: noop, fileData: null, tenantId: "t", log: () => {} });
    await migrateFileProfilesToDb({ listProfiles: async () => [], createProfile: noop, fileData: { profiles: [] }, tenantId: "t", log: () => {} });

    assert.equal(createCalled, false);
  });

  it("maps profile fields correctly when calling createProfile", async () => {
    let capturedData;
    await migrateFileProfilesToDb({
      listProfiles: async () => [],
      createProfile: async (tid, data) => { capturedData = data; },
      fileData: {
        defaultInstance: "personal",
        profiles: [FILE_DATA.profiles[0]], // personal only
      },
      tenantId: "test-tenant",
      log: () => {},
    });

    assert.equal(capturedData.profileSlug, "personal");
    assert.equal(capturedData.label, "Personal Org");
    assert.equal(capturedData.isDefault, true, "personal is the defaultInstance so isDefault must be true");
    assert.equal(capturedData.sfLoginUrl, "https://login.salesforce.com");
    assert.equal(capturedData.connectRegion, "us-west-2");
    assert.equal(capturedData.connectInstanceAlias, "personal.my.connect.aws");
  });

  it("non-default profiles get isDefault: false", async () => {
    const created = [];
    await migrateFileProfilesToDb({
      listProfiles: async () => [],
      createProfile: async (tid, data) => { created.push({ slug: data.profileSlug, isDefault: data.isDefault }); },
      fileData: FILE_DATA,
      tenantId: "test-tenant",
      log: () => {},
    });

    const personal = created.find((c) => c.slug === "personal");
    const cdo = created.find((c) => c.slug === "cdo-org");
    assert.equal(personal.isDefault, true);
    assert.equal(cdo.isDefault, false);
  });
});

// ── Resilience: one bad profile must not abort the rest ──────────────────────

describe("migrateFileProfilesToDb — resilience", () => {
  it("continues migrating remaining profiles when one createProfile call fails", async () => {
    const created = [];
    await migrateFileProfilesToDb({
      listProfiles: async () => [],
      createProfile: async (tid, data) => {
        if (data.profileSlug === "agentforce-org2") throw new Error("DB constraint violation");
        created.push(data.profileSlug);
      },
      fileData: FILE_DATA,
      tenantId: "test-tenant",
      log: () => {},
    });

    // personal and cdo-org should still be created despite agentforce-org2 failing
    assert.ok(created.includes("personal"), "personal must be created even if agentforce-org2 failed");
    assert.ok(created.includes("cdo-org"), "cdo-org must be created even if agentforce-org2 failed");
    assert.ok(!created.includes("agentforce-org2"), "failed profile must not appear in created list");
  });

  it("records errors without throwing", async () => {
    const result = await migrateFileProfilesToDb({
      listProfiles: async () => [],
      createProfile: async () => { throw new Error("connection refused"); },
      fileData: { defaultInstance: "x", profiles: [{ id: "x", label: "X", salesforce: {}, connect: {}, vault: {}, discovery: {}, vocabulary: {} }] },
      tenantId: "test-tenant",
      log: () => {},
    });

    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].includes("connection refused"));
    assert.deepEqual(result.migrated, []);
  });

  it("returns error when listProfiles itself fails", async () => {
    const result = await migrateFileProfilesToDb({
      listProfiles: async () => { throw new Error("DB down"); },
      createProfile: async () => {},
      fileData: FILE_DATA,
      tenantId: "test-tenant",
      log: () => {},
    });

    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].includes("listProfiles failed"));
  });
});
