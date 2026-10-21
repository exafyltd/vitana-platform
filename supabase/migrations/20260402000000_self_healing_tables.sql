-- Self-Healing System Tables
-- Tracks autonomous self-healing attempts, health snapshots, and system config.

-- ══════════════════════════════════════════════════════════════════
-- 1. self_healing_log — One row per self-healing attempt
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS self_healing_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vtid TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  failure_class TEXT NOT NULL,
  confidence NUMERIC(3,2) NOT NULL,
  diagnosis JSONB NOT NULL DEFAULT '{}'::jsonb,
  spec_hash TEXT,
  outcome TEXT DEFAULT 'pending',
  blast_radius TEXT DEFAULT 'none',
  newly_broken TEXT[] DEFAULT '{}',
  net_health_delta INT DEFAULT 0,
  attempt_number INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ,

  CONSTRAINT valid_outcome CHECK (outcome IN (
    'pending', 'fixed', 'failed', 'rolled_back', 'escalated', 'skipped', 'paused'
  )),
  CONSTRAINT valid_blast_radius CHECK (blast_radius IN ('none', 'contained', 'critical'))
);

CREATE INDEX IF NOT EXISTS idx_self_healing_endpoint ON self_healing_log(endpoint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_self_healing_outcome ON self_healing_log(outcome) WHERE outcome = 'pending';
CREATE INDEX IF NOT EXISTS idx_self_healing_vtid ON self_healing_log(vtid);

-- ══════════════════════════════════════════════════════════════════
-- 2. self_healing_snapshots — Pre/post health snapshots per fix
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS self_healing_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vtid TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('pre_fix', 'post_fix')),
  timestamp TIMESTAMPTZ DEFAULT now(),
  total INT NOT NULL,
  healthy INT NOT NULL,
  endpoints JSONB NOT NULL DEFAULT '[]'::jsonb,
  git_sha TEXT,
  cloud_run_revision TEXT,

  UNIQUE(vtid, phase)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_vtid ON self_healing_snapshots(vtid);

-- ══════════════════════════════════════════════════════════════════
-- 3. system_config — Key-value config store (kill switch, autonomy)
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Default: self-healing enabled at AUTO_FIX_SIMPLE level (3)
INSERT INTO system_config (key, value) VALUES
  ('self_healing_enabled', 'true'::jsonb),
  ('self_healing_autonomy_level', '3'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ══════════════════════════════════════════════════════════════════
-- RLS Policies
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE self_healing_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE self_healing_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_config ENABLE ROW LEVEL SECURITY;

-- Service role has full access
CREATE POLICY "service_role_full_access_healing_log" ON self_healing_log
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_full_access_snapshots" ON self_healing_snapshots
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_full_access_config" ON system_config
  FOR ALL USING (auth.role() = 'service_role');
