-- Migration: 20260102200000_vtid_01127_availability_readiness_engine.sql
-- Purpose: VTID-01127 Availability, Time-Window & Readiness Engine (D33)
-- Date: 2026-01-02
--
-- Creates the Availability, Time-Window & Readiness Engine that determines
-- how much and how deep the system should act right now.
--
-- Core question: "Is this a moment for a quick nudge, a short flow, or a deep engagement?"
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01120 (D28) - Emotional & Cognitive Signals
--   - VTID-01119 (D27) - User Preferences
--   - VTID-01118 (D26) - Cross-Turn State
--
-- Hard Constraints (Non-Negotiable):
--   - Default to LOWER depth when uncertain
--   - Never stack multiple asks in low availability
--   - Monetization requires readiness_score >= threshold
--   - User overrides always win immediately

-- ===========================================================================
-- 1. availability_assessments (Persisted availability bundles for audit trail)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.availability_assessments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    session_id UUID NULL,
    turn_id UUID NULL,

    -- Availability Assessment
    availability_level TEXT NOT NULL DEFAULT 'unknown'
        CHECK (availability_level IN ('low', 'medium', 'high', 'unknown')),
    availability_confidence INT NOT NULL DEFAULT 50
        CHECK (availability_confidence >= 0 AND availability_confidence <= 100),
    availability_factors JSONB NOT NULL DEFAULT '[]'::JSONB,
    -- Format: [{ "source": "", "signal": "", "contribution": -1.0 to 1.0, "confidence": 0-100 }]

    -- Time Window Assessment
    time_window TEXT NOT NULL DEFAULT 'short'
        CHECK (time_window IN ('immediate', 'short', 'extended', 'defer')),
    time_window_confidence INT NOT NULL DEFAULT 50
        CHECK (time_window_confidence >= 0 AND time_window_confidence <= 100),
    estimated_minutes INT NULL,
    time_window_factors JSONB NOT NULL DEFAULT '[]'::JSONB,

    -- Readiness Assessment
    readiness_score NUMERIC(3,2) NOT NULL DEFAULT 0.50
        CHECK (readiness_score >= 0 AND readiness_score <= 1),
    readiness_confidence INT NOT NULL DEFAULT 50
        CHECK (readiness_confidence >= 0 AND readiness_confidence <= 100),
    readiness_factors JSONB NOT NULL DEFAULT '[]'::JSONB,
    risk_flags JSONB NOT NULL DEFAULT '[]'::JSONB,
    -- Format: [{ "type": "", "severity": "low|medium|high", "reason": "" }]

    -- Action Depth Output
    action_depth JSONB NOT NULL DEFAULT '{}'::JSONB,
    -- Format: { "max_steps": n, "max_questions": n, "max_recommendations": n,
    --           "allow_booking": bool, "allow_payment": bool }

    -- Availability Tag
    availability_tag TEXT NOT NULL DEFAULT 'quick_only'
        CHECK (availability_tag IN ('quick_only', 'light_flow_ok', 'deep_flow_ok', 'defer_actions')),

    -- Override tracking
    was_user_override BOOLEAN NOT NULL DEFAULT false,

    -- Timestamps
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Disclaimer
    disclaimer TEXT NOT NULL DEFAULT 'Availability and readiness assessments are probabilistic behavioral observations, not definitive states.'
);

-- Index for efficient session lookups
CREATE INDEX IF NOT EXISTS idx_availability_assessments_session
    ON public.availability_assessments (tenant_id, user_id, session_id, computed_at DESC);

-- Index for recent assessments
CREATE INDEX IF NOT EXISTS idx_availability_assessments_recent
    ON public.availability_assessments (tenant_id, user_id, computed_at DESC);

-- ===========================================================================
-- 2. availability_overrides (User overrides - always win)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.availability_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    session_id UUID NULL,

    -- Override values
    availability_level TEXT NULL
        CHECK (availability_level IS NULL OR availability_level IN ('low', 'medium', 'high', 'unknown')),
    time_available_minutes INT NULL,
    readiness_override TEXT NULL
        CHECK (readiness_override IS NULL OR readiness_override IN ('ready', 'not_now', 'busy')),

    -- Reason (optional user-provided)
    reason TEXT NULL,

    -- Lifecycle
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,

    -- Unique constraint: one active override per session
    CONSTRAINT availability_overrides_unique_active
        UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, session_id, active)
);

-- Index for active override lookup
CREATE INDEX IF NOT EXISTS idx_availability_overrides_active
    ON public.availability_overrides (tenant_id, user_id, session_id, active)
    WHERE active = true;

-- ===========================================================================
-- 3. availability_config (Configurable thresholds per tenant)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.availability_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL UNIQUE,

    -- Readiness thresholds
    readiness_monetization_min NUMERIC(3,2) NOT NULL DEFAULT 0.60
        CHECK (readiness_monetization_min >= 0 AND readiness_monetization_min <= 1),
    readiness_deep_flow_min NUMERIC(3,2) NOT NULL DEFAULT 0.50
        CHECK (readiness_deep_flow_min >= 0 AND readiness_deep_flow_min <= 1),
    readiness_light_flow_min NUMERIC(3,2) NOT NULL DEFAULT 0.30
        CHECK (readiness_light_flow_min >= 0 AND readiness_light_flow_min <= 1),

    -- Time window boundaries (minutes)
    time_immediate_max INT NOT NULL DEFAULT 2,
    time_short_max INT NOT NULL DEFAULT 10,

    -- Response time signals (seconds)
    fast_response_threshold INT NOT NULL DEFAULT 5,
    slow_response_threshold INT NOT NULL DEFAULT 30,

    -- Override expiry (minutes)
    override_expiry_minutes INT NOT NULL DEFAULT 30,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert default config for dev tenant
INSERT INTO public.availability_config (
    tenant_id,
    readiness_monetization_min,
    readiness_deep_flow_min,
    readiness_light_flow_min,
    time_immediate_max,
    time_short_max,
    fast_response_threshold,
    slow_response_threshold,
    override_expiry_minutes
) VALUES (
    '00000000-0000-0000-0000-000000000001',
    0.60,
    0.50,
    0.30,
    2,
    10,
    5,
    30,
    30
) ON CONFLICT (tenant_id) DO NOTHING;

-- ===========================================================================
-- 4. RLS Policies
-- ===========================================================================

-- Enable RLS on all tables
ALTER TABLE public.availability_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.availability_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.availability_config ENABLE ROW LEVEL SECURITY;

-- Policy for availability_assessments: Users can read their own assessments
CREATE POLICY availability_assessments_select_own
    ON public.availability_assessments
    FOR SELECT
    USING (user_id = auth.uid());

-- Policy for availability_overrides: Users can manage their own overrides
CREATE POLICY availability_overrides_select_own
    ON public.availability_overrides
    FOR SELECT
    USING (user_id = auth.uid());

CREATE POLICY availability_overrides_insert_own
    ON public.availability_overrides
    FOR INSERT
    WITH CHECK (user_id = auth.uid());

CREATE POLICY availability_overrides_update_own
    ON public.availability_overrides
    FOR UPDATE
    USING (user_id = auth.uid());

-- Policy for availability_config: Read-only for users in tenant
CREATE POLICY availability_config_select_tenant
    ON public.availability_config
    FOR SELECT
    USING (tenant_id IN (
        SELECT tenant_id FROM public.profiles WHERE id = auth.uid()
    ));

-- Service role bypass for all tables
CREATE POLICY availability_assessments_service_bypass
    ON public.availability_assessments
    FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY availability_overrides_service_bypass
    ON public.availability_overrides
    FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY availability_config_service_bypass
    ON public.availability_config
    FOR ALL
    USING (auth.role() = 'service_role');

-- ===========================================================================
-- 5. RPC Functions
-- ===========================================================================

-- Compute and persist availability assessment
CREATE OR REPLACE FUNCTION public.availability_compute(
    p_session_id UUID DEFAULT NULL,
    p_turn_id UUID DEFAULT NULL,
    p_availability_level TEXT DEFAULT 'unknown',
    p_availability_confidence INT DEFAULT 50,
    p_availability_factors JSONB DEFAULT '[]'::JSONB,
    p_time_window TEXT DEFAULT 'short',
    p_time_window_confidence INT DEFAULT 50,
    p_estimated_minutes INT DEFAULT NULL,
    p_time_window_factors JSONB DEFAULT '[]'::JSONB,
    p_readiness_score NUMERIC DEFAULT 0.50,
    p_readiness_confidence INT DEFAULT 50,
    p_readiness_factors JSONB DEFAULT '[]'::JSONB,
    p_risk_flags JSONB DEFAULT '[]'::JSONB,
    p_action_depth JSONB DEFAULT '{}'::JSONB,
    p_availability_tag TEXT DEFAULT 'quick_only',
    p_was_user_override BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_assessment_id UUID;
    v_expires_at TIMESTAMPTZ;
BEGIN
    -- Get context
    v_tenant_id := current_setting('request.jwt.claims', true)::json->>'tenant_id';
    v_user_id := auth.uid();

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001';
    END IF;

    IF v_user_id IS NULL THEN
        v_user_id := '00000000-0000-0000-0000-000000000099';
    END IF;

    -- Set expiry (5 minutes)
    v_expires_at := NOW() + INTERVAL '5 minutes';

    -- Insert assessment
    INSERT INTO public.availability_assessments (
        tenant_id,
        user_id,
        session_id,
        turn_id,
        availability_level,
        availability_confidence,
        availability_factors,
        time_window,
        time_window_confidence,
        estimated_minutes,
        time_window_factors,
        readiness_score,
        readiness_confidence,
        readiness_factors,
        risk_flags,
        action_depth,
        availability_tag,
        was_user_override,
        expires_at
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_session_id,
        p_turn_id,
        p_availability_level,
        p_availability_confidence,
        p_availability_factors,
        p_time_window,
        p_time_window_confidence,
        p_estimated_minutes,
        p_time_window_factors,
        p_readiness_score,
        p_readiness_confidence,
        p_readiness_factors,
        p_risk_flags,
        p_action_depth,
        p_availability_tag,
        p_was_user_override,
        v_expires_at
    )
    RETURNING id INTO v_assessment_id;

    RETURN jsonb_build_object(
        'ok', true,
        'assessment_id', v_assessment_id,
        'availability_level', p_availability_level,
        'time_window', p_time_window,
        'readiness_score', p_readiness_score,
        'availability_tag', p_availability_tag,
        'expires_at', v_expires_at
    );
END;
$$;

-- Get current active override for a session
CREATE OR REPLACE FUNCTION public.availability_get_override(
    p_session_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_override RECORD;
BEGIN
    -- Get context
    v_tenant_id := current_setting('request.jwt.claims', true)::json->>'tenant_id';
    v_user_id := auth.uid();

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001';
    END IF;

    IF v_user_id IS NULL THEN
        v_user_id := '00000000-0000-0000-0000-000000000099';
    END IF;

    -- Get active override
    SELECT *
    INTO v_override
    FROM public.availability_overrides
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND (session_id = p_session_id OR (session_id IS NULL AND p_session_id IS NULL))
      AND active = true
      AND expires_at > NOW()
    LIMIT 1;

    IF v_override IS NULL THEN
        RETURN jsonb_build_object(
            'ok', true,
            'has_override', false
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'has_override', true,
        'override_id', v_override.id,
        'availability_level', v_override.availability_level,
        'time_available_minutes', v_override.time_available_minutes,
        'readiness_override', v_override.readiness_override,
        'expires_at', v_override.expires_at
    );
END;
$$;

-- Set user override
CREATE OR REPLACE FUNCTION public.availability_set_override(
    p_session_id UUID DEFAULT NULL,
    p_availability_level TEXT DEFAULT NULL,
    p_time_available_minutes INT DEFAULT NULL,
    p_readiness_override TEXT DEFAULT NULL,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_override_id UUID;
    v_config RECORD;
    v_expires_at TIMESTAMPTZ;
BEGIN
    -- Get context
    v_tenant_id := current_setting('request.jwt.claims', true)::json->>'tenant_id';
    v_user_id := auth.uid();

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001';
    END IF;

    IF v_user_id IS NULL THEN
        v_user_id := '00000000-0000-0000-0000-000000000099';
    END IF;

    -- Get config for expiry time
    SELECT override_expiry_minutes INTO v_config
    FROM public.availability_config
    WHERE tenant_id = v_tenant_id;

    IF v_config IS NULL THEN
        v_expires_at := NOW() + INTERVAL '30 minutes';
    ELSE
        v_expires_at := NOW() + (v_config.override_expiry_minutes || ' minutes')::INTERVAL;
    END IF;

    -- Deactivate existing overrides
    UPDATE public.availability_overrides
    SET active = false
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND (session_id = p_session_id OR (session_id IS NULL AND p_session_id IS NULL))
      AND active = true;

    -- Insert new override
    INSERT INTO public.availability_overrides (
        tenant_id,
        user_id,
        session_id,
        availability_level,
        time_available_minutes,
        readiness_override,
        reason,
        active,
        expires_at
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_session_id,
        p_availability_level,
        p_time_available_minutes,
        p_readiness_override,
        p_reason,
        true,
        v_expires_at
    )
    RETURNING id INTO v_override_id;

    RETURN jsonb_build_object(
        'ok', true,
        'override_id', v_override_id,
        'availability_level', p_availability_level,
        'readiness_override', p_readiness_override,
        'expires_at', v_expires_at
    );
END;
$$;

-- Clear user override
CREATE OR REPLACE FUNCTION public.availability_clear_override(
    p_session_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_cleared INT;
BEGIN
    -- Get context
    v_tenant_id := current_setting('request.jwt.claims', true)::json->>'tenant_id';
    v_user_id := auth.uid();

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001';
    END IF;

    IF v_user_id IS NULL THEN
        v_user_id := '00000000-0000-0000-0000-000000000099';
    END IF;

    -- Deactivate overrides
    UPDATE public.availability_overrides
    SET active = false
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND (session_id = p_session_id OR (session_id IS NULL AND p_session_id IS NULL))
      AND active = true;

    GET DIAGNOSTICS v_cleared = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', true,
        'cleared', v_cleared > 0,
        'count', v_cleared
    );
END;
$$;

-- Get recent assessments for a session
CREATE OR REPLACE FUNCTION public.availability_get_recent(
    p_session_id UUID DEFAULT NULL,
    p_limit INT DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_assessments JSONB;
BEGIN
    -- Get context
    v_tenant_id := current_setting('request.jwt.claims', true)::json->>'tenant_id';
    v_user_id := auth.uid();

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001';
    END IF;

    IF v_user_id IS NULL THEN
        v_user_id := '00000000-0000-0000-0000-000000000099';
    END IF;

    SELECT jsonb_agg(
        jsonb_build_object(
            'id', a.id,
            'session_id', a.session_id,
            'availability_level', a.availability_level,
            'time_window', a.time_window,
            'readiness_score', a.readiness_score,
            'availability_tag', a.availability_tag,
            'was_user_override', a.was_user_override,
            'computed_at', a.computed_at
        ) ORDER BY a.computed_at DESC
    )
    INTO v_assessments
    FROM public.availability_assessments a
    WHERE a.tenant_id = v_tenant_id
      AND a.user_id = v_user_id
      AND (p_session_id IS NULL OR a.session_id = p_session_id)
    LIMIT p_limit;

    RETURN jsonb_build_object(
        'ok', true,
        'assessments', COALESCE(v_assessments, '[]'::JSONB),
        'count', jsonb_array_length(COALESCE(v_assessments, '[]'::JSONB))
    );
END;
$$;

-- ===========================================================================
-- 6. Cleanup function for expired data
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.availability_cleanup_expired()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_assessments_deleted INT;
    v_overrides_deleted INT;
BEGIN
    -- Delete expired assessments (older than 24 hours)
    DELETE FROM public.availability_assessments
    WHERE expires_at < NOW() - INTERVAL '24 hours';
    GET DIAGNOSTICS v_assessments_deleted = ROW_COUNT;

    -- Delete expired overrides
    DELETE FROM public.availability_overrides
    WHERE expires_at < NOW();
    GET DIAGNOSTICS v_overrides_deleted = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', true,
        'assessments_deleted', v_assessments_deleted,
        'overrides_deleted', v_overrides_deleted,
        'cleaned_at', NOW()
    );
END;
$$;

-- ===========================================================================
-- 7. Grant Permissions
-- ===========================================================================

-- Grant execute on functions
GRANT EXECUTE ON FUNCTION public.availability_compute TO authenticated;
GRANT EXECUTE ON FUNCTION public.availability_get_override TO authenticated;
GRANT EXECUTE ON FUNCTION public.availability_set_override TO authenticated;
GRANT EXECUTE ON FUNCTION public.availability_clear_override TO authenticated;
GRANT EXECUTE ON FUNCTION public.availability_get_recent TO authenticated;
GRANT EXECUTE ON FUNCTION public.availability_cleanup_expired TO service_role;

-- Grant table access for RLS
GRANT SELECT, INSERT ON public.availability_assessments TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.availability_overrides TO authenticated;
GRANT SELECT ON public.availability_config TO authenticated;

-- ===========================================================================
-- 8. Comments
-- ===========================================================================

COMMENT ON TABLE public.availability_assessments IS 'VTID-01127: D33 Availability assessments - persisted for audit trail';
COMMENT ON TABLE public.availability_overrides IS 'VTID-01127: D33 User overrides - always win immediately';
COMMENT ON TABLE public.availability_config IS 'VTID-01127: D33 Configuration - tunable thresholds per tenant';
COMMENT ON FUNCTION public.availability_compute IS 'VTID-01127: Compute and persist availability assessment';
COMMENT ON FUNCTION public.availability_set_override IS 'VTID-01127: Set user override (always wins)';
COMMENT ON FUNCTION public.availability_clear_override IS 'VTID-01127: Clear user override';
