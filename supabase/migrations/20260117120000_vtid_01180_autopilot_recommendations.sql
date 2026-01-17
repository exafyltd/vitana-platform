-- =============================================================================
-- VTID-01180: Autopilot Recommendations + Popup Wiring (Correct Implementation)
-- =============================================================================
-- This is the CORRECT implementation of VTID-01180 that adds:
-- 1. autopilot_recommendations table for AI-generated actionable recommendations
-- 2. 10 seeded recommendations for immediate UI population
-- 3. Functions for listing and activating recommendations
-- 4. Activation creates VTID + spec snapshot + Command Hub task card
-- =============================================================================

-- =============================================================================
-- Step 1: Autopilot Recommendations Table
-- =============================================================================
CREATE TABLE IF NOT EXISTS autopilot_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Display content
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT 'general',  -- health, longevity, community, professional, etc.

  -- Scoring for prioritization
  risk_level TEXT DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  impact_score INTEGER DEFAULT 5 CHECK (impact_score >= 1 AND impact_score <= 10),
  effort_score INTEGER DEFAULT 5 CHECK (effort_score >= 1 AND effort_score <= 10),

  -- Spec Pack for activation
  spec_snapshot JSONB DEFAULT '{}',  -- Full spec when activated
  spec_checksum TEXT,                 -- SHA256 of spec for integrity verification

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'activated', 'rejected', 'snoozed')),
  activated_vtid TEXT,                -- VTID assigned when activated

  -- User targeting (optional)
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,  -- NULL = system-wide recommendation

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  snoozed_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for finding new recommendations
CREATE INDEX IF NOT EXISTS idx_autopilot_recommendations_status
  ON autopilot_recommendations(status, created_at DESC)
  WHERE status = 'new';

-- Index for user-specific recommendations
CREATE INDEX IF NOT EXISTS idx_autopilot_recommendations_user
  ON autopilot_recommendations(user_id, status)
  WHERE user_id IS NOT NULL;

-- Index for activated recommendations lookup
CREATE INDEX IF NOT EXISTS idx_autopilot_recommendations_vtid
  ON autopilot_recommendations(activated_vtid)
  WHERE activated_vtid IS NOT NULL;

-- =============================================================================
-- Step 2: RLS Policies
-- =============================================================================
ALTER TABLE autopilot_recommendations ENABLE ROW LEVEL SECURITY;

-- Users can see their own recommendations OR system-wide ones
DROP POLICY IF EXISTS autopilot_recommendations_user_policy ON autopilot_recommendations;
CREATE POLICY autopilot_recommendations_user_policy
  ON autopilot_recommendations FOR SELECT
  USING (user_id IS NULL OR user_id = auth.uid());

-- Service role has full access
DROP POLICY IF EXISTS autopilot_recommendations_service_role ON autopilot_recommendations;
CREATE POLICY autopilot_recommendations_service_role
  ON autopilot_recommendations FOR ALL
  TO service_role
  USING (true);

-- =============================================================================
-- Step 3: Get Recommendations Function
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
  activated_at TIMESTAMPTZ
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
    ar.activated_at
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
-- Step 4: Activate Recommendation Function (Creates VTID)
-- =============================================================================
CREATE OR REPLACE FUNCTION activate_autopilot_recommendation(
  p_recommendation_id UUID,
  p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rec RECORD;
  v_vtid TEXT;
  v_spec_snapshot JSONB;
  v_checksum TEXT;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  -- Get the recommendation
  SELECT * INTO v_rec
  FROM autopilot_recommendations
  WHERE id = p_recommendation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'Recommendation not found'
    );
  END IF;

  -- Idempotent: If already activated, return existing VTID
  IF v_rec.status = 'activated' AND v_rec.activated_vtid IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'vtid', v_rec.activated_vtid,
      'already_activated', true,
      'activated_at', v_rec.activated_at
    );
  END IF;

  -- Check if recommendation is in activatable state
  IF v_rec.status NOT IN ('new', 'snoozed') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', format('Cannot activate recommendation in status: %s', v_rec.status)
    );
  END IF;

  -- Generate VTID (format: VTID-XXXXX where X is random alphanumeric)
  v_vtid := 'VTID-' || upper(substr(md5(random()::text || v_now::text), 1, 5));

  -- Build spec snapshot from recommendation
  v_spec_snapshot := jsonb_build_object(
    'vtid_title', v_rec.title,
    'goal', v_rec.summary,
    'scope_in', ARRAY[v_rec.domain],
    'scope_out', ARRAY[]::TEXT[],
    'non_negotiables', ARRAY['Safety check required', 'User consent required'],
    'files_expected', ARRAY[]::TEXT[],
    'endpoints_expected', ARRAY[]::TEXT[],
    'tests', ARRAY['Unit tests', 'Integration tests'],
    'definition_of_done', ARRAY[
      'Implementation complete',
      'Tests passing',
      'Documentation updated',
      'Code reviewed'
    ],
    'source_recommendation_id', p_recommendation_id,
    'domain', v_rec.domain,
    'risk_level', v_rec.risk_level,
    'impact_score', v_rec.impact_score,
    'effort_score', v_rec.effort_score
  );

  -- Generate checksum for integrity verification
  v_checksum := encode(sha256(v_spec_snapshot::text::bytea), 'hex');

  -- Update recommendation with activation data
  UPDATE autopilot_recommendations
  SET status = 'activated',
      activated_vtid = v_vtid,
      activated_at = v_now,
      spec_snapshot = v_spec_snapshot,
      spec_checksum = v_checksum,
      updated_at = v_now
  WHERE id = p_recommendation_id;

  -- Create VTID ledger entry (scheduled task card)
  INSERT INTO vtid_ledger (
    vtid,
    title,
    summary,
    status,
    layer,
    module,
    created_at,
    updated_at
  ) VALUES (
    v_vtid,
    v_rec.title,
    v_rec.summary,
    'scheduled',
    'autopilot',
    'recommendation',
    v_now,
    v_now
  )
  ON CONFLICT (vtid) DO UPDATE SET
    title = EXCLUDED.title,
    summary = EXCLUDED.summary,
    updated_at = v_now;

  RETURN jsonb_build_object(
    'ok', true,
    'vtid', v_vtid,
    'recommendation_id', p_recommendation_id,
    'title', v_rec.title,
    'status', 'activated',
    'activated_at', v_now,
    'spec_checksum', v_checksum
  );
END;
$$;

-- =============================================================================
-- Step 5: Reject Recommendation Function
-- =============================================================================
CREATE OR REPLACE FUNCTION reject_autopilot_recommendation(
  p_recommendation_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rec RECORD;
BEGIN
  SELECT * INTO v_rec
  FROM autopilot_recommendations
  WHERE id = p_recommendation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Recommendation not found');
  END IF;

  IF v_rec.status = 'activated' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Cannot reject activated recommendation');
  END IF;

  UPDATE autopilot_recommendations
  SET status = 'rejected',
      updated_at = NOW()
  WHERE id = p_recommendation_id;

  RETURN jsonb_build_object(
    'ok', true,
    'recommendation_id', p_recommendation_id,
    'status', 'rejected'
  );
END;
$$;

-- =============================================================================
-- Step 6: Snooze Recommendation Function
-- =============================================================================
CREATE OR REPLACE FUNCTION snooze_autopilot_recommendation(
  p_recommendation_id UUID,
  p_hours INTEGER DEFAULT 24
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rec RECORD;
  v_snooze_until TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_rec
  FROM autopilot_recommendations
  WHERE id = p_recommendation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Recommendation not found');
  END IF;

  IF v_rec.status NOT IN ('new', 'snoozed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Cannot snooze recommendation in status: ' || v_rec.status);
  END IF;

  v_snooze_until := NOW() + (p_hours || ' hours')::INTERVAL;

  UPDATE autopilot_recommendations
  SET status = 'snoozed',
      snoozed_until = v_snooze_until,
      updated_at = NOW()
  WHERE id = p_recommendation_id;

  RETURN jsonb_build_object(
    'ok', true,
    'recommendation_id', p_recommendation_id,
    'status', 'snoozed',
    'snoozed_until', v_snooze_until
  );
END;
$$;

-- =============================================================================
-- Step 7: Get Recommendation Count Function (for badge)
-- =============================================================================
CREATE OR REPLACE FUNCTION get_autopilot_recommendations_count(
  p_user_id UUID DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER INTO v_count
  FROM autopilot_recommendations
  WHERE status = 'new'
    AND (p_user_id IS NULL OR user_id IS NULL OR user_id = p_user_id)
    AND (snoozed_until IS NULL OR snoozed_until < NOW());

  RETURN v_count;
END;
$$;

-- =============================================================================
-- Step 8: Seed 10 Initial Recommendations
-- =============================================================================
INSERT INTO autopilot_recommendations (title, summary, domain, risk_level, impact_score, effort_score, status) VALUES
(
  'Implement Sleep Quality Tracking',
  'Add sleep tracking integration to monitor sleep patterns and provide personalized improvement recommendations based on circadian rhythm analysis.',
  'health',
  'low',
  9,
  6,
  'new'
),
(
  'Enable Heart Rate Variability (HRV) Monitoring',
  'Integrate HRV data analysis to assess autonomic nervous system health and stress recovery capacity for longevity optimization.',
  'longevity',
  'low',
  8,
  5,
  'new'
),
(
  'Deploy Community Matching Algorithm v2',
  'Upgrade matching algorithm to include lifestyle compatibility scoring and shared health goal alignment for better community connections.',
  'community',
  'medium',
  8,
  7,
  'new'
),
(
  'Add Nutrition Logging with AI Analysis',
  'Implement food diary with image recognition and AI-powered nutritional analysis for personalized dietary recommendations.',
  'health',
  'low',
  9,
  8,
  'new'
),
(
  'Create Stress Management Dashboard',
  'Build comprehensive stress tracking dashboard combining HRV, sleep quality, and activity data with actionable insights.',
  'health',
  'low',
  7,
  6,
  'new'
),
(
  'Implement Biomarker Trend Analysis',
  'Add longitudinal analysis of blood biomarkers with trend visualization and early warning alerts for health deviations.',
  'longevity',
  'medium',
  9,
  7,
  'new'
),
(
  'Deploy Professional Network Integration',
  'Connect health professionals with community members for verified expert guidance and consultation booking.',
  'professional',
  'medium',
  7,
  8,
  'new'
),
(
  'Add Medication Reminder System',
  'Implement smart medication tracking with reminders, interaction warnings, and adherence reporting for care coordination.',
  'health',
  'high',
  8,
  5,
  'new'
),
(
  'Create Longevity Score Algorithm',
  'Develop composite longevity score combining biological age markers, lifestyle factors, and predictive health models.',
  'longevity',
  'medium',
  10,
  9,
  'new'
),
(
  'Build Activity Challenge System',
  'Implement gamified activity challenges with community leaderboards, rewards, and social accountability features.',
  'community',
  'low',
  6,
  5,
  'new'
)
ON CONFLICT DO NOTHING;

-- =============================================================================
-- Step 9: Grants
-- =============================================================================
GRANT ALL ON autopilot_recommendations TO service_role;
GRANT SELECT ON autopilot_recommendations TO authenticated;

GRANT EXECUTE ON FUNCTION get_autopilot_recommendations TO service_role;
GRANT EXECUTE ON FUNCTION get_autopilot_recommendations TO authenticated;
GRANT EXECUTE ON FUNCTION activate_autopilot_recommendation TO service_role;
GRANT EXECUTE ON FUNCTION activate_autopilot_recommendation TO authenticated;
GRANT EXECUTE ON FUNCTION reject_autopilot_recommendation TO service_role;
GRANT EXECUTE ON FUNCTION reject_autopilot_recommendation TO authenticated;
GRANT EXECUTE ON FUNCTION snooze_autopilot_recommendation TO service_role;
GRANT EXECUTE ON FUNCTION snooze_autopilot_recommendation TO authenticated;
GRANT EXECUTE ON FUNCTION get_autopilot_recommendations_count TO service_role;
GRANT EXECUTE ON FUNCTION get_autopilot_recommendations_count TO authenticated;

-- =============================================================================
-- Step 10: Comments
-- =============================================================================
COMMENT ON TABLE autopilot_recommendations IS 'VTID-01180: AI-generated actionable recommendations for Autopilot popup';
COMMENT ON FUNCTION get_autopilot_recommendations IS 'VTID-01180: Get recommendations list with filtering and pagination';
COMMENT ON FUNCTION activate_autopilot_recommendation IS 'VTID-01180: Activate recommendation - creates VTID and spec snapshot';
COMMENT ON FUNCTION reject_autopilot_recommendation IS 'VTID-01180: Reject/dismiss a recommendation';
COMMENT ON FUNCTION snooze_autopilot_recommendation IS 'VTID-01180: Snooze recommendation for later';
COMMENT ON FUNCTION get_autopilot_recommendations_count IS 'VTID-01180: Get count of new recommendations for badge';

-- =============================================================================
-- Done
-- =============================================================================
