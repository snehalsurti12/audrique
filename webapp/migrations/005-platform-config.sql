-- 005-platform-config.sql — Platform configuration tables
-- Moves file-based config (system-settings.json, profiles.json, .env files, .vault-auth.json)
-- into the database for multi-tenant SaaS deployment.
-- All tables live in the "platform" schema to keep them separate from test result tables.

-- ── Schema ──────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS platform;

-- ── System Settings ─────────────────────────────────────────────────────────
-- Replaces instances/system-settings.json
-- Each row = one setting, enabling per-setting audit, typed validation, partial updates.

CREATE TABLE platform.system_settings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    setting_group   TEXT NOT NULL,
    setting_key     TEXT NOT NULL,
    setting_value   TEXT NOT NULL,
    value_type      TEXT NOT NULL DEFAULT 'string'
                    CHECK (value_type IN ('string', 'number', 'boolean')),
    updated_by      UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, setting_group, setting_key)
);

CREATE INDEX idx_platform_settings_tenant ON platform.system_settings (tenant_id);
CREATE INDEX idx_platform_settings_group ON platform.system_settings (tenant_id, setting_group);

-- ── Connection Profiles ─────────────────────────────────────────────────────
-- Replaces instances/profiles.json

CREATE TABLE platform.connection_profiles (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    profile_slug            TEXT NOT NULL,
    label                   TEXT NOT NULL,
    customer                TEXT NOT NULL DEFAULT '',
    is_default              BOOLEAN NOT NULL DEFAULT false,

    -- Salesforce
    sf_login_url            TEXT NOT NULL DEFAULT 'https://login.salesforce.com',
    sf_app_name             TEXT NOT NULL DEFAULT 'Service Console',
    sf_auth_method          TEXT NOT NULL DEFAULT 'credentials'
                            CHECK (sf_auth_method IN ('credentials', 'sso', 'stored-session')),
    sf_instance_url         TEXT,

    -- Amazon Connect
    connect_region          TEXT NOT NULL DEFAULT 'us-west-2',
    connect_instance_alias  TEXT,

    -- Vault
    vault_addr              TEXT,
    vault_base_path         TEXT,

    -- Discovery
    discovery_auto          BOOLEAN NOT NULL DEFAULT true,
    discovery_cache_ttl     INTEGER NOT NULL DEFAULT 60,

    -- Vocabulary (flexible JSONB — same structure as profiles.json vocabulary key)
    vocabulary              JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_by              UUID REFERENCES public.users(id) ON DELETE SET NULL,
    updated_by              UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, profile_slug)
);

CREATE INDEX idx_platform_profiles_tenant ON platform.connection_profiles (tenant_id);
CREATE INDEX idx_platform_profiles_slug ON platform.connection_profiles (tenant_id, profile_slug);

-- ── Connection Credentials ──────────────────────────────────────────────────
-- Replaces instances/<profile>.env files
-- NEVER stores plaintext secrets — only Vault refs or non-sensitive values.

CREATE TABLE platform.connection_credentials (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    profile_id      UUID NOT NULL REFERENCES platform.connection_profiles(id) ON DELETE CASCADE,
    cred_key        TEXT NOT NULL,
    cred_value      TEXT NOT NULL DEFAULT '',
    is_sensitive    BOOLEAN NOT NULL DEFAULT false,
    is_vault_ref    BOOLEAN NOT NULL DEFAULT false,
    updated_by      UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (profile_id, cred_key)
);

CREATE INDEX idx_platform_creds_profile ON platform.connection_credentials (profile_id);
CREATE INDEX idx_platform_creds_tenant ON platform.connection_credentials (tenant_id);

-- ── Vault Tokens ────────────────────────────────────────────────────────────
-- Replaces instances/.vault-auth.json
-- Token encrypted at rest via PLATFORM_ENCRYPTION_KEY env var (AES-256-GCM).

CREATE TABLE platform.vault_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    profile_id      UUID NOT NULL REFERENCES platform.connection_profiles(id) ON DELETE CASCADE,
    encrypted_token TEXT NOT NULL,
    updated_by      UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (profile_id)
);

CREATE INDEX idx_platform_vault_tenant ON platform.vault_tokens (tenant_id);

-- ── Row-Level Security ──────────────────────────────────────────────────────
-- Same pattern as public schema: tenant_id = current_setting('app.current_tenant_id')

ALTER TABLE platform.system_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_platform_settings ON platform.system_settings
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE platform.connection_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_platform_profiles ON platform.connection_profiles
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE platform.connection_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_platform_credentials ON platform.connection_credentials
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE platform.vault_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_platform_vault ON platform.vault_tokens
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
