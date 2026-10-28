-- =============================================================================
-- VTID-01180+01185: Community User Analyzer Support
-- =============================================================================
-- 1. Add p_user_id parameter to insert_autopilot_recommendation
-- 2. Add time_estimate_seconds column to autopilot_recommendations
-- 3. Update get_autopilot_recommendations to return time_estimate_seconds
-- =============================================================================

-- =============================================================================
-- Step 1: Add time_estimate_seconds column
-- =============================================================================
ALTER TABLE autopilot_recommendations
  ADD COLUMN IF NOT EXISTS time_estimate_seconds INTEGER DEFAULT NULL;

COMMENT ON COLUMN autopilot_recommendations.time_estimate_seconds
  IS 'Estimated time to complete in seconds (30, 60, 120, 300) for Lovable popup time badges';

-- =============================================================================
-- Step 2: Replace insert_autopilot_recommendation with p_user_id support
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
  p_expires_days INTEGER DEFAULT 30,
  p_user_id UUID DEFAULT NULL,
  p_time_estimate_seconds INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_existing RECORD;
  v_id UUID;
BEGIN
  -- Check for duplicate by fingerprint (per-user scoped)
  SELECT * INTO v_existing
  FROM autopilot_recommendations
  WHERE fingerprint = p_fingerprint
    AND status IN ('new', 'snoozed')
    AND (
      (user_id IS NULL AND p_user_id IS NULL)
      OR user_id = p_user_id
    )
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
    status,
    user_id,
    time_estimate_seconds
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
    'new',
    p_user_id,
    p_time_estimate_seconds
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
-- Step 3: Update get_autopilot_recommendations to include time_estimate_seconds
-- =============================================================================
CREATE OR REPLACE FUNCTION get_autopilot_recommendations(
  p_status TEXT[] DEFAULT ARRAY['new'],
  p_limit INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0,
  p_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  summary TEXT,
  domain TEXT,
  risk_level TEXT,
  impact_score INTEGER,
  effort_score INTEGER,
  status TEXT,
  activated_vtid TEXT,
  created_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  time_estimate_seconds INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ar.id,
    ar.title,
    ar.summary,
    ar.domain,
    ar.risk_level,
    ar.impact_score,
    ar.effort_score,
    ar.status,
    ar.activated_vtid,
    ar.created_at,
    ar.activated_at,
    ar.time_estimate_seconds
  FROM autopilot_recommendations ar
  WHERE ar.status = ANY(p_status)
    AND (p_user_id IS NULL OR ar.user_id IS NULL OR ar.user_id = p_user_id)
    AND (ar.snoozed_until IS NULL OR ar.snoozed_until < NOW())
  ORDER BY ar.impact_score DESC, ar.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- =============================================================================
-- Done
-- =============================================================================
