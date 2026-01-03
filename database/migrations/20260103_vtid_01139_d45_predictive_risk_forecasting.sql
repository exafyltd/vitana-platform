-- Migration: 20260103_vtid_01139_d45_predictive_risk_forecasting.sql
-- Purpose: VTID-01139 D45 Predictive Risk Windows & Opportunity Forecasting Engine
-- Date: 2026-01-03
--
-- This migration creates tables and functions for the D45 Predictive Risk Forecasting system
-- that forecasts short-term and mid-term windows where the user is statistically more likely
-- to experience risk or opportunity.
--
-- Core Tables:
--   - d45_predictive_windows: Forecasted risk/opportunity windows
--   - d45_window_feedback: User feedback on window accuracy
--   - d45_forecast_history: History of forecast computations

-- ===========================================================================
-- VTID-01139: D45 Predictive Windows Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS d45_predictive_windows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    window_type TEXT NOT NULL CHECK (window_type IN ('risk', 'opportunity')),
    domain TEXT NOT NULL CHECK (domain IN (
        'health', 'behavior', 'social', 'cognitive', 'routine'
    )),
    time_horizon TEXT NOT NULL CHECK (time_horizon IN ('short', 'mid', 'long')),
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    confidence INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
    severity INTEGER CHECK (severity >= 0 AND severity <= 100),  -- For risk windows
    leverage INTEGER CHECK (leverage >= 0 AND leverage <= 100),  -- For opportunity windows
    drivers JSONB NOT NULL DEFAULT '[]'::jsonb,  -- Array of signal_id references
    driver_details JSONB DEFAULT '[]'::jsonb,    -- Full driver information
    historical_precedent TEXT,
    precedent_details JSONB DEFAULT NULL,
    recommended_mode TEXT NOT NULL CHECK (recommended_mode IN (
        'awareness', 'reflection', 'gentle_prep'
    )),
    explainability_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN (
        'active', 'upcoming', 'passed', 'invalidated', 'acknowledged'
    )),
    acknowledged_at TIMESTAMPTZ,
    invalidated_at TIMESTAMPTZ,
    invalidation_reason TEXT,
    forecast_id UUID,  -- Reference to the forecast computation that created this
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT d45_windows_end_after_start CHECK (end_time > start_time),
    CONSTRAINT d45_windows_severity_for_risk CHECK (
        (window_type = 'risk' AND severity IS NOT NULL) OR window_type = 'opportunity'
    ),
    CONSTRAINT d45_windows_leverage_for_opportunity CHECK (
        (window_type = 'opportunity' AND leverage IS NOT NULL) OR window_type = 'risk'
    )
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_d45_windows_tenant_user ON d45_predictive_windows(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_d45_windows_user_status ON d45_predictive_windows(user_id, status);
CREATE INDEX IF NOT EXISTS idx_d45_windows_user_type ON d45_predictive_windows(user_id, window_type);
CREATE INDEX IF NOT EXISTS idx_d45_windows_user_domain ON d45_predictive_windows(user_id, domain);
CREATE INDEX IF NOT EXISTS idx_d45_windows_start_time ON d45_predictive_windows(start_time);
CREATE INDEX IF NOT EXISTS idx_d45_windows_end_time ON d45_predictive_windows(end_time);
CREATE INDEX IF NOT EXISTS idx_d45_windows_user_time_range ON d45_predictive_windows(user_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_d45_windows_forecast_id ON d45_predictive_windows(forecast_id);
CREATE INDEX IF NOT EXISTS idx_d45_windows_created_at ON d45_predictive_windows(created_at DESC);

-- Enable Row Level Security
ALTER TABLE d45_predictive_windows ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY d45_windows_select_own ON d45_predictive_windows
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY d45_windows_update_own ON d45_predictive_windows
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY d45_windows_insert_service ON d45_predictive_windows
    FOR INSERT
    TO service_role
    WITH CHECK (true);

CREATE POLICY d45_windows_service_all ON d45_predictive_windows
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant permissions
GRANT SELECT, UPDATE ON d45_predictive_windows TO authenticated;
GRANT ALL ON d45_predictive_windows TO service_role;

-- ===========================================================================
-- VTID-01139: D45 Window Feedback Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS d45_window_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    window_id UUID NOT NULL REFERENCES d45_predictive_windows(id) ON DELETE CASCADE,
    feedback_type TEXT NOT NULL CHECK (feedback_type IN (
        'helpful', 'not_helpful', 'too_early', 'too_late', 'inaccurate'
    )),
    notes TEXT,
    outcome TEXT CHECK (outcome IN (
        'risk_materialized', 'opportunity_realized', 'neutral', 'unknown'
    )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_d45_feedback_tenant_user ON d45_window_feedback(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_d45_feedback_window_id ON d45_window_feedback(window_id);
CREATE INDEX IF NOT EXISTS idx_d45_feedback_feedback_type ON d45_window_feedback(feedback_type);
CREATE INDEX IF NOT EXISTS idx_d45_feedback_created_at ON d45_window_feedback(created_at DESC);

-- Enable Row Level Security
ALTER TABLE d45_window_feedback ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY d45_feedback_select_own ON d45_window_feedback
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY d45_feedback_insert_own ON d45_window_feedback
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY d45_feedback_service_all ON d45_window_feedback
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant permissions
GRANT SELECT, INSERT ON d45_window_feedback TO authenticated;
GRANT ALL ON d45_window_feedback TO service_role;

-- ===========================================================================
-- VTID-01139: D45 Forecast History Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS d45_forecast_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    horizons TEXT[] NOT NULL DEFAULT ARRAY['short', 'mid'],
    domains TEXT[] DEFAULT NULL,
    signals_analyzed INTEGER NOT NULL DEFAULT 0,
    patterns_matched INTEGER NOT NULL DEFAULT 0,
    risk_windows_generated INTEGER NOT NULL DEFAULT 0,
    opportunity_windows_generated INTEGER NOT NULL DEFAULT 0,
    computation_duration_ms INTEGER,
    input_summary JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_d45_forecast_history_tenant_user ON d45_forecast_history(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_d45_forecast_history_created_at ON d45_forecast_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_d45_forecast_history_user_recent ON d45_forecast_history(user_id, created_at DESC);

-- Enable Row Level Security
ALTER TABLE d45_forecast_history ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY d45_forecast_history_select_own ON d45_forecast_history
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY d45_forecast_history_insert_service ON d45_forecast_history
    FOR INSERT
    TO service_role
    WITH CHECK (true);

CREATE POLICY d45_forecast_history_service_all ON d45_forecast_history
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant permissions
GRANT SELECT ON d45_forecast_history TO authenticated;
GRANT ALL ON d45_forecast_history TO service_role;

-- ===========================================================================
-- VTID-01139: RPC Functions
-- ===========================================================================

-- Function to store a predictive window
CREATE OR REPLACE FUNCTION d45_store_window(
    p_window JSONB
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
    v_severity INTEGER;
    v_leverage INTEGER;
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

    -- Set severity/leverage based on window type
    IF p_window->>'window_type' = 'risk' THEN
        v_severity := COALESCE((p_window->>'confidence')::integer, 50);
        v_leverage := NULL;
    ELSE
        v_severity := NULL;
        v_leverage := COALESCE((p_window->>'confidence')::integer, 50);
    END IF;

    -- Insert window
    INSERT INTO d45_predictive_windows (
        id, tenant_id, user_id, window_type, domain, time_horizon,
        start_time, end_time, confidence, severity, leverage,
        drivers, historical_precedent, recommended_mode, explainability_text,
        status, forecast_id
    ) VALUES (
        COALESCE((p_window->>'window_id')::uuid, gen_random_uuid()),
        v_tenant_id,
        v_user_id,
        p_window->>'window_type',
        p_window->>'domain',
        COALESCE(p_window->>'time_horizon', 'short'),
        (p_window->>'start_time')::timestamptz,
        (p_window->>'end_time')::timestamptz,
        COALESCE((p_window->>'confidence')::integer, 50),
        v_severity,
        v_leverage,
        COALESCE(p_window->'drivers', '[]'::jsonb),
        p_window->>'historical_precedent',
        COALESCE(p_window->>'recommended_mode', 'awareness'),
        COALESCE(p_window->>'explainability_text', 'Forecast based on observed patterns.'),
        'upcoming',
        (p_window->>'forecast_id')::uuid
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_id,
        'window_type', p_window->>'window_type',
        'domain', p_window->>'domain'
    );
END;
$$;

-- Function to get windows with filters
CREATE OR REPLACE FUNCTION d45_get_windows(
    p_window_types TEXT[] DEFAULT NULL,
    p_domains TEXT[] DEFAULT NULL,
    p_status TEXT[] DEFAULT NULL,
    p_include_past BOOLEAN DEFAULT FALSE,
    p_limit INTEGER DEFAULT 20,
    p_offset INTEGER DEFAULT 0
)
RETURNS SETOF d45_predictive_windows
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
    FROM d45_predictive_windows
    WHERE user_id = v_user_id
      AND (p_window_types IS NULL OR window_type = ANY(p_window_types))
      AND (p_domains IS NULL OR domain = ANY(p_domains))
      AND (p_status IS NULL OR status = ANY(p_status))
      AND (p_include_past = TRUE OR end_time >= NOW() OR status = 'active')
    ORDER BY
        CASE status
            WHEN 'active' THEN 0
            WHEN 'upcoming' THEN 1
            WHEN 'acknowledged' THEN 2
            WHEN 'passed' THEN 3
            WHEN 'invalidated' THEN 4
        END,
        start_time ASC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

-- Function to get window details
CREATE OR REPLACE FUNCTION d45_get_window_details(
    p_window_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_window d45_predictive_windows;
    v_feedback JSONB;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    SELECT * INTO v_window
    FROM d45_predictive_windows
    WHERE id = p_window_id AND user_id = v_user_id;

    IF v_window IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
    END IF;

    -- Get associated feedback
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', f.id,
        'feedback_type', f.feedback_type,
        'notes', f.notes,
        'outcome', f.outcome,
        'created_at', f.created_at
    )), '[]'::jsonb) INTO v_feedback
    FROM d45_window_feedback f
    WHERE f.window_id = p_window_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_window.id,
        'tenant_id', v_window.tenant_id,
        'user_id', v_window.user_id,
        'window_id', v_window.id,
        'window_type', v_window.window_type,
        'domain', v_window.domain,
        'time_horizon', v_window.time_horizon,
        'start_time', v_window.start_time,
        'end_time', v_window.end_time,
        'confidence', v_window.confidence,
        'severity', v_window.severity,
        'leverage', v_window.leverage,
        'drivers', v_window.drivers,
        'driver_details', v_window.driver_details,
        'historical_precedent', v_window.historical_precedent,
        'precedent_details', v_window.precedent_details,
        'recommended_mode', v_window.recommended_mode,
        'explainability_text', v_window.explainability_text,
        'status', v_window.status,
        'acknowledged_at', v_window.acknowledged_at,
        'invalidated_at', v_window.invalidated_at,
        'invalidation_reason', v_window.invalidation_reason,
        'created_at', v_window.created_at,
        'updated_at', v_window.updated_at,
        'feedback', v_feedback
    );
END;
$$;

-- Function to acknowledge a window
CREATE OR REPLACE FUNCTION d45_acknowledge_window(
    p_window_id UUID,
    p_feedback TEXT DEFAULT NULL,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_window_exists BOOLEAN;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Check if window exists
    SELECT EXISTS(
        SELECT 1 FROM d45_predictive_windows
        WHERE id = p_window_id AND user_id = v_user_id
    ) INTO v_window_exists;

    IF NOT v_window_exists THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
    END IF;

    -- Update window status
    UPDATE d45_predictive_windows
    SET status = 'acknowledged',
        acknowledged_at = NOW(),
        updated_at = NOW()
    WHERE id = p_window_id AND user_id = v_user_id;

    -- Record feedback if provided
    IF p_feedback IS NOT NULL THEN
        SELECT raw_user_meta_data->>'tenant_id'
        INTO v_tenant_id
        FROM auth.users
        WHERE id = v_user_id;

        IF v_tenant_id IS NULL THEN
            v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
        END IF;

        INSERT INTO d45_window_feedback (
            tenant_id, user_id, window_id, feedback_type, notes
        ) VALUES (
            v_tenant_id, v_user_id, p_window_id, p_feedback, p_notes
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'window_id', p_window_id,
        'acknowledged_at', NOW()
    );
END;
$$;

-- Function to invalidate a window
CREATE OR REPLACE FUNCTION d45_invalidate_window(
    p_window_id UUID,
    p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_window_exists BOOLEAN;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Check if window exists
    SELECT EXISTS(
        SELECT 1 FROM d45_predictive_windows
        WHERE id = p_window_id AND user_id = v_user_id
    ) INTO v_window_exists;

    IF NOT v_window_exists THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
    END IF;

    -- Update window status
    UPDATE d45_predictive_windows
    SET status = 'invalidated',
        invalidated_at = NOW(),
        invalidation_reason = p_reason,
        updated_at = NOW()
    WHERE id = p_window_id AND user_id = v_user_id;

    RETURN jsonb_build_object(
        'ok', true,
        'window_id', p_window_id,
        'invalidated_at', NOW()
    );
END;
$$;

-- Function to update window statuses (run periodically)
-- Marks upcoming windows as active when they start
-- Marks active windows as passed when they end
CREATE OR REPLACE FUNCTION d45_update_window_statuses()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_updated_count INTEGER := 0;
BEGIN
    -- Mark windows as active when start_time has passed
    UPDATE d45_predictive_windows
    SET status = 'active',
        updated_at = NOW()
    WHERE status = 'upcoming'
      AND start_time <= NOW()
      AND end_time > NOW();

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    -- Mark windows as passed when end_time has passed
    UPDATE d45_predictive_windows
    SET status = 'passed',
        updated_at = NOW()
    WHERE status IN ('active', 'upcoming')
      AND end_time <= NOW();

    RETURN v_updated_count;
END;
$$;

-- Function to record forecast history
CREATE OR REPLACE FUNCTION d45_record_forecast_history(
    p_horizons TEXT[],
    p_domains TEXT[],
    p_signals_analyzed INTEGER,
    p_patterns_matched INTEGER,
    p_risk_windows INTEGER,
    p_opportunity_windows INTEGER,
    p_duration_ms INTEGER,
    p_input_summary JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
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
        RETURN NULL;
    END IF;

    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    INSERT INTO d45_forecast_history (
        tenant_id, user_id, horizons, domains,
        signals_analyzed, patterns_matched,
        risk_windows_generated, opportunity_windows_generated,
        computation_duration_ms, input_summary
    ) VALUES (
        v_tenant_id, v_user_id, p_horizons, p_domains,
        p_signals_analyzed, p_patterns_matched,
        p_risk_windows, p_opportunity_windows,
        p_duration_ms, p_input_summary
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- ===========================================================================
-- Grant execute permissions on functions
-- ===========================================================================

GRANT EXECUTE ON FUNCTION d45_store_window TO authenticated;
GRANT EXECUTE ON FUNCTION d45_get_windows TO authenticated;
GRANT EXECUTE ON FUNCTION d45_get_window_details TO authenticated;
GRANT EXECUTE ON FUNCTION d45_acknowledge_window TO authenticated;
GRANT EXECUTE ON FUNCTION d45_invalidate_window TO authenticated;
GRANT EXECUTE ON FUNCTION d45_record_forecast_history TO authenticated;

GRANT EXECUTE ON FUNCTION d45_store_window TO service_role;
GRANT EXECUTE ON FUNCTION d45_get_windows TO service_role;
GRANT EXECUTE ON FUNCTION d45_get_window_details TO service_role;
GRANT EXECUTE ON FUNCTION d45_acknowledge_window TO service_role;
GRANT EXECUTE ON FUNCTION d45_invalidate_window TO service_role;
GRANT EXECUTE ON FUNCTION d45_update_window_statuses TO service_role;
GRANT EXECUTE ON FUNCTION d45_record_forecast_history TO service_role;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON TABLE d45_predictive_windows IS 'VTID-01139: D45 Predictive windows forecasting risk and opportunity periods for users.';
COMMENT ON TABLE d45_window_feedback IS 'VTID-01139: D45 User feedback on window predictions for accuracy improvement.';
COMMENT ON TABLE d45_forecast_history IS 'VTID-01139: D45 History of forecast computations for auditing and analysis.';

COMMENT ON FUNCTION d45_store_window IS 'VTID-01139: Store a new predictive window.';
COMMENT ON FUNCTION d45_get_windows IS 'VTID-01139: Get predictive windows with optional filters.';
COMMENT ON FUNCTION d45_get_window_details IS 'VTID-01139: Get detailed information about a specific window.';
COMMENT ON FUNCTION d45_acknowledge_window IS 'VTID-01139: Acknowledge that user has seen/reviewed a window.';
COMMENT ON FUNCTION d45_invalidate_window IS 'VTID-01139: Invalidate a window due to new data.';
COMMENT ON FUNCTION d45_update_window_statuses IS 'VTID-01139: Update window statuses based on current time.';
COMMENT ON FUNCTION d45_record_forecast_history IS 'VTID-01139: Record forecast computation for auditing.';
