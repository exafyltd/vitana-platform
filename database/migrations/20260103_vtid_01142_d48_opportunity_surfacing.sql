-- Migration: 20260103_vtid_01142_d48_opportunity_surfacing.sql
-- Purpose: VTID-01142 D48 Context-Aware Opportunity & Experience Surfacing Engine
-- Date: 2026-01-03
--
-- This migration creates tables and functions for the D48 Opportunity Surfacing system
-- that surfaces timely, relevant opportunities based on user context and predictive windows.
--
-- Core Tables:
--   - contextual_opportunities: Surfaced opportunities with status tracking
--
-- Hard Governance (Non-Negotiable):
--   - Memory-first
--   - Context-aware, not promotional
--   - User-benefit > monetization
--   - Explainability mandatory
--   - No dark patterns
--   - No forced actions
--   - All outputs logged to OASIS
--   - No schema-breaking changes

-- ===========================================================================
-- VTID-01142: D48 Contextual Opportunities Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS contextual_opportunities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    session_id TEXT,

    -- Opportunity metadata
    opportunity_type TEXT NOT NULL CHECK (opportunity_type IN (
        'experience', 'service', 'content', 'activity', 'place', 'offer'
    )),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    confidence INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
    why_now TEXT NOT NULL,
    relevance_factors TEXT[] NOT NULL DEFAULT '{}',
    suggested_action TEXT NOT NULL CHECK (suggested_action IN (
        'view', 'save', 'dismiss'
    )) DEFAULT 'view',
    dismissible BOOLEAN NOT NULL DEFAULT TRUE,

    -- Priority and linking
    priority_domain TEXT NOT NULL CHECK (priority_domain IN (
        'health_wellbeing', 'social_relationships', 'learning_growth',
        'commerce_monetization', 'exploration_discovery'
    )),
    external_id TEXT,
    external_type TEXT CHECK (external_type IN (
        'service', 'product', 'event', 'location', 'content', 'activity', NULL
    )),
    window_id TEXT,
    guidance_id TEXT,
    alignment_signal_ids TEXT[] DEFAULT '{}',

    -- Status tracking
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
        'active', 'dismissed', 'engaged', 'expired'
    )),
    dismissed_at TIMESTAMPTZ,
    dismissed_reason TEXT CHECK (dismissed_reason IN (
        'not_interested', 'not_relevant', 'already_done', 'too_soon', 'other', NULL
    )),
    engaged_at TIMESTAMPTZ,
    engagement_type TEXT CHECK (engagement_type IN (
        'viewed', 'saved', 'clicked', 'completed', NULL
    )),
    expires_at TIMESTAMPTZ,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===========================================================================
-- VTID-01142: Indexes for Efficient Querying
-- ===========================================================================

-- Primary access patterns
CREATE INDEX IF NOT EXISTS idx_ctx_opps_tenant_user ON contextual_opportunities(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_ctx_opps_user_status ON contextual_opportunities(user_id, status);
CREATE INDEX IF NOT EXISTS idx_ctx_opps_user_type ON contextual_opportunities(user_id, opportunity_type);
CREATE INDEX IF NOT EXISTS idx_ctx_opps_created_at ON contextual_opportunities(created_at DESC);

-- Filtering patterns
CREATE INDEX IF NOT EXISTS idx_ctx_opps_external ON contextual_opportunities(external_type, external_id);
CREATE INDEX IF NOT EXISTS idx_ctx_opps_priority_domain ON contextual_opportunities(priority_domain);
CREATE INDEX IF NOT EXISTS idx_ctx_opps_window ON contextual_opportunities(window_id) WHERE window_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ctx_opps_guidance ON contextual_opportunities(guidance_id) WHERE guidance_id IS NOT NULL;

-- Status change queries
CREATE INDEX IF NOT EXISTS idx_ctx_opps_dismissed ON contextual_opportunities(user_id, dismissed_at DESC) WHERE status = 'dismissed';
CREATE INDEX IF NOT EXISTS idx_ctx_opps_engaged ON contextual_opportunities(user_id, engaged_at DESC) WHERE status = 'engaged';
CREATE INDEX IF NOT EXISTS idx_ctx_opps_active ON contextual_opportunities(user_id, created_at DESC) WHERE status = 'active';

-- Expiration queries
CREATE INDEX IF NOT EXISTS idx_ctx_opps_expires ON contextual_opportunities(expires_at) WHERE expires_at IS NOT NULL AND status = 'active';

-- ===========================================================================
-- VTID-01142: Enable Row Level Security
-- ===========================================================================

ALTER TABLE contextual_opportunities ENABLE ROW LEVEL SECURITY;

-- Users can only see their own opportunities
CREATE POLICY ctx_opps_select_own ON contextual_opportunities
    FOR SELECT
    USING (auth.uid() = user_id);

-- Users can update their own opportunities (dismiss, engage)
CREATE POLICY ctx_opps_update_own ON contextual_opportunities
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Service role can do everything
CREATE POLICY ctx_opps_service_all ON contextual_opportunities
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ===========================================================================
-- VTID-01142: Grant Permissions
-- ===========================================================================

GRANT SELECT, UPDATE ON contextual_opportunities TO authenticated;
GRANT ALL ON contextual_opportunities TO service_role;

-- ===========================================================================
-- VTID-01142: RPC Functions
-- ===========================================================================

-- Function to get active opportunities for user
CREATE OR REPLACE FUNCTION d48_get_active_opportunities(
    p_limit INTEGER DEFAULT 10
)
RETURNS SETOF contextual_opportunities
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT *
    FROM contextual_opportunities
    WHERE user_id = v_user_id
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY
        CASE priority_domain
            WHEN 'health_wellbeing' THEN 1
            WHEN 'social_relationships' THEN 2
            WHEN 'learning_growth' THEN 3
            WHEN 'exploration_discovery' THEN 4
            WHEN 'commerce_monetization' THEN 5
        END,
        confidence DESC,
        created_at DESC
    LIMIT p_limit;
END;
$$;

-- Function to dismiss an opportunity
CREATE OR REPLACE FUNCTION d48_dismiss_opportunity(
    p_opportunity_id UUID,
    p_reason TEXT DEFAULT 'not_interested'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_current_status TEXT;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get current status
    SELECT status INTO v_current_status
    FROM contextual_opportunities
    WHERE id = p_opportunity_id AND user_id = v_user_id;

    IF v_current_status IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
    END IF;

    IF v_current_status != 'active' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_PROCESSED', 'status', v_current_status);
    END IF;

    -- Update opportunity
    UPDATE contextual_opportunities
    SET status = 'dismissed',
        dismissed_at = NOW(),
        dismissed_reason = p_reason,
        updated_at = NOW()
    WHERE id = p_opportunity_id AND user_id = v_user_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', p_opportunity_id,
        'status', 'dismissed',
        'reason', p_reason
    );
END;
$$;

-- Function to record engagement with an opportunity
CREATE OR REPLACE FUNCTION d48_engage_opportunity(
    p_opportunity_id UUID,
    p_engagement_type TEXT DEFAULT 'viewed'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_current_status TEXT;
    v_new_status TEXT;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Validate engagement type
    IF p_engagement_type NOT IN ('viewed', 'saved', 'clicked', 'completed') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_ENGAGEMENT_TYPE');
    END IF;

    -- Get current status
    SELECT status INTO v_current_status
    FROM contextual_opportunities
    WHERE id = p_opportunity_id AND user_id = v_user_id;

    IF v_current_status IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
    END IF;

    -- Determine new status
    v_new_status := CASE
        WHEN p_engagement_type = 'completed' THEN 'engaged'
        ELSE 'active'
    END;

    -- Update opportunity
    UPDATE contextual_opportunities
    SET status = v_new_status,
        engaged_at = NOW(),
        engagement_type = p_engagement_type,
        updated_at = NOW()
    WHERE id = p_opportunity_id AND user_id = v_user_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', p_opportunity_id,
        'status', v_new_status,
        'engagement_type', p_engagement_type
    );
END;
$$;

-- Function to get opportunity history
CREATE OR REPLACE FUNCTION d48_get_opportunity_history(
    p_status TEXT[] DEFAULT NULL,
    p_types TEXT[] DEFAULT NULL,
    p_since TIMESTAMPTZ DEFAULT NULL,
    p_limit INTEGER DEFAULT 50
)
RETURNS SETOF contextual_opportunities
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_since TIMESTAMPTZ;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN;
    END IF;

    v_since := COALESCE(p_since, NOW() - INTERVAL '30 days');

    RETURN QUERY
    SELECT *
    FROM contextual_opportunities
    WHERE user_id = v_user_id
      AND created_at >= v_since
      AND (p_status IS NULL OR status = ANY(p_status))
      AND (p_types IS NULL OR opportunity_type = ANY(p_types))
    ORDER BY created_at DESC
    LIMIT p_limit;
END;
$$;

-- Function to get surfacing stats
CREATE OR REPLACE FUNCTION d48_get_surfacing_stats(
    p_since TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_since TIMESTAMPTZ;
    v_total INTEGER;
    v_active INTEGER;
    v_dismissed INTEGER;
    v_engaged INTEGER;
    v_by_type JSONB;
    v_by_domain JSONB;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    v_since := COALESCE(p_since, NOW() - INTERVAL '30 days');

    -- Count by status
    SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE status = 'active'),
        COUNT(*) FILTER (WHERE status = 'dismissed'),
        COUNT(*) FILTER (WHERE status = 'engaged')
    INTO v_total, v_active, v_dismissed, v_engaged
    FROM contextual_opportunities
    WHERE user_id = v_user_id AND created_at >= v_since;

    -- Count by type
    SELECT jsonb_object_agg(opportunity_type, cnt)
    INTO v_by_type
    FROM (
        SELECT opportunity_type, COUNT(*) as cnt
        FROM contextual_opportunities
        WHERE user_id = v_user_id AND created_at >= v_since
        GROUP BY opportunity_type
    ) t;

    -- Count by domain
    SELECT jsonb_object_agg(priority_domain, cnt)
    INTO v_by_domain
    FROM (
        SELECT priority_domain, COUNT(*) as cnt
        FROM contextual_opportunities
        WHERE user_id = v_user_id AND created_at >= v_since
        GROUP BY priority_domain
    ) t;

    RETURN jsonb_build_object(
        'ok', true,
        'since', v_since,
        'total', v_total,
        'active', v_active,
        'dismissed', v_dismissed,
        'engaged', v_engaged,
        'dismissal_rate', CASE WHEN v_total > 0 THEN ROUND((v_dismissed::numeric / v_total) * 100, 2) ELSE 0 END,
        'engagement_rate', CASE WHEN v_total > 0 THEN ROUND((v_engaged::numeric / v_total) * 100, 2) ELSE 0 END,
        'by_type', COALESCE(v_by_type, '{}'::jsonb),
        'by_domain', COALESCE(v_by_domain, '{}'::jsonb)
    );
END;
$$;

-- Function to expire stale opportunities
CREATE OR REPLACE FUNCTION d48_expire_stale_opportunities()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_expired_count INTEGER;
BEGIN
    UPDATE contextual_opportunities
    SET status = 'expired',
        updated_at = NOW()
    WHERE status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at < NOW();

    GET DIAGNOSTICS v_expired_count = ROW_COUNT;
    RETURN v_expired_count;
END;
$$;

-- ===========================================================================
-- VTID-01142: Grant Execute Permissions on Functions
-- ===========================================================================

GRANT EXECUTE ON FUNCTION d48_get_active_opportunities TO authenticated;
GRANT EXECUTE ON FUNCTION d48_dismiss_opportunity TO authenticated;
GRANT EXECUTE ON FUNCTION d48_engage_opportunity TO authenticated;
GRANT EXECUTE ON FUNCTION d48_get_opportunity_history TO authenticated;
GRANT EXECUTE ON FUNCTION d48_get_surfacing_stats TO authenticated;

GRANT EXECUTE ON FUNCTION d48_get_active_opportunities TO service_role;
GRANT EXECUTE ON FUNCTION d48_dismiss_opportunity TO service_role;
GRANT EXECUTE ON FUNCTION d48_engage_opportunity TO service_role;
GRANT EXECUTE ON FUNCTION d48_get_opportunity_history TO service_role;
GRANT EXECUTE ON FUNCTION d48_get_surfacing_stats TO service_role;
GRANT EXECUTE ON FUNCTION d48_expire_stale_opportunities TO service_role;

-- ===========================================================================
-- VTID-01142: Comments
-- ===========================================================================

COMMENT ON TABLE contextual_opportunities IS 'VTID-01142: D48 Contextual opportunities surfaced to users based on their current life context and predictive windows.';

COMMENT ON COLUMN contextual_opportunities.opportunity_type IS 'Type of opportunity: experience, service, content, activity, place, or offer';
COMMENT ON COLUMN contextual_opportunities.confidence IS 'Confidence score 0-100 for the opportunity relevance';
COMMENT ON COLUMN contextual_opportunities.why_now IS 'Human-readable explanation of why this opportunity is surfaced now (mandatory for explainability)';
COMMENT ON COLUMN contextual_opportunities.relevance_factors IS 'Factors contributing to relevance: goal_match, timing_match, preference_match, etc.';
COMMENT ON COLUMN contextual_opportunities.priority_domain IS 'Priority domain following spec order: health > social > learning > exploration > commerce';
COMMENT ON COLUMN contextual_opportunities.status IS 'Current status: active, dismissed, engaged, or expired';

COMMENT ON FUNCTION d48_get_active_opportunities IS 'VTID-01142: Get active opportunities for the current user, ordered by priority.';
COMMENT ON FUNCTION d48_dismiss_opportunity IS 'VTID-01142: Dismiss an opportunity with a reason for cooldown tracking.';
COMMENT ON FUNCTION d48_engage_opportunity IS 'VTID-01142: Record engagement with an opportunity.';
COMMENT ON FUNCTION d48_get_opportunity_history IS 'VTID-01142: Get opportunity history with optional status and type filters.';
COMMENT ON FUNCTION d48_get_surfacing_stats IS 'VTID-01142: Get surfacing statistics for the current user.';
COMMENT ON FUNCTION d48_expire_stale_opportunities IS 'VTID-01142: Expire opportunities that have passed their expiration time.';
