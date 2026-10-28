-- Migration: 20260102_vtid_01137_d43_longitudinal_adaptation.sql
-- Purpose: VTID-01137 D43 Longitudinal Adaptation, Drift Detection & Personal Evolution Engine
-- Date: 2026-01-02
--
-- This migration creates tables and functions for the D43 Longitudinal Adaptation system
-- that tracks user evolution over time and adapts intelligence accordingly.
--
-- Core Tables:
--   - d43_longitudinal_data_points: Raw data points for trend analysis
--   - d43_drift_events: Detected drift events
--   - d43_adaptation_plans: Proposed/applied adaptation plans
--   - d43_preference_snapshots: Preference snapshots for rollback

-- ===========================================================================
-- VTID-01137: D43 Longitudinal Data Points Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS d43_longitudinal_data_points (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    domain TEXT NOT NULL CHECK (domain IN (
        'preference', 'goal', 'engagement', 'social',
        'monetization', 'health', 'communication', 'autonomy'
    )),
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    numeric_value DOUBLE PRECISION,
    source TEXT NOT NULL DEFAULT 'behavioral' CHECK (source IN (
        'explicit', 'inferred', 'behavioral', 'system'
    )),
    confidence INTEGER NOT NULL DEFAULT 70 CHECK (confidence >= 0 AND confidence <= 100),
    metadata JSONB DEFAULT '{}'::jsonb,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_d43_data_points_tenant_user ON d43_longitudinal_data_points(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_d43_data_points_domain ON d43_longitudinal_data_points(domain);
CREATE INDEX IF NOT EXISTS idx_d43_data_points_domain_key ON d43_longitudinal_data_points(domain, key);
CREATE INDEX IF NOT EXISTS idx_d43_data_points_recorded_at ON d43_longitudinal_data_points(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_d43_data_points_user_domain_time ON d43_longitudinal_data_points(user_id, domain, recorded_at DESC);

-- Enable Row Level Security
ALTER TABLE d43_longitudinal_data_points ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY d43_data_points_select_own ON d43_longitudinal_data_points
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY d43_data_points_insert_own ON d43_longitudinal_data_points
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY d43_data_points_service_all ON d43_longitudinal_data_points
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant permissions
GRANT SELECT, INSERT ON d43_longitudinal_data_points TO authenticated;
GRANT ALL ON d43_longitudinal_data_points TO service_role;

-- ===========================================================================
-- VTID-01137: D43 Drift Events Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS d43_drift_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    drift_type TEXT NOT NULL CHECK (drift_type IN (
        'gradual', 'abrupt', 'seasonal', 'experimental', 'stable', 'regression'
    )),
    magnitude INTEGER NOT NULL CHECK (magnitude >= 0 AND magnitude <= 100),
    confidence INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
    domains_affected TEXT[] NOT NULL DEFAULT '{}',
    evidence_summary TEXT,
    data_points_analyzed INTEGER NOT NULL DEFAULT 0,
    time_window_days INTEGER NOT NULL DEFAULT 30,
    trigger_hypothesis TEXT,
    is_seasonal_pattern BOOLEAN NOT NULL DEFAULT FALSE,
    acknowledged_by_user BOOLEAN NOT NULL DEFAULT FALSE,
    acknowledged_at TIMESTAMPTZ,
    user_response TEXT CHECK (user_response IN (
        'confirm_change', 'temporary', 'not_me_anymore', 'ignore', NULL
    )),
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_d43_drift_events_tenant_user ON d43_drift_events(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_d43_drift_events_detected_at ON d43_drift_events(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_d43_drift_events_user_acknowledged ON d43_drift_events(user_id, acknowledged_by_user);
CREATE INDEX IF NOT EXISTS idx_d43_drift_events_drift_type ON d43_drift_events(drift_type);

-- Enable Row Level Security
ALTER TABLE d43_drift_events ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY d43_drift_events_select_own ON d43_drift_events
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY d43_drift_events_update_own ON d43_drift_events
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY d43_drift_events_insert_service ON d43_drift_events
    FOR INSERT
    TO service_role
    WITH CHECK (true);

CREATE POLICY d43_drift_events_service_all ON d43_drift_events
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant permissions
GRANT SELECT, UPDATE ON d43_drift_events TO authenticated;
GRANT ALL ON d43_drift_events TO service_role;

-- ===========================================================================
-- VTID-01137: D43 Adaptation Plans Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS d43_adaptation_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    domains_to_update JSONB NOT NULL DEFAULT '[]'::jsonb,
    adaptation_strength INTEGER NOT NULL DEFAULT 0 CHECK (adaptation_strength >= 0 AND adaptation_strength <= 100),
    confirmation_needed BOOLEAN NOT NULL DEFAULT TRUE,
    confidence INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
    triggered_by_drift_id UUID REFERENCES d43_drift_events(id),
    triggered_by TEXT NOT NULL CHECK (triggered_by IN (
        'drift_detection', 'user_feedback', 'scheduled', 'manual'
    )),
    status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
        'proposed', 'pending_confirmation', 'approved', 'applied', 'rejected', 'rolled_back'
    )),
    can_rollback BOOLEAN NOT NULL DEFAULT TRUE,
    rollback_until TIMESTAMPTZ,
    snapshot_id UUID,
    proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    applied_at TIMESTAMPTZ,
    rejected_at TIMESTAMPTZ,
    rolled_back_at TIMESTAMPTZ,
    rollback_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_d43_adaptation_plans_tenant_user ON d43_adaptation_plans(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_d43_adaptation_plans_status ON d43_adaptation_plans(status);
CREATE INDEX IF NOT EXISTS idx_d43_adaptation_plans_user_status ON d43_adaptation_plans(user_id, status);
CREATE INDEX IF NOT EXISTS idx_d43_adaptation_plans_proposed_at ON d43_adaptation_plans(proposed_at DESC);
CREATE INDEX IF NOT EXISTS idx_d43_adaptation_plans_rollback ON d43_adaptation_plans(user_id, can_rollback, rollback_until);

-- Enable Row Level Security
ALTER TABLE d43_adaptation_plans ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY d43_adaptation_plans_select_own ON d43_adaptation_plans
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY d43_adaptation_plans_update_own ON d43_adaptation_plans
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY d43_adaptation_plans_service_all ON d43_adaptation_plans
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant permissions
GRANT SELECT, UPDATE ON d43_adaptation_plans TO authenticated;
GRANT ALL ON d43_adaptation_plans TO service_role;

-- ===========================================================================
-- VTID-01137: D43 Preference Snapshots Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS d43_preference_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    snapshot_type TEXT NOT NULL CHECK (snapshot_type IN (
        'before_adaptation', 'periodic', 'user_requested'
    )),
    domains JSONB NOT NULL DEFAULT '{}'::jsonb,
    adaptation_plan_id UUID REFERENCES d43_adaptation_plans(id),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_d43_snapshots_tenant_user ON d43_preference_snapshots(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_d43_snapshots_created_at ON d43_preference_snapshots(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_d43_snapshots_adaptation_plan ON d43_preference_snapshots(adaptation_plan_id);
CREATE INDEX IF NOT EXISTS idx_d43_snapshots_expires ON d43_preference_snapshots(expires_at) WHERE expires_at IS NOT NULL;

-- Enable Row Level Security
ALTER TABLE d43_preference_snapshots ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY d43_snapshots_select_own ON d43_preference_snapshots
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY d43_snapshots_service_all ON d43_preference_snapshots
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant permissions
GRANT SELECT ON d43_preference_snapshots TO authenticated;
GRANT ALL ON d43_preference_snapshots TO service_role;

-- ===========================================================================
-- VTID-01137: RPC Functions
-- ===========================================================================

-- Function to record a longitudinal data point
CREATE OR REPLACE FUNCTION d43_record_data_point(
    p_domain TEXT,
    p_key TEXT,
    p_value JSONB,
    p_numeric_value DOUBLE PRECISION DEFAULT NULL,
    p_source TEXT DEFAULT 'behavioral',
    p_confidence INTEGER DEFAULT 70,
    p_metadata JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_id UUID;
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

    -- Insert data point
    INSERT INTO d43_longitudinal_data_points (
        tenant_id, user_id, domain, key, value,
        numeric_value, source, confidence, metadata
    ) VALUES (
        v_tenant_id, v_user_id, p_domain, p_key, p_value,
        p_numeric_value, p_source, p_confidence, COALESCE(p_metadata, '{}'::jsonb)
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_id,
        'domain', p_domain,
        'key', p_key
    );
END;
$$;

-- Function to get data points for trend analysis
CREATE OR REPLACE FUNCTION d43_get_data_points(
    p_domains TEXT[] DEFAULT NULL,
    p_since TIMESTAMPTZ DEFAULT NULL,
    p_limit INTEGER DEFAULT 1000
)
RETURNS SETOF d43_longitudinal_data_points
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
    FROM d43_longitudinal_data_points
    WHERE user_id = v_user_id
      AND recorded_at >= v_since
      AND (p_domains IS NULL OR domain = ANY(p_domains))
    ORDER BY recorded_at DESC
    LIMIT p_limit;
END;
$$;

-- Function to get pending adaptation plans
CREATE OR REPLACE FUNCTION d43_get_pending_adaptations(
    p_limit INTEGER DEFAULT 10
)
RETURNS SETOF d43_adaptation_plans
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
    FROM d43_adaptation_plans
    WHERE user_id = v_user_id
      AND status IN ('proposed', 'pending_confirmation')
    ORDER BY proposed_at DESC
    LIMIT p_limit;
END;
$$;

-- Function to create an adaptation plan
CREATE OR REPLACE FUNCTION d43_create_adaptation_plan(
    p_plan JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_id UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    INSERT INTO d43_adaptation_plans (
        tenant_id, user_id, domains_to_update, adaptation_strength,
        confirmation_needed, confidence, triggered_by_drift_id, triggered_by,
        status, can_rollback, rollback_until
    ) VALUES (
        v_tenant_id,
        v_user_id,
        COALESCE(p_plan->>'domains_to_update', '[]')::jsonb,
        COALESCE((p_plan->>'adaptation_strength')::integer, 50),
        COALESCE((p_plan->>'confirmation_needed')::boolean, true),
        COALESCE((p_plan->>'confidence')::integer, 50),
        (p_plan->>'triggered_by_drift_id')::uuid,
        COALESCE(p_plan->>'triggered_by', 'drift_detection'),
        COALESCE(p_plan->>'status', 'proposed'),
        COALESCE((p_plan->>'can_rollback')::boolean, true),
        (p_plan->>'rollback_until')::timestamptz
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

-- Function to update adaptation plan status
CREATE OR REPLACE FUNCTION d43_update_adaptation_status(
    p_plan_id UUID,
    p_status TEXT,
    p_apply BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_old_status TEXT;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get current status
    SELECT status INTO v_old_status
    FROM d43_adaptation_plans
    WHERE id = p_plan_id AND user_id = v_user_id;

    IF v_old_status IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
    END IF;

    -- Update status
    UPDATE d43_adaptation_plans
    SET status = p_status,
        applied_at = CASE WHEN p_apply THEN NOW() ELSE applied_at END,
        rejected_at = CASE WHEN p_status = 'rejected' THEN NOW() ELSE rejected_at END,
        updated_at = NOW()
    WHERE id = p_plan_id AND user_id = v_user_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', p_plan_id,
        'old_status', v_old_status,
        'new_status', p_status
    );
END;
$$;

-- Function to rollback an adaptation
CREATE OR REPLACE FUNCTION d43_rollback_adaptation(
    p_plan_id UUID,
    p_reason TEXT DEFAULT 'User requested rollback'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_plan RECORD;
    v_snapshot_id UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get plan
    SELECT * INTO v_plan
    FROM d43_adaptation_plans
    WHERE id = p_plan_id AND user_id = v_user_id;

    IF v_plan IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
    END IF;

    IF NOT v_plan.can_rollback THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROLLBACK_NOT_ALLOWED');
    END IF;

    IF v_plan.rollback_until IS NOT NULL AND v_plan.rollback_until < NOW() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROLLBACK_EXPIRED');
    END IF;

    -- Get associated snapshot
    SELECT id INTO v_snapshot_id
    FROM d43_preference_snapshots
    WHERE adaptation_plan_id = p_plan_id
    ORDER BY created_at DESC
    LIMIT 1;

    -- Update plan status
    UPDATE d43_adaptation_plans
    SET status = 'rolled_back',
        rolled_back_at = NOW(),
        rollback_reason = p_reason,
        updated_at = NOW()
    WHERE id = p_plan_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', p_plan_id,
        'snapshot_id', v_snapshot_id
    );
END;
$$;

-- Function to acknowledge a drift event
CREATE OR REPLACE FUNCTION d43_acknowledge_drift(
    p_drift_id UUID,
    p_response TEXT
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

    UPDATE d43_drift_events
    SET acknowledged_by_user = true,
        acknowledged_at = NOW(),
        user_response = p_response,
        updated_at = NOW()
    WHERE id = p_drift_id AND user_id = v_user_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'id', p_drift_id,
        'response', p_response
    );
END;
$$;

-- Function to create a preference snapshot
CREATE OR REPLACE FUNCTION d43_create_snapshot(
    p_snapshot_type TEXT,
    p_adaptation_plan_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_id UUID;
    v_domains JSONB;
    v_expires_at TIMESTAMPTZ;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    -- Collect current preference state from various sources
    -- This is a simplified version - would aggregate from d27_preferences, etc.
    v_domains := jsonb_build_object(
        'snapshot_time', NOW(),
        'type', p_snapshot_type
    );

    -- Set expiry (30 days for rollback support)
    v_expires_at := NOW() + INTERVAL '30 days';

    INSERT INTO d43_preference_snapshots (
        tenant_id, user_id, snapshot_type, domains,
        adaptation_plan_id, expires_at
    ) VALUES (
        v_tenant_id, v_user_id, p_snapshot_type, v_domains,
        p_adaptation_plan_id, v_expires_at
    )
    RETURNING id INTO v_id;

    -- If this is for an adaptation plan, link it back
    IF p_adaptation_plan_id IS NOT NULL THEN
        UPDATE d43_adaptation_plans
        SET snapshot_id = v_id
        WHERE id = p_adaptation_plan_id AND user_id = v_user_id;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_id,
        'type', p_snapshot_type,
        'expires_at', v_expires_at
    );
END;
$$;

-- ===========================================================================
-- Grant execute permissions on functions
-- ===========================================================================

GRANT EXECUTE ON FUNCTION d43_record_data_point TO authenticated;
GRANT EXECUTE ON FUNCTION d43_get_data_points TO authenticated;
GRANT EXECUTE ON FUNCTION d43_get_pending_adaptations TO authenticated;
GRANT EXECUTE ON FUNCTION d43_create_adaptation_plan TO authenticated;
GRANT EXECUTE ON FUNCTION d43_update_adaptation_status TO authenticated;
GRANT EXECUTE ON FUNCTION d43_rollback_adaptation TO authenticated;
GRANT EXECUTE ON FUNCTION d43_acknowledge_drift TO authenticated;
GRANT EXECUTE ON FUNCTION d43_create_snapshot TO authenticated;

GRANT EXECUTE ON FUNCTION d43_record_data_point TO service_role;
GRANT EXECUTE ON FUNCTION d43_get_data_points TO service_role;
GRANT EXECUTE ON FUNCTION d43_get_pending_adaptations TO service_role;
GRANT EXECUTE ON FUNCTION d43_create_adaptation_plan TO service_role;
GRANT EXECUTE ON FUNCTION d43_update_adaptation_status TO service_role;
GRANT EXECUTE ON FUNCTION d43_rollback_adaptation TO service_role;
GRANT EXECUTE ON FUNCTION d43_acknowledge_drift TO service_role;
GRANT EXECUTE ON FUNCTION d43_create_snapshot TO service_role;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON TABLE d43_longitudinal_data_points IS 'VTID-01137: D43 Longitudinal data points for trend analysis. Tracks user behavior/preference signals over time.';
COMMENT ON TABLE d43_drift_events IS 'VTID-01137: D43 Detected drift events when user behavior/preferences deviate from baseline.';
COMMENT ON TABLE d43_adaptation_plans IS 'VTID-01137: D43 Adaptation plans proposed based on detected drift. Requires user confirmation for major changes.';
COMMENT ON TABLE d43_preference_snapshots IS 'VTID-01137: D43 Preference snapshots for rollback support. Captures state before adaptations.';

COMMENT ON FUNCTION d43_record_data_point IS 'VTID-01137: Record a longitudinal data point for trend tracking.';
COMMENT ON FUNCTION d43_get_data_points IS 'VTID-01137: Get data points for trend analysis within a time window.';
COMMENT ON FUNCTION d43_get_pending_adaptations IS 'VTID-01137: Get pending adaptation plans awaiting user action.';
COMMENT ON FUNCTION d43_create_adaptation_plan IS 'VTID-01137: Create a new adaptation plan.';
COMMENT ON FUNCTION d43_update_adaptation_status IS 'VTID-01137: Update adaptation plan status (approve/reject).';
COMMENT ON FUNCTION d43_rollback_adaptation IS 'VTID-01137: Rollback a previously applied adaptation.';
COMMENT ON FUNCTION d43_acknowledge_drift IS 'VTID-01137: Acknowledge a drift event with user response.';
COMMENT ON FUNCTION d43_create_snapshot IS 'VTID-01137: Create a preference snapshot for rollback support.';
