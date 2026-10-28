-- =============================================================================
-- VTID-01180: Autopilot "Recommendation Inbox" API v0 + Popup Wiring
-- =============================================================================
-- Adds user interaction tracking for recommendations and functions to
-- power the Recommendation Inbox popup in the frontend.
--
-- Design:
-- 1. recommendation_interactions table tracks user responses
-- 2. Functions for inbox queries with RLS enforcement
-- 3. Indexes optimized for inbox pagination and count queries
-- =============================================================================

-- =============================================================================
-- Step 1: Recommendation Interactions Table
-- =============================================================================
CREATE TABLE IF NOT EXISTS recommendation_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id UUID NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Interaction state
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'read', 'accepted', 'dismissed', 'snoozed')),

  -- Timestamps for each action
  read_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  snoozed_until TIMESTAMPTZ,

  -- Feedback
  feedback_rating INTEGER CHECK (feedback_rating >= 1 AND feedback_rating <= 5),
  feedback_note TEXT,

  -- Metadata
  action_taken JSONB DEFAULT '{}',  -- Details of action taken (e.g., {"booked_service": "massage"})

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- One interaction record per user per recommendation
  UNIQUE(recommendation_id, user_id)
);

-- Index for finding user's pending recommendations
CREATE INDEX IF NOT EXISTS idx_recommendation_interactions_user_pending
  ON recommendation_interactions(user_id, status)
  WHERE status IN ('pending', 'snoozed');

-- Index for recommendation lookup
CREATE INDEX IF NOT EXISTS idx_recommendation_interactions_rec_id
  ON recommendation_interactions(recommendation_id);

-- Index for snoozed recommendations that need to be reactivated
CREATE INDEX IF NOT EXISTS idx_recommendation_interactions_snoozed
  ON recommendation_interactions(snoozed_until)
  WHERE status = 'snoozed' AND snoozed_until IS NOT NULL;

-- =============================================================================
-- Step 2: Enable RLS
-- =============================================================================
ALTER TABLE recommendation_interactions ENABLE ROW LEVEL SECURITY;

-- Users can only see their own interactions
CREATE POLICY recommendation_interactions_user_policy
  ON recommendation_interactions FOR ALL
  USING (user_id = auth.uid());

-- Service role has full access
CREATE POLICY recommendation_interactions_service_role
  ON recommendation_interactions FOR ALL
  TO service_role
  USING (true);

-- =============================================================================
-- Step 3: Get Inbox Recommendations Function
-- =============================================================================
CREATE OR REPLACE FUNCTION get_recommendation_inbox(
  p_user_id UUID,
  p_status TEXT[] DEFAULT ARRAY['pending', 'snoozed'],
  p_limit INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  recommendation_id UUID,
  recommendation_type TEXT,
  title TEXT,
  description TEXT,
  action_items JSONB,
  priority INTEGER,
  related_score_pillar TEXT,
  status TEXT,
  read_at TIMESTAMPTZ,
  snoozed_until TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ri.id,
    r.id AS recommendation_id,
    r.recommendation_type,
    r.title,
    r.description,
    r.action_items,
    r.priority,
    r.related_score_pillar,
    ri.status,
    ri.read_at,
    ri.snoozed_until,
    r.expires_at,
    ri.created_at
  FROM recommendations r
  LEFT JOIN recommendation_interactions ri
    ON ri.recommendation_id = r.id AND ri.user_id = p_user_id
  WHERE r.user_id = p_user_id
    AND r.safety_checked = TRUE
    AND (r.expires_at IS NULL OR r.expires_at > NOW())
    AND (
      ri.id IS NULL  -- No interaction yet = pending
      OR ri.status = ANY(p_status)
      OR (ri.status = 'snoozed' AND ri.snoozed_until < NOW())  -- Snooze expired
    )
  ORDER BY r.priority DESC, r.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- =============================================================================
-- Step 4: Get Inbox Count Function
-- =============================================================================
CREATE OR REPLACE FUNCTION get_recommendation_inbox_count(
  p_user_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER INTO v_count
  FROM recommendations r
  LEFT JOIN recommendation_interactions ri
    ON ri.recommendation_id = r.id AND ri.user_id = p_user_id
  WHERE r.user_id = p_user_id
    AND r.safety_checked = TRUE
    AND (r.expires_at IS NULL OR r.expires_at > NOW())
    AND (
      ri.id IS NULL  -- No interaction yet = pending
      OR ri.status IN ('pending', 'snoozed')
      OR (ri.status = 'snoozed' AND ri.snoozed_until < NOW())
    );

  RETURN v_count;
END;
$$;

-- =============================================================================
-- Step 5: Mark Recommendation As Read
-- =============================================================================
CREATE OR REPLACE FUNCTION mark_recommendation_read(
  p_recommendation_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result JSONB;
BEGIN
  -- Verify recommendation belongs to user
  IF NOT EXISTS (
    SELECT 1 FROM recommendations
    WHERE id = p_recommendation_id AND user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Recommendation not found');
  END IF;

  -- Upsert interaction
  INSERT INTO recommendation_interactions (recommendation_id, user_id, status, read_at)
  VALUES (p_recommendation_id, p_user_id, 'read', NOW())
  ON CONFLICT (recommendation_id, user_id)
  DO UPDATE SET
    read_at = COALESCE(recommendation_interactions.read_at, NOW()),
    updated_at = NOW();

  RETURN jsonb_build_object(
    'ok', true,
    'recommendation_id', p_recommendation_id,
    'status', 'read',
    'read_at', NOW()
  );
END;
$$;

-- =============================================================================
-- Step 6: Accept Recommendation (take action)
-- =============================================================================
CREATE OR REPLACE FUNCTION accept_recommendation(
  p_recommendation_id UUID,
  p_user_id UUID,
  p_action_taken JSONB DEFAULT '{}'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result JSONB;
BEGIN
  -- Verify recommendation belongs to user
  IF NOT EXISTS (
    SELECT 1 FROM recommendations
    WHERE id = p_recommendation_id AND user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Recommendation not found');
  END IF;

  -- Upsert interaction
  INSERT INTO recommendation_interactions (
    recommendation_id, user_id, status, read_at, accepted_at, action_taken
  )
  VALUES (
    p_recommendation_id, p_user_id, 'accepted', NOW(), NOW(), p_action_taken
  )
  ON CONFLICT (recommendation_id, user_id)
  DO UPDATE SET
    status = 'accepted',
    read_at = COALESCE(recommendation_interactions.read_at, NOW()),
    accepted_at = NOW(),
    action_taken = p_action_taken,
    updated_at = NOW();

  RETURN jsonb_build_object(
    'ok', true,
    'recommendation_id', p_recommendation_id,
    'status', 'accepted',
    'accepted_at', NOW()
  );
END;
$$;

-- =============================================================================
-- Step 7: Dismiss Recommendation
-- =============================================================================
CREATE OR REPLACE FUNCTION dismiss_recommendation(
  p_recommendation_id UUID,
  p_user_id UUID,
  p_feedback_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Verify recommendation belongs to user
  IF NOT EXISTS (
    SELECT 1 FROM recommendations
    WHERE id = p_recommendation_id AND user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Recommendation not found');
  END IF;

  -- Upsert interaction
  INSERT INTO recommendation_interactions (
    recommendation_id, user_id, status, read_at, dismissed_at, feedback_note
  )
  VALUES (
    p_recommendation_id, p_user_id, 'dismissed', NOW(), NOW(), p_feedback_note
  )
  ON CONFLICT (recommendation_id, user_id)
  DO UPDATE SET
    status = 'dismissed',
    read_at = COALESCE(recommendation_interactions.read_at, NOW()),
    dismissed_at = NOW(),
    feedback_note = COALESCE(p_feedback_note, recommendation_interactions.feedback_note),
    updated_at = NOW();

  RETURN jsonb_build_object(
    'ok', true,
    'recommendation_id', p_recommendation_id,
    'status', 'dismissed',
    'dismissed_at', NOW()
  );
END;
$$;

-- =============================================================================
-- Step 8: Snooze Recommendation
-- =============================================================================
CREATE OR REPLACE FUNCTION snooze_recommendation(
  p_recommendation_id UUID,
  p_user_id UUID,
  p_snooze_hours INTEGER DEFAULT 24
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_snooze_until TIMESTAMPTZ;
BEGIN
  -- Verify recommendation belongs to user
  IF NOT EXISTS (
    SELECT 1 FROM recommendations
    WHERE id = p_recommendation_id AND user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Recommendation not found');
  END IF;

  v_snooze_until := NOW() + (p_snooze_hours || ' hours')::INTERVAL;

  -- Upsert interaction
  INSERT INTO recommendation_interactions (
    recommendation_id, user_id, status, read_at, snoozed_until
  )
  VALUES (
    p_recommendation_id, p_user_id, 'snoozed', NOW(), v_snooze_until
  )
  ON CONFLICT (recommendation_id, user_id)
  DO UPDATE SET
    status = 'snoozed',
    read_at = COALESCE(recommendation_interactions.read_at, NOW()),
    snoozed_until = v_snooze_until,
    updated_at = NOW();

  RETURN jsonb_build_object(
    'ok', true,
    'recommendation_id', p_recommendation_id,
    'status', 'snoozed',
    'snoozed_until', v_snooze_until
  );
END;
$$;

-- =============================================================================
-- Step 9: Submit Feedback
-- =============================================================================
CREATE OR REPLACE FUNCTION submit_recommendation_feedback(
  p_recommendation_id UUID,
  p_user_id UUID,
  p_rating INTEGER,
  p_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Validate rating
  IF p_rating < 1 OR p_rating > 5 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Rating must be between 1 and 5');
  END IF;

  -- Verify recommendation belongs to user
  IF NOT EXISTS (
    SELECT 1 FROM recommendations
    WHERE id = p_recommendation_id AND user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Recommendation not found');
  END IF;

  -- Upsert interaction
  INSERT INTO recommendation_interactions (
    recommendation_id, user_id, feedback_rating, feedback_note
  )
  VALUES (
    p_recommendation_id, p_user_id, p_rating, p_note
  )
  ON CONFLICT (recommendation_id, user_id)
  DO UPDATE SET
    feedback_rating = p_rating,
    feedback_note = COALESCE(p_note, recommendation_interactions.feedback_note),
    updated_at = NOW();

  RETURN jsonb_build_object(
    'ok', true,
    'recommendation_id', p_recommendation_id,
    'feedback_rating', p_rating
  );
END;
$$;

-- =============================================================================
-- Step 10: Grants
-- =============================================================================
GRANT ALL ON recommendation_interactions TO service_role;
GRANT SELECT, INSERT, UPDATE ON recommendation_interactions TO authenticated;

GRANT EXECUTE ON FUNCTION get_recommendation_inbox TO service_role;
GRANT EXECUTE ON FUNCTION get_recommendation_inbox TO authenticated;
GRANT EXECUTE ON FUNCTION get_recommendation_inbox_count TO service_role;
GRANT EXECUTE ON FUNCTION get_recommendation_inbox_count TO authenticated;
GRANT EXECUTE ON FUNCTION mark_recommendation_read TO service_role;
GRANT EXECUTE ON FUNCTION mark_recommendation_read TO authenticated;
GRANT EXECUTE ON FUNCTION accept_recommendation TO service_role;
GRANT EXECUTE ON FUNCTION accept_recommendation TO authenticated;
GRANT EXECUTE ON FUNCTION dismiss_recommendation TO service_role;
GRANT EXECUTE ON FUNCTION dismiss_recommendation TO authenticated;
GRANT EXECUTE ON FUNCTION snooze_recommendation TO service_role;
GRANT EXECUTE ON FUNCTION snooze_recommendation TO authenticated;
GRANT EXECUTE ON FUNCTION submit_recommendation_feedback TO service_role;
GRANT EXECUTE ON FUNCTION submit_recommendation_feedback TO authenticated;

-- =============================================================================
-- Comments
-- =============================================================================
COMMENT ON TABLE recommendation_interactions IS 'VTID-01180: Tracks user interactions with recommendations (read, accept, dismiss, snooze)';
COMMENT ON FUNCTION get_recommendation_inbox IS 'VTID-01180: Get recommendations inbox for a user with pagination';
COMMENT ON FUNCTION get_recommendation_inbox_count IS 'VTID-01180: Get count of pending recommendations for inbox badge';
COMMENT ON FUNCTION mark_recommendation_read IS 'VTID-01180: Mark a recommendation as read';
COMMENT ON FUNCTION accept_recommendation IS 'VTID-01180: Accept a recommendation (user took action)';
COMMENT ON FUNCTION dismiss_recommendation IS 'VTID-01180: Dismiss a recommendation (not interested)';
COMMENT ON FUNCTION snooze_recommendation IS 'VTID-01180: Snooze a recommendation for later';
COMMENT ON FUNCTION submit_recommendation_feedback IS 'VTID-01180: Submit feedback/rating on a recommendation';

-- =============================================================================
-- Done
-- =============================================================================
