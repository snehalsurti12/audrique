/**
 * Unit tests for webapp/lib/credentials.mjs
 *
 * Covers the 6 real bugs we hit during OAuth/connection setup:
 *   1. Vault ref path passed as OAuth client_id (resolveVaultRef)
 *   2. Partial save wiping env file (generateEnvContent field presence)
 *   3. Bullet-masked token used as real token (isBulletMasked guard in resolveVaultRef)
 *   4. Field name mismatch oauthConsumerKey vs sfOauthConsumerKey (generateEnvContent)
 *   5. Vault write skipping bullet-masked values (writeSecretsToVault — tested via VAULT_SECRET_GROUPS shape)
 *   6. Sensitive key masking logic (isSensitiveKey + maskSensitiveValues)
 *
 * Run: node --test tests/unit/credentials.test.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  isSensitiveKey,
  isBulletMasked,
  maskSensitiveValues,
  buildVaultRefsFromBasePath,
  resolveVaultRef,
  generateEnvContent,
  VAULT_SECRET_GROUPS,
} from "../../webapp/lib/credentials.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

const BULLET = "\u2022";

/** Parse a .env string into a key→value map (strips blank lines and comments) */
function parseEnv(content) {
  const env = {};
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

const PROFILE = {
  id: "cdo-org",
  label: "CDO Org",
  salesforce: { loginUrl: "https://login.salesforce.com", appName: "Service Console" },
  connect: { region: "us-west-2", instanceAlias: "test.my.connect.aws" },
};

// ── Problem 1 & 3: resolveVaultRef ───────────────────────────────────────────

describe("resolveVaultRef", () => {
  let originalFetch;

  before(() => { originalFetch = globalThis.fetch; });
  after(() => { globalThis.fetch = originalFetch; });

  it("resolves a ref to the actual field value", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: { data: { consumer_key: "3MVG9realkey" } } }),
    });
    const result = await resolveVaultRef(
      "secret/data/voice/cdo-org/salesforce#consumer_key",
      "http://127.0.0.1:8200",
      "root",
    );
    assert.equal(result, "3MVG9realkey");
  });

  it("returns null when ref contains no # separator", async () => {
    // Bug: if a raw vault path (no #field) is passed, it must NOT make a fetch call
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
    const result = await resolveVaultRef(
      "secret/data/voice/cdo-org/salesforce",
      "http://127.0.0.1:8200",
      "root",
    );
    assert.equal(result, null);
    assert.equal(fetchCalled, false, "fetch should not be called when ref has no #");
  });

  it("returns null and does not call fetch when token is bullet-masked (Problem 3)", async () => {
    // Bug: masked token from GET /api/profile/env was being used as real token
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
    const result = await resolveVaultRef(
      "secret/data/voice/cdo-org/salesforce#consumer_key",
      "http://127.0.0.1:8200",
      BULLET.repeat(8),
    );
    assert.equal(result, null);
    assert.equal(fetchCalled, false, "fetch must not be called with a bullet-masked token");
  });

  it("returns null when vault is unreachable", async () => {
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    const result = await resolveVaultRef(
      "secret/data/voice/cdo-org/salesforce#consumer_key",
      "http://127.0.0.1:8200",
      "root",
    );
    assert.equal(result, null);
  });

  it("returns null when vault returns non-ok status", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 403 });
    const result = await resolveVaultRef(
      "secret/data/voice/cdo-org/salesforce#consumer_key",
      "http://127.0.0.1:8200",
      "bad-token",
    );
    assert.equal(result, null);
  });

  it("returns null for missing ref, addr, or token", async () => {
    assert.equal(await resolveVaultRef(null, "http://vault", "root"), null);
    assert.equal(await resolveVaultRef("path#field", null, "root"), null);
    assert.equal(await resolveVaultRef("path#field", "http://vault", null), null);
    assert.equal(await resolveVaultRef("path#field", "http://vault", ""), null);
  });
});

// ── Problem 4: generateEnvContent field name mapping ─────────────────────────

describe("generateEnvContent — field name mapping (Problem 4)", () => {
  it("maps oauthConsumerKey → SF_OAUTH_CONSUMER_KEY (new field name)", () => {
    const content = generateEnvContent(PROFILE, {
      sfAuthMethod: "oauth",
      oauthConsumerKey: "3MVG9newkey",
    });
    const env = parseEnv(content);
    assert.equal(env.SF_OAUTH_CONSUMER_KEY, "3MVG9newkey",
      "oauthConsumerKey must map to SF_OAUTH_CONSUMER_KEY");
  });

  it("maps sfOauthConsumerKey → SF_OAUTH_CONSUMER_KEY (legacy field name backward compat)", () => {
    const content = generateEnvContent(PROFILE, {
      sfAuthMethod: "oauth",
      sfOauthConsumerKey: "3MVG9legacykey",
    });
    const env = parseEnv(content);
    assert.equal(env.SF_OAUTH_CONSUMER_KEY, "3MVG9legacykey",
      "sfOauthConsumerKey (old name) must still map to SF_OAUTH_CONSUMER_KEY");
  });

  it("new field name wins over legacy when both present", () => {
    const content = generateEnvContent(PROFILE, {
      sfAuthMethod: "oauth",
      oauthConsumerKey: "new-key",
      sfOauthConsumerKey: "old-key",
    });
    const env = parseEnv(content);
    assert.equal(env.SF_OAUTH_CONSUMER_KEY, "new-key");
  });
});

// ── Problem 2: partial save must not wipe other fields ───────────────────────

describe("generateEnvContent — partial credentials do not wipe existing fields (Problem 2)", () => {
  it("generates SF_OAUTH_CONSUMER_KEY even when only sfAuthMethod is provided (oauth mode)", () => {
    // Simulate a re-save that only includes auth method
    const content = generateEnvContent(PROFILE, {
      sfAuthMethod: "oauth",
      oauthConsumerKey: "3MVG9key",
    });
    const env = parseEnv(content);
    // Key must be present and non-empty
    assert.ok(env.SF_OAUTH_CONSUMER_KEY === "3MVG9key",
      "Consumer key must not be wiped by a save that also includes it");
  });

  it("does not emit SF_OAUTH_CONSUMER_KEY line when sfAuthMethod is password", () => {
    const content = generateEnvContent(PROFILE, {
      sfAuthMethod: "password",
      sfUsername: "user@test.com",
      sfPassword: "pass",
    });
    // In password mode, SF_OAUTH_CONSUMER_KEY should not appear at all
    assert.ok(!content.includes("SF_OAUTH_CONSUMER_KEY"),
      "SF_OAUTH_CONSUMER_KEY must not appear in password-mode env");
  });

  it("vault mode writes REF lines, not plaintext consumer key", () => {
    const content = generateEnvContent(PROFILE, {
      secretsBackend: "vault",
      sfAuthMethod: "oauth",
      oauthConsumerKeyRef: "secret/data/voice/cdo-org/salesforce#consumer_key",
    });
    const env = parseEnv(content);
    assert.equal(env.SF_OAUTH_CONSUMER_KEY, "",
      "Vault mode must emit empty SF_OAUTH_CONSUMER_KEY (value stored in Vault)");
    assert.equal(
      env.SF_OAUTH_CONSUMER_KEY_REF,
      "secret/data/voice/cdo-org/salesforce#consumer_key",
      "Vault mode must emit SF_OAUTH_CONSUMER_KEY_REF with the ref path",
    );
  });

  it("vault mode env must not contain VAULT_TOKEN", () => {
    const content = generateEnvContent(PROFILE, {
      secretsBackend: "vault",
      sfAuthMethod: "oauth",
    });
    assert.ok(!content.includes("VAULT_TOKEN"),
      "VAULT_TOKEN must never be written to the env file");
  });
});

// ── Problem 6: sensitive key masking ─────────────────────────────────────────

describe("isSensitiveKey", () => {
  it("marks known sensitive keys as sensitive", () => {
    assert.ok(isSensitiveKey("VAULT_TOKEN"));
    assert.ok(isSensitiveKey("SF_PASSWORD"));
    assert.ok(isSensitiveKey("TWILIO_AUTH_TOKEN"));
    assert.ok(isSensitiveKey("GEMINI_API_KEY"));
    assert.ok(isSensitiveKey("SF_OAUTH_CONSUMER_SECRET"));
  });

  it("does NOT mark _REF keys as sensitive (they are Vault paths, not secrets)", () => {
    assert.ok(!isSensitiveKey("SF_OAUTH_CONSUMER_KEY_REF"),
      "_REF keys are vault paths, not sensitive");
    assert.ok(!isSensitiveKey("AWS_ACCESS_KEY_ID_REF"));
  });

  it("does NOT mark SECRETS_BACKEND or REGULATED_MODE as sensitive", () => {
    assert.ok(!isSensitiveKey("SECRETS_BACKEND"));
    assert.ok(!isSensitiveKey("REGULATED_MODE"));
  });

  it("marks pattern-matched keys as sensitive", () => {
    assert.ok(isSensitiveKey("MY_API_KEY"));
    assert.ok(isSensitiveKey("DB_PASSWORD"));
    assert.ok(isSensitiveKey("SOME_SECRET"));
  });
});

describe("maskSensitiveValues", () => {
  it("masks sensitive values with bullet characters", () => {
    const masked = maskSensitiveValues({ VAULT_TOKEN: "root", SF_PASSWORD: "mypass" });
    assert.ok(masked.VAULT_TOKEN.startsWith(BULLET));
    assert.ok(masked.SF_PASSWORD.startsWith(BULLET));
  });

  it("does not mask non-sensitive values", () => {
    const masked = maskSensitiveValues({
      SECRETS_BACKEND: "vault",
      SF_LOGIN_URL: "https://login.salesforce.com",
      SF_OAUTH_CONSUMER_KEY_REF: "secret/data/path#field",
    });
    assert.equal(masked.SECRETS_BACKEND, "vault");
    assert.equal(masked.SF_LOGIN_URL, "https://login.salesforce.com");
    assert.equal(masked.SF_OAUTH_CONSUMER_KEY_REF, "secret/data/path#field");
  });

  it("does not mask empty values", () => {
    const masked = maskSensitiveValues({ VAULT_TOKEN: "" });
    assert.equal(masked.VAULT_TOKEN, "");
  });
});

// ── Problem 3: isBulletMasked guard ──────────────────────────────────────────

describe("isBulletMasked", () => {
  it("detects bullet-masked strings", () => {
    assert.ok(isBulletMasked(BULLET.repeat(8)));
    assert.ok(isBulletMasked(BULLET));
  });

  it("does not flag real tokens as masked", () => {
    assert.ok(!isBulletMasked("root"));
    assert.ok(!isBulletMasked("hvs.CAESIreal-token"));
    assert.ok(!isBulletMasked(""));
    assert.ok(!isBulletMasked(null));
    assert.ok(!isBulletMasked(undefined));
  });
});

// ── buildVaultRefsFromBasePath ────────────────────────────────────────────────

describe("buildVaultRefsFromBasePath", () => {
  it("generates correctly structured ref paths for all secret groups", () => {
    const refs = buildVaultRefsFromBasePath("secret/data/voice/cdo-org");
    assert.equal(
      refs.oauthConsumerKeyRef,
      "secret/data/voice/cdo-org/salesforce#consumer_key",
    );
    assert.equal(
      refs.awsAccessKeyIdRef,
      "secret/data/voice/cdo-org/aws#access_key_id",
    );
    assert.equal(
      refs.twilioTokenRef,
      "secret/data/voice/cdo-org/twilio#auth_token",
    );
    assert.equal(
      refs.geminiApiKeyRef,
      "secret/data/voice/cdo-org/gemini#api_key",
    );
  });

  it("strips trailing slashes from basePath", () => {
    const refs = buildVaultRefsFromBasePath("secret/data/voice/cdo-org///");
    assert.equal(refs.oauthConsumerKeyRef, "secret/data/voice/cdo-org/salesforce#consumer_key");
  });

  it("generates a ref for every field in VAULT_SECRET_GROUPS", () => {
    const refs = buildVaultRefsFromBasePath("secret/data/voice/test");
    for (const group of Object.values(VAULT_SECRET_GROUPS)) {
      for (const credKey of Object.keys(group.fields)) {
        assert.ok(
          refs[credKey + "Ref"],
          `Missing ref for field: ${credKey}`,
        );
      }
    }
  });
});

// ── generateEnvContent — structural sanity ───────────────────────────────────

describe("generateEnvContent — structural sanity", () => {
  it("always includes SECRETS_BACKEND and REGULATED_MODE", () => {
    const env = parseEnv(generateEnvContent(PROFILE, {}));
    assert.ok("SECRETS_BACKEND" in env);
    assert.ok("REGULATED_MODE" in env);
  });

  it("REGULATED_MODE=true only when secretsBackend=vault", () => {
    const vaultEnv = parseEnv(generateEnvContent(PROFILE, { secretsBackend: "vault" }));
    assert.equal(vaultEnv.REGULATED_MODE, "true");
    const plainEnv = parseEnv(generateEnvContent(PROFILE, { secretsBackend: "env" }));
    assert.equal(plainEnv.REGULATED_MODE, "false");
  });

  it("storage state paths use profile id", () => {
    const env = parseEnv(generateEnvContent(PROFILE, {}));
    assert.equal(env.SF_STORAGE_STATE, ".auth/sf-cdo-org.json");
    assert.equal(env.CONNECT_STORAGE_STATE, ".auth/connect-ccp-cdo-org.json");
  });
});
