-- =============================================================================
-- VTID-01185: Autopilot Recommendation Engine
-- =============================================================================
-- Adds infrastructure for dynamic recommendation generation from 4 analyzers:
-- 1. Codebase Analyzer (TODOs, large files, missing tests, vulnerabilities)
-- 2. OASIS Event Analyzer (error patterns, slow endpoints, failed deploys)
-- 3. System Health Analyzer (missing indexes, stale migrations, RLS gaps)
-- 4. Roadmap Analyzer (unimplemented specs, stalled VTIDs, GitHub issues)
-- =============================================================================

-- =============================================================================
-- Step 1: Recommendation Generation Runs Table
-- =============================================================================
CREATE TABLE IF NOT EXISTS autopilot_recommendation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT UNIQUE NOT NULL,  -- e.g., "rec-gen-2026-01-17-001"

  -- Status tracking
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  -- Configuration
  sources TEXT[] NOT NULL DEFAULT '{}',  -- ['codebase', 'oasis', 'health', 'roadmap']
  trigger_type TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('manual', 'scheduled', 'pr_merge', 'webhook')),
  triggered_by TEXT,  -- user_id or 'scheduler' or 'github-webhook'

  -- Results
  recommendations_generated INTEGER DEFAULT 0,
  duplicates_skipped INTEGER DEFAULT 0,
  errors_count INTEGER DEFAULT 0,
  errors JSONB DEFAULT '[]',

  -- Performance
  duration_ms INTEGER,

  -- Analysis summary
  analysis_summary JSONB DEFAULT '{}',  -- Per-source summary stats

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_autopilot_recommendation_runs_status
  ON autopilot_recommendation_runs(status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_autopilot_recommendation_runs_run_id
  ON autopilot_recommendation_runs(run_id);

-- =============================================================================
-- Step 2: Analyzer Sources Status Table
-- =============================================================================
CREATE TABLE IF NOT EXISTS autopilot_analyzer_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT UNIQUE NOT NULL CHECK (source_type IN ('codebase', 'oasis', 'health', 'roadmap')),

  -- Status
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'scanning', 'ready', 'error')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,

  -- Last scan info
  last_scan_at TIMESTAMPTZ,
  last_scan_run_id TEXT,
  last_scan_duration_ms INTEGER,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,

  -- Scan stats
  items_scanned INTEGER DEFAULT 0,
  items_found INTEGER DEFAULT 0,
  recommendations_generated INTEGER DEFAULT 0,

  -- Configuration
  config JSONB DEFAULT '{}',  -- Source-specific config

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed initial analyzer sources
INSERT INTO autopilot_analyzer_sources (source_type, status, config) VALUES
  ('codebase', 'idle', '{"scan_paths": ["services/", "prisma/", "supabase/"], "exclude_paths": ["node_modules/", "dist/", ".git/"], "file_size_threshold_lines": 1000}'),
  ('oasis', 'idle', '{"lookback_hours": 24, "error_threshold": 10, "slow_endpoint_ms": 2000}'),
  ('health', 'idle', '{"check_indexes": true, "check_rls": true, "check_migrations": true}'),
  ('roadmap', 'idle', '{"spec_paths": ["docs/specs/"], "stale_days": 30}')
ON CONFLICT (source_type) DO UPDATE SET
  config = EXCLUDED.config,
  updated_at = NOW();

-- =============================================================================
-- Step 3: Add Source Tracking Columns to Recommendations
-- =============================================================================
ALTER TABLE autopilot_recommendations ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE autopilot_recommendations ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE autopilot_recommendations ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE autopilot_recommendations ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE autopilot_recommendations ADD COLUMN IF NOT EXISTS suggested_files TEXT[] DEFAULT '{}';
ALTER TABLE autopilot_recommendations ADD COLUMN IF NOT EXISTS suggested_endpoints TEXT[] DEFAULT '{}';
ALTER TABLE autopilot_recommendations ADD COLUMN IF NOT EXISTS suggested_tests TEXT[] DEFAULT '{}';
ALTER TABLE autopilot_recommendations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Index for deduplication
CREATE INDEX IF NOT EXISTS idx_autopilot_recommendations_fingerprint
  ON autopilot_recommendations(fingerprint)
  WHERE fingerprint IS NOT NULL;

-- Index for source filtering
CREATE INDEX IF NOT EXISTS idx_autopilot_recommendations_source
  ON autopilot_recommendations(source_type, created_at DESC)
  WHERE source_type IS NOT NULL;

-- Index for run tracking
CREATE INDEX IF NOT EXISTS idx_autopilot_recommendations_run_id
  ON autopilot_recommendations(run_id)
  WHERE run_id IS NOT NULL;

-- Index for expiration cleanup
CREATE INDEX IF NOT EXISTS idx_autopilot_recommendations_expires
  ON autopilot_recommendations(expires_at)
  WHERE expires_at IS NOT NULL;

-- =============================================================================
-- Step 4: Get Analyzer Sources Function
-- =============================================================================
CREATE OR REPLACE FUNCTION get_autopilot_analyzer_sources()
RETURNS TABLE (
  source_type TEXT,
  status TEXT,
  enabled BOOLEAN,
  last_scan_at TIMESTAMPTZ,
  last_scan_duration_ms INTEGER,
  items_scanned INTEGER,
  items_found INTEGER,
  recommendations_generated INTEGER,
  last_error TEXT,
  config JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.source_type,
    s.status,
    s.enabled,
    s.last_scan_at,
    s.last_scan_duration_ms,
    s.items_scanned,
    s.items_found,
    s.recommendations_generated,
    s.last_error,
    s.config
  FROM autopilot_analyzer_sources s
  ORDER BY s.source_type;
END;
$$;

-- =============================================================================
-- Step 5: Update Analyzer Source Status Function
-- =============================================================================
CREATE OR REPLACE FUNCTION update_autopilot_analyzer_source(
  p_source_type TEXT,
  p_status TEXT DEFAULT NULL,
  p_items_scanned INTEGER DEFAULT NULL,
  p_items_found INTEGER DEFAULT NULL,
  p_recommendations_generated INTEGER DEFAULT NULL,
  p_last_scan_run_id TEXT DEFAULT NULL,
  p_last_scan_duration_ms INTEGER DEFAULT NULL,
  p_last_error TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_source RECORD;
BEGIN
  SELECT * INTO v_source
  FROM autopilot_analyzer_sources
  WHERE source_type = p_source_type
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Source not found');
  END IF;

  UPDATE autopilot_analyzer_sources
  SET
    status = COALESCE(p_status, status),
    items_scanned = COALESCE(p_items_scanned, items_scanned),
    items_found = COALESCE(p_items_found, items_found),
    recommendations_generated = COALESCE(p_recommendations_generated, recommendations_generated),
    last_scan_run_id = COALESCE(p_last_scan_run_id, last_scan_run_id),
    last_scan_duration_ms = COALESCE(p_last_scan_duration_ms, last_scan_duration_ms),
    last_scan_at = CASE WHEN p_status = 'ready' THEN NOW() ELSE last_scan_at END,
    last_error = p_last_error,
    last_error_at = CASE WHEN p_last_error IS NOT NULL THEN NOW() ELSE last_error_at END,
    updated_at = NOW()
  WHERE source_type = p_source_type;

  RETURN jsonb_build_object('ok', true, 'source_type', p_source_type);
END;
$$;

-- =============================================================================
-- Step 6: Create Recommendation Run Function
-- =============================================================================
CREATE OR REPLACE FUNCTION create_autopilot_recommendation_run(
  p_sources TEXT[],
  p_trigger_type TEXT DEFAULT 'manual',
  p_triggered_by TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_run_id TEXT;
  v_id UUID;
BEGIN
  -- Generate run ID: rec-gen-YYYY-MM-DD-NNN
  v_run_id := 'rec-gen-' || TO_CHAR(NOW(), 'YYYY-MM-DD') || '-' || LPAD(
    (SELECT COALESCE(MAX(SUBSTRING(run_id FROM '-(\d+)$')::INTEGER), 0) + 1
     FROM autopilot_recommendation_runs
     WHERE run_id LIKE 'rec-gen-' || TO_CHAR(NOW(), 'YYYY-MM-DD') || '-%')::TEXT,
    3, '0'
  );

  INSERT INTO autopilot_recommendation_runs (
    run_id,
    sources,
    trigger_type,
    triggered_by,
    status
  ) VALUES (
    v_run_id,
    p_sources,
    p_trigger_type,
    p_triggered_by,
    'running'
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'ok', true,
    'run_id', v_run_id,
    'id', v_id,
    'sources', p_sources,
    'trigger_type', p_trigger_type
  );
END;
$$;

-- =============================================================================
-- Step 7: Complete Recommendation Run Function
-- =============================================================================
CREATE OR REPLACE FUNCTION complete_autopilot_recommendation_run(
  p_run_id TEXT,
  p_status TEXT,
  p_recommendations_generated INTEGER DEFAULT 0,
  p_duplicates_skipped INTEGER DEFAULT 0,
  p_errors JSONB DEFAULT '[]',
  p_analysis_summary JSONB DEFAULT '{}'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_run RECORD;
  v_duration_ms INTEGER;
BEGIN
  SELECT * INTO v_run
  FROM autopilot_recommendation_runs
  WHERE run_id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Run not found');
  END IF;

  v_duration_ms := EXTRACT(MILLISECONDS FROM NOW() - v_run.started_at)::INTEGER;

  UPDATE autopilot_recommendation_runs
  SET
    status = p_status,
    completed_at = NOW(),
    recommendations_generated = p_recommendations_generated,
    duplicates_skipped = p_duplicates_skipped,
    errors_count = jsonb_array_length(p_errors),
    errors = p_errors,
    duration_ms = v_duration_ms,
    analysis_summary = p_analysis_summary
  WHERE run_id = p_run_id;

  RETURN jsonb_build_object(
    'ok', true,
    'run_id', p_run_id,
    'status', p_status,
    'recommendations_generated', p_recommendations_generated,
    'duplicates_skipped', p_duplicates_skipped,
    'duration_ms', v_duration_ms
  );
END;
$$;

-- =============================================================================
-- Step 8: Get Recommendation History Function
-- =============================================================================
CREATE OR REPLACE FUNCTION get_autopilot_recommendation_history(
  p_limit INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0,
  p_trigger_type TEXT DEFAULT NULL
)
RETURNS TABLE (
  run_id TEXT,
  status TEXT,
  trigger_type TEXT,
  triggered_by TEXT,
  sources TEXT[],
  recommendations_generated INTEGER,
  duplicates_skipped INTEGER,
  errors_count INTEGER,
  duration_ms INTEGER,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  analysis_summary JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    r.run_id,
    r.status,
    r.trigger_type,
    r.triggered_by,
    r.sources,
    r.recommendations_generated,
    r.duplicates_skipped,
    r.errors_count,
    r.duration_ms,
    r.started_at,
    r.completed_at,
    r.analysis_summary
  FROM autopilot_recommendation_runs r
  WHERE (p_trigger_type IS NULL OR r.trigger_type = p_trigger_type)
  ORDER BY r.started_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- =============================================================================
-- Step 9: Insert Recommendation with Deduplication Function
-- =============================================================================
CREATE OR REPLACE FUNCTION insert_autopilot_recommendation(
  p_title TEXT,
  p_summary TEXT,
  p_domain TEXT,
  p_risk_level TEXT,
  p_impact_score INTEGER,
  p_effort_score INTEGER,
  p_source_type TEXT,
  p_source_ref TEXT,
  p_fingerprint TEXT,
  p_run_id TEXT,
  p_suggested_files TEXT[] DEFAULT '{}',
  p_suggested_endpoints TEXT[] DEFAULT '{}',
  p_suggested_tests TEXT[] DEFAULT '{}',
  p_expires_days INTEGER DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_existing RECORD;
  v_id UUID;
BEGIN
  -- Check for duplicate by fingerprint
  SELECT * INTO v_existing
  FROM autopilot_recommendations
  WHERE fingerprint = p_fingerprint
    AND status IN ('new', 'snoozed')
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'existing_id', v_existing.id,
      'existing_status', v_existing.status
    );
  END IF;

  -- Insert new recommendation
  INSERT INTO autopilot_recommendations (
    title,
    summary,
    domain,
    risk_level,
    impact_score,
    effort_score,
    source_type,
    source_ref,
    fingerprint,
    run_id,
    suggested_files,
    suggested_endpoints,
    suggested_tests,
    expires_at,
    status
  ) VALUES (
    p_title,
    p_summary,
    p_domain,
    p_risk_level,
    p_impact_score,
    p_effort_score,
    p_source_type,
    p_source_ref,
    p_fingerprint,
    p_run_id,
    p_suggested_files,
    p_suggested_endpoints,
    p_suggested_tests,
    NOW() + (p_expires_days || ' days')::INTERVAL,
    'new'
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'id', v_id
  );
END;
$$;

-- =============================================================================
-- Step 10: Cleanup Expired Recommendations Function
-- =============================================================================
CREATE OR REPLACE FUNCTION cleanup_expired_autopilot_recommendations()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM autopilot_recommendations
  WHERE expires_at < NOW()
    AND status = 'new';

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'deleted', v_deleted
  );
END;
$$;

-- =============================================================================
-- Step 11: RLS Policies
-- =============================================================================
ALTER TABLE autopilot_recommendation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_analyzer_sources ENABLE ROW LEVEL SECURITY;

-- Service role has full access
DROP POLICY IF EXISTS autopilot_recommendation_runs_service_role ON autopilot_recommendation_runs;
CREATE POLICY autopilot_recommendation_runs_service_role
  ON autopilot_recommendation_runs FOR ALL
  TO service_role
  USING (true);

DROP POLICY IF EXISTS autopilot_analyzer_sources_service_role ON autopilot_analyzer_sources;
CREATE POLICY autopilot_analyzer_sources_service_role
  ON autopilot_analyzer_sources FOR ALL
  TO service_role
  USING (true);

-- Authenticated users can read
DROP POLICY IF EXISTS autopilot_recommendation_runs_read ON autopilot_recommendation_runs;
CREATE POLICY autopilot_recommendation_runs_read
  ON autopilot_recommendation_runs FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS autopilot_analyzer_sources_read ON autopilot_analyzer_sources;
CREATE POLICY autopilot_analyzer_sources_read
  ON autopilot_analyzer_sources FOR SELECT
  TO authenticated
  USING (true);

-- =============================================================================
-- Step 12: Grants
-- =============================================================================
GRANT ALL ON autopilot_recommendation_runs TO service_role;
GRANT SELECT ON autopilot_recommendation_runs TO authenticated;

GRANT ALL ON autopilot_analyzer_sources TO service_role;
GRANT SELECT ON autopilot_analyzer_sources TO authenticated;

GRANT EXECUTE ON FUNCTION get_autopilot_analyzer_sources TO service_role;
GRANT EXECUTE ON FUNCTION get_autopilot_analyzer_sources TO authenticated;
GRANT EXECUTE ON FUNCTION update_autopilot_analyzer_source TO service_role;
GRANT EXECUTE ON FUNCTION create_autopilot_recommendation_run TO service_role;
GRANT EXECUTE ON FUNCTION complete_autopilot_recommendation_run TO service_role;
GRANT EXECUTE ON FUNCTION get_autopilot_recommendation_history TO service_role;
GRANT EXECUTE ON FUNCTION get_autopilot_recommendation_history TO authenticated;
GRANT EXECUTE ON FUNCTION insert_autopilot_recommendation TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_expired_autopilot_recommendations TO service_role;

-- =============================================================================
-- Step 13: Comments
-- =============================================================================
COMMENT ON TABLE autopilot_recommendation_runs IS 'VTID-01185: Tracks recommendation generation runs';
COMMENT ON TABLE autopilot_analyzer_sources IS 'VTID-01185: Status of each analyzer source';
COMMENT ON FUNCTION get_autopilot_analyzer_sources IS 'VTID-01185: Get all analyzer sources and their status';
COMMENT ON FUNCTION update_autopilot_analyzer_source IS 'VTID-01185: Update analyzer source status after scan';
COMMENT ON FUNCTION create_autopilot_recommendation_run IS 'VTID-01185: Start a new recommendation generation run';
COMMENT ON FUNCTION complete_autopilot_recommendation_run IS 'VTID-01185: Complete a recommendation run with results';
COMMENT ON FUNCTION get_autopilot_recommendation_history IS 'VTID-01185: Get history of recommendation runs';
COMMENT ON FUNCTION insert_autopilot_recommendation IS 'VTID-01185: Insert recommendation with deduplication';
COMMENT ON FUNCTION cleanup_expired_autopilot_recommendations IS 'VTID-01185: Remove expired recommendations';

-- =============================================================================
-- Done
-- =============================================================================
