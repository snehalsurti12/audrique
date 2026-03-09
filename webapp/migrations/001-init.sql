-- 001-init.sql — Audrique test result tracking schema
-- Multi-tenant with shared schema (tenant_id on all tables)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Tenants ────────────────────────────────────────────────────────────────
CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tenants (id, name, slug) VALUES (
    '00000000-0000-0000-0000-000000000001',
    'Default',
    'default'
);

-- ── Suite Runs ─────────────────────────────────────────────────────────────
CREATE TABLE runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    suite_name      TEXT NOT NULL,
    suite_file      TEXT NOT NULL,
    run_dir         TEXT,
    status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'passed', 'failed', 'cancelled')),
    started_at      TIMESTAMPTZ NOT NULL,
    finished_at     TIMESTAMPTZ,
    duration_sec    NUMERIC(10,3),
    stop_on_failure BOOLEAN NOT NULL DEFAULT false,
    dry_run         BOOLEAN NOT NULL DEFAULT false,
    connection_set  TEXT,
    total_scenarios         INTEGER NOT NULL DEFAULT 0,
    passed_scenarios        INTEGER NOT NULL DEFAULT 0,
    failed_scenarios        INTEGER NOT NULL DEFAULT 0,
    skipped_scenarios       INTEGER NOT NULL DEFAULT 0,
    allowed_failure_scenarios INTEGER NOT NULL DEFAULT 0,
    suite_config    JSONB,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_runs_tenant_started ON runs (tenant_id, started_at DESC);
CREATE INDEX idx_runs_tenant_status ON runs (tenant_id, status);
CREATE INDEX idx_runs_tenant_suite ON runs (tenant_id, suite_name);

-- ── Scenario Results ───────────────────────────────────────────────────────
CREATE TABLE scenario_results (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    run_id          UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    scenario_id     TEXT NOT NULL,
    description     TEXT,
    status          TEXT NOT NULL
                    CHECK (status IN ('passed', 'failed', 'skipped', 'allowed_failure', 'dry_run', 'running')),
    reason          TEXT,
    allow_failure   BOOLEAN NOT NULL DEFAULT false,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    duration_sec    NUMERIC(10,3),
    output_dir      TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    applied_env     JSONB DEFAULT '{}',
    call_trigger_mode TEXT,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_scenarios_run ON scenario_results (run_id);
CREATE INDEX idx_scenarios_tenant_status ON scenario_results (tenant_id, status);
CREATE INDEX idx_scenarios_tenant_scenario_id ON scenario_results (tenant_id, scenario_id);
CREATE INDEX idx_scenarios_tenant_scenario_started ON scenario_results (tenant_id, scenario_id, started_at DESC);

-- ── Assertions ─────────────────────────────────────────────────────────────
CREATE TABLE assertions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    scenario_result_id UUID NOT NULL REFERENCES scenario_results(id) ON DELETE CASCADE,
    assertion_type  TEXT NOT NULL,
    passed          BOOLEAN NOT NULL,
    detail          TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_assertions_scenario ON assertions (scenario_result_id);
CREATE INDEX idx_assertions_tenant_type ON assertions (tenant_id, assertion_type, passed);

-- ── Artifacts ──────────────────────────────────────────────────────────────
CREATE TABLE artifacts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    scenario_result_id UUID NOT NULL REFERENCES scenario_results(id) ON DELETE CASCADE,
    artifact_type   TEXT NOT NULL
                    CHECK (artifact_type IN (
                        'salesforce_video', 'ccp_video', 'merged_video',
                        'supervisor_video', 'highlight_reel',
                        'screenshot_failure', 'screenshot_baseline',
                        'timeline', 'transcript', 'recording_audio', 'other'
                    )),
    file_path       TEXT NOT NULL,
    file_name       TEXT,
    file_size_bytes BIGINT,
    mime_type       TEXT,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_artifacts_scenario ON artifacts (scenario_result_id);

-- ── Timeline Events ────────────────────────────────────────────────────────
CREATE TABLE timeline_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    scenario_result_id UUID NOT NULL REFERENCES scenario_results(id) ON DELETE CASCADE,
    event_name      TEXT NOT NULL,
    event_time_ms   BIGINT NOT NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_timeline_scenario ON timeline_events (scenario_result_id);

-- ── NL Caller Transcripts ──────────────────────────────────────────────────
CREATE TABLE transcripts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    scenario_result_id UUID NOT NULL REFERENCES scenario_results(id) ON DELETE CASCADE,
    mode            TEXT NOT NULL,
    persona_name    TEXT,
    persona_context TEXT,
    duration_sec    NUMERIC(10,3),
    total_turns     INTEGER NOT NULL DEFAULT 0,
    caller_turns    INTEGER NOT NULL DEFAULT 0,
    agent_turns     INTEGER NOT NULL DEFAULT 0,
    all_assertions_passed BOOLEAN,
    objective       TEXT,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(scenario_result_id)
);

CREATE INDEX idx_transcripts_scenario ON transcripts (scenario_result_id);

-- ── Transcript Turns ───────────────────────────────────────────────────────
CREATE TABLE transcript_turns (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    transcript_id   UUID NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    speaker         TEXT NOT NULL,
    text            TEXT NOT NULL,
    turn_number     INTEGER NOT NULL,
    timestamp_ms    BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_turns_transcript ON transcript_turns (transcript_id, turn_number);
