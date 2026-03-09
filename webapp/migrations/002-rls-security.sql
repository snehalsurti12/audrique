-- 002-rls-security.sql — Row-Level Security + audit trail
-- Enterprise-grade data isolation for multi-tenant deployments

-- ── Row-Level Security ───────────────────────────────────────────────────────
-- Ensures tenants can only access their own data at the database level,
-- even if application code has a bug. Defense-in-depth.

-- Enable RLS on all tenant-scoped tables
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE assertions ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE timeline_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcript_turns ENABLE ROW LEVEL SECURITY;

-- RLS policies: restrict access to rows matching current tenant
-- The app sets the tenant via: SET app.current_tenant_id = '<uuid>';
-- Superuser/owner bypasses RLS by default (for migrations, admin tasks)

CREATE POLICY tenant_isolation_runs ON runs
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_scenario_results ON scenario_results
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_assertions ON assertions
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_artifacts ON artifacts
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_timeline_events ON timeline_events
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_transcripts ON transcripts
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_transcript_turns ON transcript_turns
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ── Audit Trail ──────────────────────────────────────────────────────────────
-- Track data access and modifications for compliance and debugging

CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID,
    action          TEXT NOT NULL,
    resource_type   TEXT NOT NULL,
    resource_id     UUID,
    actor           TEXT,
    ip_address      INET,
    details         JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_tenant_created ON audit_log (tenant_id, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_log (resource_type, resource_id);
CREATE INDEX idx_audit_action ON audit_log (action, created_at DESC);

-- Auto-purge old audit entries (retention: 90 days)
-- Run via pg_cron or application-level scheduled task:
--   DELETE FROM audit_log WHERE created_at < now() - INTERVAL '90 days';

-- ── Run deduplication ────────────────────────────────────────────────────────
-- Prevent re-ingesting the same suite-summary.json run directory
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_tenant_rundir
    ON runs (tenant_id, run_dir)
    WHERE run_dir IS NOT NULL;
