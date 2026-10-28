-- Migration: 20260103_vtid_01138_d44_signal_detection.sql
-- Purpose: VTID-01138 D44 Proactive Signal Detection & Early Intervention Engine
-- Date: 2026-01-03
--
-- This migration creates tables and functions for the D44 Signal Detection system
-- that proactively identifies early weak signals indicating potential future risk
-- or opportunity across health, behavior, routines, social patterns, and preferences.
--
-- Core Tables:
--   - d44_predictive_signals: Detected signals with evidence and recommendations
--   - d44_signal_evidence: Evidence references linked to signals
--   - d44_intervention_history: History of acknowledged/actioned signals

-- ===========================================================================
-- VTID-01138: D44 Predictive Signals Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS d44_predictive_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    signal_type TEXT NOT NULL CHECK (signal_type IN (
        'health_drift',
        'behavioral_drift',
        'routine_instability',
        'cognitive_load_increase',
        'social_withdrawal',
        'social_overload',
        'preference_shift',
        'positive_momentum'
    )),
    confidence INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
    time_window TEXT NOT NULL,  -- e.g., 'last_7_days', 'last_14_days', 'last_30_days'
    detected_change TEXT NOT NULL,  -- Plain language description of what changed
    user_impact TEXT NOT NULL CHECK (user_impact IN ('low', 'medium', 'high')),
    suggested_action TEXT NOT NULL CHECK (suggested_action IN (
        'awareness', 'reflection', 'check_in'
    )),
    explainability_text TEXT NOT NULL,  -- Plain language explanation for user
    evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),

    -- Detection metadata
    detection_source TEXT NOT NULL DEFAULT 'engine' CHECK (detection_source IN (
        'engine', 'manual', 'scheduled'
    )),
    domains_analyzed TEXT[] NOT NULL DEFAULT '{}',
    data_points_analyzed INTEGER NOT NULL DEFAULT 0,

    -- State
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
        'active', 'acknowledged', 'dismissed', 'actioned', 'expired'
    )),
    acknowledged_at TIMESTAMPTZ,
    actioned_at TIMESTAMPTZ,
    user_feedback TEXT,  -- Optional user response

    -- Linking
    linked_drift_event_id UUID,  -- Optional link to D43 drift event
    linked_memory_refs TEXT[] DEFAULT '{}',
    linked_health_refs TEXT[] DEFAULT '{}',
    linked_context_refs TEXT[] DEFAULT '{}',

    -- Audit
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,  -- Signals expire after time window
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_d44_signals_tenant_user ON d44_predictive_signals(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_d44_signals_type ON d44_predictive_signals(signal_type);
CREATE INDEX IF NOT EXISTS idx_d44_signals_status ON d44_predictive_signals(status);
CREATE INDEX IF NOT EXISTS idx_d44_signals_user_status ON d44_predictive_signals(user_id, status);
CREATE INDEX IF NOT EXISTS idx_d44_signals_detected_at ON d44_predictive_signals(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_d44_signals_user_type_time ON d44_predictive_signals(user_id, signal_type, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_d44_signals_impact ON d44_predictive_signals(user_impact);
CREATE INDEX IF NOT EXISTS idx_d44_signals_expires ON d44_predictive_signals(expires_at) WHERE expires_at IS NOT NULL;

-- Enable Row Level Security
ALTER TABLE d44_predictive_signals ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY d44_signals_select_own ON d44_predictive_signals
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY d44_signals_update_own ON d44_predictive_signals
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY d44_signals_service_all ON d44_predictive_signals
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant permissions
GRANT SELECT, UPDATE ON d44_predictive_signals TO authenticated;
GRANT ALL ON d44_predictive_signals TO service_role;

-- ===========================================================================
-- VTID-01138: D44 Signal Evidence Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS d44_signal_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    signal_id UUID NOT NULL REFERENCES d44_predictive_signals(id) ON DELETE CASCADE,
    evidence_type TEXT NOT NULL CHECK (evidence_type IN (
        'memory', 'health', 'context', 'diary', 'calendar',
        'social', 'location', 'wearable', 'preference', 'behavior'
    )),
    source_ref TEXT NOT NULL,  -- Reference to source data (e.g., memory_id, health_feature_id)
    source_table TEXT NOT NULL,  -- Table name for traceability
    weight INTEGER NOT NULL DEFAULT 50 CHECK (weight >= 0 AND weight <= 100),  -- Contribution to signal
    summary TEXT NOT NULL,  -- Brief description of evidence
    recorded_at TIMESTAMPTZ NOT NULL,  -- When the source data was recorded
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_d44_evidence_signal ON d44_signal_evidence(signal_id);
CREATE INDEX IF NOT EXISTS idx_d44_evidence_tenant_user ON d44_signal_evidence(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_d44_evidence_type ON d44_signal_evidence(evidence_type);

-- Enable Row Level Security
ALTER TABLE d44_signal_evidence ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY d44_evidence_select_own ON d44_signal_evidence
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY d44_evidence_service_all ON d44_signal_evidence
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant permissions
GRANT SELECT ON d44_signal_evidence TO authenticated;
GRANT ALL ON d44_signal_evidence TO service_role;

-- ===========================================================================
-- VTID-01138: D44 Intervention History Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS d44_intervention_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    signal_id UUID NOT NULL REFERENCES d44_predictive_signals(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL CHECK (action_type IN (
        'acknowledged', 'dismissed', 'marked_helpful', 'marked_not_helpful',
        'took_action', 'reminder_set', 'shared'
    )),
    action_details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_d44_history_signal ON d44_intervention_history(signal_id);
CREATE INDEX IF NOT EXISTS idx_d44_history_tenant_user ON d44_intervention_history(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_d44_history_action_type ON d44_intervention_history(action_type);
CREATE INDEX IF NOT EXISTS idx_d44_history_created_at ON d44_intervention_history(created_at DESC);

-- Enable Row Level Security
ALTER TABLE d44_intervention_history ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY d44_history_select_own ON d44_intervention_history
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY d44_history_insert_own ON d44_intervention_history
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY d44_history_service_all ON d44_intervention_history
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant permissions
GRANT SELECT, INSERT ON d44_intervention_history TO authenticated;
GRANT ALL ON d44_intervention_history TO service_role;

-- ===========================================================================
-- VTID-01138: RPC Functions
-- ===========================================================================

-- Function to create a predictive signal
CREATE OR REPLACE FUNCTION d44_create_signal(
    p_signal JSONB
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
    v_expires_at TIMESTAMPTZ;
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

    -- Calculate expiration based on time window
    v_expires_at := CASE
        WHEN p_signal->>'time_window' = 'last_7_days' THEN NOW() + INTERVAL '7 days'
        WHEN p_signal->>'time_window' = 'last_14_days' THEN NOW() + INTERVAL '14 days'
        WHEN p_signal->>'time_window' = 'last_30_days' THEN NOW() + INTERVAL '30 days'
        ELSE NOW() + INTERVAL '14 days'
    END;

    -- Insert signal
    INSERT INTO d44_predictive_signals (
        tenant_id, user_id, signal_type, confidence, time_window,
        detected_change, user_impact, suggested_action, explainability_text,
        evidence_count, detection_source, domains_analyzed, data_points_analyzed,
        linked_drift_event_id, linked_memory_refs, linked_health_refs, linked_context_refs,
        expires_at
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_signal->>'signal_type',
        COALESCE((p_signal->>'confidence')::integer, 70),
        COALESCE(p_signal->>'time_window', 'last_14_days'),
        p_signal->>'detected_change',
        COALESCE(p_signal->>'user_impact', 'medium'),
        COALESCE(p_signal->>'suggested_action', 'awareness'),
        p_signal->>'explainability_text',
        COALESCE((p_signal->>'evidence_count')::integer, 0),
        COALESCE(p_signal->>'detection_source', 'engine'),
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_signal->'domains_analyzed')), '{}'),
        COALESCE((p_signal->>'data_points_analyzed')::integer, 0),
        (p_signal->>'linked_drift_event_id')::uuid,
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_signal->'linked_memory_refs')), '{}'),
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_signal->'linked_health_refs')), '{}'),
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_signal->'linked_context_refs')), '{}'),
        v_expires_at
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_id,
        'signal_type', p_signal->>'signal_type',
        'expires_at', v_expires_at
    );
END;
$$;

-- Function to add evidence to a signal
CREATE OR REPLACE FUNCTION d44_add_signal_evidence(
    p_signal_id UUID,
    p_evidence JSONB
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
    v_signal_exists BOOLEAN;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Verify signal exists and belongs to user
    SELECT EXISTS(
        SELECT 1 FROM d44_predictive_signals
        WHERE id = p_signal_id AND user_id = v_user_id
    ) INTO v_signal_exists;

    IF NOT v_signal_exists THEN
        RETURN jsonb_build_object('ok', false, 'error', 'SIGNAL_NOT_FOUND');
    END IF;

    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    INSERT INTO d44_signal_evidence (
        tenant_id, user_id, signal_id, evidence_type, source_ref,
        source_table, weight, summary, recorded_at
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_signal_id,
        p_evidence->>'evidence_type',
        p_evidence->>'source_ref',
        p_evidence->>'source_table',
        COALESCE((p_evidence->>'weight')::integer, 50),
        p_evidence->>'summary',
        COALESCE((p_evidence->>'recorded_at')::timestamptz, NOW())
    )
    RETURNING id INTO v_id;

    -- Update evidence count on signal
    UPDATE d44_predictive_signals
    SET evidence_count = evidence_count + 1,
        updated_at = NOW()
    WHERE id = p_signal_id;

    RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

-- Function to get active signals for a user
CREATE OR REPLACE FUNCTION d44_get_active_signals(
    p_signal_types TEXT[] DEFAULT NULL,
    p_min_confidence INTEGER DEFAULT 0,
    p_limit INTEGER DEFAULT 20
)
RETURNS SETOF d44_predictive_signals
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
    FROM d44_predictive_signals
    WHERE user_id = v_user_id
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > NOW())
      AND confidence >= p_min_confidence
      AND (p_signal_types IS NULL OR signal_type = ANY(p_signal_types))
    ORDER BY
        CASE user_impact
            WHEN 'high' THEN 1
            WHEN 'medium' THEN 2
            WHEN 'low' THEN 3
        END,
        confidence DESC,
        detected_at DESC
    LIMIT p_limit;
END;
$$;

-- Function to get signal evidence
CREATE OR REPLACE FUNCTION d44_get_signal_evidence(
    p_signal_id UUID
)
RETURNS SETOF d44_signal_evidence
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
    FROM d44_signal_evidence
    WHERE signal_id = p_signal_id
      AND user_id = v_user_id
    ORDER BY weight DESC, recorded_at DESC;
END;
$$;

-- Function to update signal status
CREATE OR REPLACE FUNCTION d44_update_signal_status(
    p_signal_id UUID,
    p_status TEXT,
    p_feedback TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_old_status TEXT;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get current status
    SELECT status INTO v_old_status
    FROM d44_predictive_signals
    WHERE id = p_signal_id AND user_id = v_user_id;

    IF v_old_status IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
    END IF;

    -- Update status
    UPDATE d44_predictive_signals
    SET status = p_status,
        acknowledged_at = CASE WHEN p_status = 'acknowledged' THEN NOW() ELSE acknowledged_at END,
        actioned_at = CASE WHEN p_status = 'actioned' THEN NOW() ELSE actioned_at END,
        user_feedback = COALESCE(p_feedback, user_feedback),
        updated_at = NOW()
    WHERE id = p_signal_id AND user_id = v_user_id;

    -- Get tenant for history
    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    -- Record in history
    INSERT INTO d44_intervention_history (
        tenant_id, user_id, signal_id, action_type, action_details
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_signal_id,
        p_status,
        jsonb_build_object('feedback', p_feedback, 'old_status', v_old_status)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'id', p_signal_id,
        'old_status', v_old_status,
        'new_status', p_status
    );
END;
$$;

-- Function to record intervention action
CREATE OR REPLACE FUNCTION d44_record_intervention(
    p_signal_id UUID,
    p_action_type TEXT,
    p_action_details JSONB DEFAULT '{}'::jsonb
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
    v_signal_exists BOOLEAN;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Verify signal exists and belongs to user
    SELECT EXISTS(
        SELECT 1 FROM d44_predictive_signals
        WHERE id = p_signal_id AND user_id = v_user_id
    ) INTO v_signal_exists;

    IF NOT v_signal_exists THEN
        RETURN jsonb_build_object('ok', false, 'error', 'SIGNAL_NOT_FOUND');
    END IF;

    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    INSERT INTO d44_intervention_history (
        tenant_id, user_id, signal_id, action_type, action_details
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_signal_id,
        p_action_type,
        p_action_details
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

-- Function to get signal statistics
CREATE OR REPLACE FUNCTION d44_get_signal_stats(
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
    v_result JSONB;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    v_since := COALESCE(p_since, NOW() - INTERVAL '30 days');

    SELECT jsonb_build_object(
        'ok', true,
        'total_signals', COUNT(*),
        'active_signals', COUNT(*) FILTER (WHERE status = 'active'),
        'acknowledged_signals', COUNT(*) FILTER (WHERE status = 'acknowledged'),
        'dismissed_signals', COUNT(*) FILTER (WHERE status = 'dismissed'),
        'high_impact_signals', COUNT(*) FILTER (WHERE user_impact = 'high' AND status = 'active'),
        'by_type', (
            SELECT jsonb_object_agg(signal_type, cnt)
            FROM (
                SELECT signal_type, COUNT(*) as cnt
                FROM d44_predictive_signals
                WHERE user_id = v_user_id AND detected_at >= v_since
                GROUP BY signal_type
            ) type_counts
        ),
        'avg_confidence', ROUND(AVG(confidence)::numeric, 1),
        'since', v_since
    ) INTO v_result
    FROM d44_predictive_signals
    WHERE user_id = v_user_id
      AND detected_at >= v_since;

    RETURN v_result;
END;
$$;

-- ===========================================================================
-- Grant execute permissions on functions
-- ===========================================================================

GRANT EXECUTE ON FUNCTION d44_create_signal TO authenticated;
GRANT EXECUTE ON FUNCTION d44_add_signal_evidence TO authenticated;
GRANT EXECUTE ON FUNCTION d44_get_active_signals TO authenticated;
GRANT EXECUTE ON FUNCTION d44_get_signal_evidence TO authenticated;
GRANT EXECUTE ON FUNCTION d44_update_signal_status TO authenticated;
GRANT EXECUTE ON FUNCTION d44_record_intervention TO authenticated;
GRANT EXECUTE ON FUNCTION d44_get_signal_stats TO authenticated;

GRANT EXECUTE ON FUNCTION d44_create_signal TO service_role;
GRANT EXECUTE ON FUNCTION d44_add_signal_evidence TO service_role;
GRANT EXECUTE ON FUNCTION d44_get_active_signals TO service_role;
GRANT EXECUTE ON FUNCTION d44_get_signal_evidence TO service_role;
GRANT EXECUTE ON FUNCTION d44_update_signal_status TO service_role;
GRANT EXECUTE ON FUNCTION d44_record_intervention TO service_role;
GRANT EXECUTE ON FUNCTION d44_get_signal_stats TO service_role;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON TABLE d44_predictive_signals IS 'VTID-01138: D44 Predictive signals for proactive early intervention. Stores detected signals with evidence and recommendations.';
COMMENT ON TABLE d44_signal_evidence IS 'VTID-01138: D44 Evidence references linked to predictive signals. Enables full traceability.';
COMMENT ON TABLE d44_intervention_history IS 'VTID-01138: D44 History of user actions on predictive signals. Tracks acknowledgments and interventions.';

COMMENT ON FUNCTION d44_create_signal IS 'VTID-01138: Create a new predictive signal with evidence.';
COMMENT ON FUNCTION d44_add_signal_evidence IS 'VTID-01138: Add evidence to an existing signal.';
COMMENT ON FUNCTION d44_get_active_signals IS 'VTID-01138: Get active signals for the current user.';
COMMENT ON FUNCTION d44_get_signal_evidence IS 'VTID-01138: Get evidence for a specific signal.';
COMMENT ON FUNCTION d44_update_signal_status IS 'VTID-01138: Update signal status (acknowledge/dismiss/action).';
COMMENT ON FUNCTION d44_record_intervention IS 'VTID-01138: Record an intervention action on a signal.';
COMMENT ON FUNCTION d44_get_signal_stats IS 'VTID-01138: Get signal statistics for the current user.';
