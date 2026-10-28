-- Migration: 20260103_vtid_01144_positive_trajectory_reinforcement.sql
-- Purpose: VTID-01144 D50 Positive Trajectory Reinforcement & Momentum Engine
-- Date: 2026-01-03
--
-- This migration creates tables and functions for the D50 Positive Trajectory
-- Reinforcement system that identifies positive patterns and reinforces them
-- gently to help users continue what's working.
--
-- Core Philosophy:
--   - Positive-only reinforcement (no correction)
--   - No comparison with others
--   - No gamification pressure
--   - Focus on continuation, not escalation
--
-- Hard Governance:
--   - Memory-first
--   - All outputs logged to OASIS
--   - Explainability mandatory

-- ===========================================================================
-- VTID-01144: Positive Reinforcements Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS d50_positive_reinforcements (
    reinforcement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Core reinforcement data
    trajectory_type TEXT NOT NULL CHECK (trajectory_type IN (
        'health', 'routine', 'social', 'emotional', 'learning', 'consistency'
    )),
    confidence INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
    what_is_working TEXT NOT NULL,
    why_it_matters TEXT NOT NULL,
    suggested_focus TEXT,
    dismissible BOOLEAN NOT NULL DEFAULT TRUE,

    -- Source tracking (linked to D43/D44 signals & trends)
    source_signals UUID[] DEFAULT '{}',
    source_trends TEXT[] DEFAULT '{}',
    context_snapshot JSONB DEFAULT '{}'::jsonb,

    -- Lifecycle tracking
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ,
    dismissed_at TIMESTAMPTZ,
    dismiss_reason TEXT CHECK (dismiss_reason IN (
        'not_relevant', 'already_aware', 'timing_off', 'no_reason', NULL
    )),

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_d50_reinforcements_tenant_user
    ON d50_positive_reinforcements(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_d50_reinforcements_trajectory_type
    ON d50_positive_reinforcements(trajectory_type);
CREATE INDEX IF NOT EXISTS idx_d50_reinforcements_user_trajectory
    ON d50_positive_reinforcements(user_id, trajectory_type);
CREATE INDEX IF NOT EXISTS idx_d50_reinforcements_generated_at
    ON d50_positive_reinforcements(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_d50_reinforcements_user_generated
    ON d50_positive_reinforcements(user_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_d50_reinforcements_not_dismissed
    ON d50_positive_reinforcements(user_id, trajectory_type, generated_at DESC)
    WHERE dismissed_at IS NULL;

-- Enable Row Level Security
ALTER TABLE d50_positive_reinforcements ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY d50_reinforcements_select_own ON d50_positive_reinforcements
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY d50_reinforcements_update_own ON d50_positive_reinforcements
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY d50_reinforcements_service_all ON d50_positive_reinforcements
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant permissions
GRANT SELECT, UPDATE ON d50_positive_reinforcements TO authenticated;
GRANT ALL ON d50_positive_reinforcements TO service_role;

-- ===========================================================================
-- VTID-01144: Trajectory Eligibility Cache Table
-- ===========================================================================
-- Caches eligibility calculations to avoid repeated expensive computations

CREATE TABLE IF NOT EXISTS d50_trajectory_eligibility_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    trajectory_type TEXT NOT NULL CHECK (trajectory_type IN (
        'health', 'routine', 'social', 'emotional', 'learning', 'consistency'
    )),

    -- Eligibility state
    is_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    confidence INTEGER NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 100),
    days_sustained INTEGER NOT NULL DEFAULT 0,
    evidence_summary TEXT,

    -- Last reinforcement tracking
    last_reinforcement_id UUID REFERENCES d50_positive_reinforcements(reinforcement_id),
    last_reinforcement_at TIMESTAMPTZ,
    days_since_last_reinforcement INTEGER,

    -- Cache metadata
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 hour',

    -- Unique constraint per user per trajectory
    CONSTRAINT unique_user_trajectory UNIQUE (user_id, trajectory_type)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_d50_eligibility_tenant_user
    ON d50_trajectory_eligibility_cache(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_d50_eligibility_expires
    ON d50_trajectory_eligibility_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_d50_eligibility_eligible
    ON d50_trajectory_eligibility_cache(user_id, is_eligible)
    WHERE is_eligible = TRUE;

-- Enable Row Level Security
ALTER TABLE d50_trajectory_eligibility_cache ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY d50_eligibility_select_own ON d50_trajectory_eligibility_cache
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY d50_eligibility_service_all ON d50_trajectory_eligibility_cache
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant permissions
GRANT SELECT ON d50_trajectory_eligibility_cache TO authenticated;
GRANT ALL ON d50_trajectory_eligibility_cache TO service_role;

-- ===========================================================================
-- VTID-01144: RPC Functions
-- ===========================================================================

-- Function to store a new reinforcement
CREATE OR REPLACE FUNCTION d50_store_reinforcement(
    p_trajectory_type TEXT,
    p_confidence INTEGER,
    p_what_is_working TEXT,
    p_why_it_matters TEXT,
    p_suggested_focus TEXT DEFAULT NULL,
    p_source_signals UUID[] DEFAULT '{}',
    p_source_trends TEXT[] DEFAULT '{}',
    p_context_snapshot JSONB DEFAULT NULL,
    p_dismissible BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_reinforcement_id UUID;
BEGIN
    -- Get user context
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get tenant from user metadata or default
    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    -- Insert reinforcement
    INSERT INTO d50_positive_reinforcements (
        tenant_id, user_id, trajectory_type, confidence,
        what_is_working, why_it_matters, suggested_focus,
        source_signals, source_trends, context_snapshot,
        dismissible, generated_at
    ) VALUES (
        v_tenant_id, v_user_id, p_trajectory_type, p_confidence,
        p_what_is_working, p_why_it_matters, p_suggested_focus,
        COALESCE(p_source_signals, '{}'),
        COALESCE(p_source_trends, '{}'),
        COALESCE(p_context_snapshot, '{}'::jsonb),
        p_dismissible, NOW()
    )
    RETURNING reinforcement_id INTO v_reinforcement_id;

    -- Update eligibility cache
    INSERT INTO d50_trajectory_eligibility_cache (
        tenant_id, user_id, trajectory_type,
        last_reinforcement_id, last_reinforcement_at,
        days_since_last_reinforcement, computed_at, expires_at
    ) VALUES (
        v_tenant_id, v_user_id, p_trajectory_type,
        v_reinforcement_id, NOW(),
        0, NOW(), NOW() + INTERVAL '1 hour'
    )
    ON CONFLICT (user_id, trajectory_type) DO UPDATE SET
        last_reinforcement_id = v_reinforcement_id,
        last_reinforcement_at = NOW(),
        days_since_last_reinforcement = 0,
        is_eligible = FALSE,  -- No longer eligible after reinforcement
        computed_at = NOW(),
        expires_at = NOW() + INTERVAL '1 hour';

    RETURN jsonb_build_object(
        'ok', true,
        'reinforcement_id', v_reinforcement_id,
        'trajectory_type', p_trajectory_type
    );
END;
$$;

-- Function to mark reinforcement as delivered
CREATE OR REPLACE FUNCTION d50_mark_delivered(
    p_reinforcement_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    UPDATE d50_positive_reinforcements
    SET delivered_at = NOW(),
        updated_at = NOW()
    WHERE reinforcement_id = p_reinforcement_id
      AND user_id = v_user_id
      AND delivered_at IS NULL;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND_OR_ALREADY_DELIVERED');
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'reinforcement_id', p_reinforcement_id,
        'delivered_at', NOW()
    );
END;
$$;

-- Function to dismiss a reinforcement
CREATE OR REPLACE FUNCTION d50_dismiss_reinforcement(
    p_reinforcement_id UUID,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_dismissible BOOLEAN;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Check if dismissible
    SELECT dismissible INTO v_dismissible
    FROM d50_positive_reinforcements
    WHERE reinforcement_id = p_reinforcement_id
      AND user_id = v_user_id;

    IF v_dismissible IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
    END IF;

    IF NOT v_dismissible THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_DISMISSIBLE');
    END IF;

    UPDATE d50_positive_reinforcements
    SET dismissed_at = NOW(),
        dismiss_reason = p_reason,
        updated_at = NOW()
    WHERE reinforcement_id = p_reinforcement_id
      AND user_id = v_user_id;

    RETURN jsonb_build_object(
        'ok', true,
        'reinforcement_id', p_reinforcement_id,
        'dismissed_at', NOW()
    );
END;
$$;

-- Function to get recent reinforcements
CREATE OR REPLACE FUNCTION d50_get_recent_reinforcements(
    p_trajectory_types TEXT[] DEFAULT NULL,
    p_include_dismissed BOOLEAN DEFAULT FALSE,
    p_limit INTEGER DEFAULT 20
)
RETURNS SETOF d50_positive_reinforcements
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
    FROM d50_positive_reinforcements
    WHERE user_id = v_user_id
      AND (p_trajectory_types IS NULL OR trajectory_type = ANY(p_trajectory_types))
      AND (p_include_dismissed OR dismissed_at IS NULL)
    ORDER BY generated_at DESC
    LIMIT p_limit;
END;
$$;

-- Function to get last reinforcement by trajectory type
CREATE OR REPLACE FUNCTION d50_get_last_reinforcement(
    p_trajectory_type TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_result RECORD;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    SELECT reinforcement_id, generated_at, dismissed_at
    INTO v_result
    FROM d50_positive_reinforcements
    WHERE user_id = v_user_id
      AND trajectory_type = p_trajectory_type
    ORDER BY generated_at DESC
    LIMIT 1;

    IF v_result IS NULL THEN
        RETURN jsonb_build_object(
            'ok', true,
            'found', false
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'found', true,
        'reinforcement_id', v_result.reinforcement_id,
        'generated_at', v_result.generated_at,
        'dismissed_at', v_result.dismissed_at,
        'days_since', EXTRACT(DAY FROM NOW() - v_result.generated_at)::integer
    );
END;
$$;

-- Function to get eligibility cache
CREATE OR REPLACE FUNCTION d50_get_eligibility_cache(
    p_trajectory_types TEXT[] DEFAULT NULL
)
RETURNS SETOF d50_trajectory_eligibility_cache
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
    FROM d50_trajectory_eligibility_cache
    WHERE user_id = v_user_id
      AND (p_trajectory_types IS NULL OR trajectory_type = ANY(p_trajectory_types))
      AND expires_at > NOW();
END;
$$;

-- Function to update eligibility cache
CREATE OR REPLACE FUNCTION d50_update_eligibility_cache(
    p_trajectory_type TEXT,
    p_is_eligible BOOLEAN,
    p_confidence INTEGER,
    p_days_sustained INTEGER,
    p_evidence_summary TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_last_reinforcement_id UUID;
    v_last_reinforcement_at TIMESTAMPTZ;
    v_days_since INTEGER;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get tenant
    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    -- Get last reinforcement info
    SELECT reinforcement_id, generated_at
    INTO v_last_reinforcement_id, v_last_reinforcement_at
    FROM d50_positive_reinforcements
    WHERE user_id = v_user_id
      AND trajectory_type = p_trajectory_type
    ORDER BY generated_at DESC
    LIMIT 1;

    IF v_last_reinforcement_at IS NOT NULL THEN
        v_days_since := EXTRACT(DAY FROM NOW() - v_last_reinforcement_at)::integer;
    END IF;

    -- Upsert cache
    INSERT INTO d50_trajectory_eligibility_cache (
        tenant_id, user_id, trajectory_type,
        is_eligible, confidence, days_sustained, evidence_summary,
        last_reinforcement_id, last_reinforcement_at, days_since_last_reinforcement,
        computed_at, expires_at
    ) VALUES (
        v_tenant_id, v_user_id, p_trajectory_type,
        p_is_eligible, p_confidence, p_days_sustained, p_evidence_summary,
        v_last_reinforcement_id, v_last_reinforcement_at, v_days_since,
        NOW(), NOW() + INTERVAL '1 hour'
    )
    ON CONFLICT (user_id, trajectory_type) DO UPDATE SET
        is_eligible = p_is_eligible,
        confidence = p_confidence,
        days_sustained = p_days_sustained,
        evidence_summary = p_evidence_summary,
        last_reinforcement_id = v_last_reinforcement_id,
        last_reinforcement_at = v_last_reinforcement_at,
        days_since_last_reinforcement = v_days_since,
        computed_at = NOW(),
        expires_at = NOW() + INTERVAL '1 hour';

    RETURN jsonb_build_object(
        'ok', true,
        'trajectory_type', p_trajectory_type,
        'is_eligible', p_is_eligible
    );
END;
$$;

-- Function to count today's reinforcements
CREATE OR REPLACE FUNCTION d50_count_today_reinforcements()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_count INTEGER;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN 0;
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM d50_positive_reinforcements
    WHERE user_id = v_user_id
      AND generated_at >= CURRENT_DATE
      AND generated_at < CURRENT_DATE + INTERVAL '1 day';

    RETURN v_count;
END;
$$;

-- ===========================================================================
-- Grant execute permissions on functions
-- ===========================================================================

GRANT EXECUTE ON FUNCTION d50_store_reinforcement TO authenticated;
GRANT EXECUTE ON FUNCTION d50_mark_delivered TO authenticated;
GRANT EXECUTE ON FUNCTION d50_dismiss_reinforcement TO authenticated;
GRANT EXECUTE ON FUNCTION d50_get_recent_reinforcements TO authenticated;
GRANT EXECUTE ON FUNCTION d50_get_last_reinforcement TO authenticated;
GRANT EXECUTE ON FUNCTION d50_get_eligibility_cache TO authenticated;
GRANT EXECUTE ON FUNCTION d50_update_eligibility_cache TO authenticated;
GRANT EXECUTE ON FUNCTION d50_count_today_reinforcements TO authenticated;

GRANT EXECUTE ON FUNCTION d50_store_reinforcement TO service_role;
GRANT EXECUTE ON FUNCTION d50_mark_delivered TO service_role;
GRANT EXECUTE ON FUNCTION d50_dismiss_reinforcement TO service_role;
GRANT EXECUTE ON FUNCTION d50_get_recent_reinforcements TO service_role;
GRANT EXECUTE ON FUNCTION d50_get_last_reinforcement TO service_role;
GRANT EXECUTE ON FUNCTION d50_get_eligibility_cache TO service_role;
GRANT EXECUTE ON FUNCTION d50_update_eligibility_cache TO service_role;
GRANT EXECUTE ON FUNCTION d50_count_today_reinforcements TO service_role;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON TABLE d50_positive_reinforcements IS 'VTID-01144: D50 Positive trajectory reinforcements. Stores generated positive-only feedback for users.';
COMMENT ON TABLE d50_trajectory_eligibility_cache IS 'VTID-01144: D50 Eligibility cache. Caches trajectory eligibility calculations to avoid repeated expensive computations.';

COMMENT ON FUNCTION d50_store_reinforcement IS 'VTID-01144: Store a new positive reinforcement.';
COMMENT ON FUNCTION d50_mark_delivered IS 'VTID-01144: Mark a reinforcement as delivered to the user.';
COMMENT ON FUNCTION d50_dismiss_reinforcement IS 'VTID-01144: Dismiss a reinforcement with optional reason.';
COMMENT ON FUNCTION d50_get_recent_reinforcements IS 'VTID-01144: Get recent reinforcements for the user.';
COMMENT ON FUNCTION d50_get_last_reinforcement IS 'VTID-01144: Get the last reinforcement by trajectory type.';
COMMENT ON FUNCTION d50_get_eligibility_cache IS 'VTID-01144: Get cached eligibility data.';
COMMENT ON FUNCTION d50_update_eligibility_cache IS 'VTID-01144: Update eligibility cache for a trajectory type.';
COMMENT ON FUNCTION d50_count_today_reinforcements IS 'VTID-01144: Count reinforcements generated today.';
