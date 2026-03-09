-- 003-error-details.sql — Richer failure diagnostics
-- Captures Playwright error output, supervisor observations, and NL Caller assertion results

-- Error log: Playwright stderr / stdout capturing actual test failure messages
ALTER TABLE scenario_results ADD COLUMN IF NOT EXISTS error_log TEXT;

-- Supervisor observation JSON: queue routing checks, agent offer observations
ALTER TABLE scenario_results ADD COLUMN IF NOT EXISTS supervisor_observation JSONB;
