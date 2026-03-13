-- 004-auth-rbac.sql — Self-hosted authentication and role-based access control
-- Invitation-only registration, JWT sessions, bcrypt passwords

-- ── Users ─────────────────────────────────────────────────────────────────
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email           TEXT NOT NULL UNIQUE,
    email_verified  BOOLEAN NOT NULL DEFAULT false,
    password_hash   TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'viewer'
                    CHECK (role IN ('admin', 'builder', 'viewer')),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    invited_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_tenant ON users (tenant_id);
CREATE INDEX idx_users_email ON users (email);

-- ── Email Verification Tokens ─────────────────────────────────────────────
CREATE TABLE email_verification_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_verify_token ON email_verification_tokens (token);
CREATE INDEX idx_email_verify_user ON email_verification_tokens (user_id);

-- ── Refresh Tokens ────────────────────────────────────────────────────────
CREATE TABLE refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    ip_address  INET,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens (token_hash);

-- ── Password Reset Tokens ─────────────────────────────────────────────────
CREATE TABLE password_reset_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_password_reset_token ON password_reset_tokens (token);

-- ── Invitations ───────────────────────────────────────────────────────────
CREATE TABLE invitations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'viewer'
                CHECK (role IN ('admin', 'builder', 'viewer')),
    invited_by  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invitations_token ON invitations (token);
CREATE INDEX idx_invitations_tenant ON invitations (tenant_id);

-- ── Login Attempt Tracking (brute force protection) ───────────────────────
CREATE TABLE login_attempts (
    id          BIGSERIAL PRIMARY KEY,
    email       TEXT NOT NULL,
    ip_address  INET NOT NULL,
    success     BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_login_attempts_email_created ON login_attempts (email, created_at DESC);
CREATE INDEX idx_login_attempts_ip_created ON login_attempts (ip_address, created_at DESC);

-- ── Enable RLS on tenant-scoped tables ────────────────────────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_users ON users
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_invitations ON invitations
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
