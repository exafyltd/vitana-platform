-- Testing & QA Module — Supabase Tables
-- Stores test run history, individual test results, and preconfigured test cycles.

-- test_cycles must be created first (referenced by test_runs)
CREATE TABLE IF NOT EXISTS test_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'e2e',
  projects TEXT[] NOT NULL DEFAULT '{}',
  schedule TEXT,
  enabled BOOLEAN DEFAULT true,
  last_run_id UUID,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS test_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL DEFAULT 'e2e',
  status TEXT NOT NULL DEFAULT 'running',
  projects TEXT[] NOT NULL DEFAULT '{}',
  total INT DEFAULT 0,
  passed INT DEFAULT 0,
  failed INT DEFAULT 0,
  skipped INT DEFAULT 0,
  duration_ms INT DEFAULT 0,
  triggered_by TEXT DEFAULT 'manual',
  cycle_id UUID REFERENCES test_cycles(id),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS test_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  test_name TEXT NOT NULL,
  file_path TEXT,
  status TEXT NOT NULL,
  duration_ms INT DEFAULT 0,
  error_message TEXT,
  retry_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Back-reference from test_cycles to test_runs
ALTER TABLE test_cycles ADD CONSTRAINT fk_test_cycles_last_run
  FOREIGN KEY (last_run_id) REFERENCES test_runs(id);

CREATE INDEX IF NOT EXISTS idx_test_runs_type ON test_runs(type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_results_run ON test_results(run_id);
CREATE INDEX IF NOT EXISTS idx_test_cycles_type ON test_cycles(type);

-- Seed default test cycles
INSERT INTO test_cycles (name, type, projects, schedule) VALUES
  ('Daily Smoke', 'e2e', ARRAY['desktop-shared', 'mobile-shared', 'hub-shared'], 'daily'),
  ('Community Full', 'e2e', ARRAY['desktop-community', 'mobile-community'], NULL),
  ('Pre-Deploy Suite', 'e2e', ARRAY['desktop-community', 'desktop-patient', 'desktop-professional', 'desktop-staff', 'desktop-admin', 'desktop-shared', 'mobile-community', 'mobile-patient', 'mobile-professional', 'mobile-staff', 'mobile-admin', 'mobile-shared', 'hub-developer', 'hub-admin', 'hub-staff', 'hub-shared'], NULL)
ON CONFLICT DO NOTHING;
