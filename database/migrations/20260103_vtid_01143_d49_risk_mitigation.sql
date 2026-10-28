-- Migration: 20260103_vtid_01143_d49_risk_mitigation.sql
-- Purpose: VTID-01143 D49 Proactive Health & Lifestyle Risk Mitigation Layer
-- Date: 2026-01-03
--
-- This migration creates tables and functions for the D49 Risk Mitigation system
-- that translates risk windows (D45) and early signals (D44) into low-friction
-- mitigation suggestions that reduce downside before harm occurs.
--
-- HARD GOVERNANCE (NON-NEGOTIABLE):
--   - Safety > optimization
--   - No diagnosis, no treatment
--   - No medical claims
--   - Suggestions only, never actions
--   - Explainability mandatory
--   - All outputs logged to OASIS
--
-- Core Tables:
--   - risk_mitigations: Generated mitigation suggestions

-- ===========================================================================
-- VTID-01143: Risk Mitigations Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS risk_mitigations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    risk_window_id UUID NOT NULL,

    -- Mitigation domain (exactly one per mitigation)
    domain TEXT NOT NULL CHECK (domain IN (
        'sleep',      -- Sleep & Recovery
        'nutrition',  -- Nutrition & Hydration
        'movement',   -- Movement & Activity
        'mental',     -- Mental Load & Stress
        'routine',    -- Routine Stability
        'social'      -- Social Balance
    )),

    -- Confidence and content
    confidence INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
    suggested_adjustment TEXT NOT NULL,  -- Plain language suggestion
    why_this_helps TEXT NOT NULL,        -- Short explanation
    effort_level TEXT NOT NULL DEFAULT 'low' CHECK (effort_level = 'low'),  -- D49 only generates low effort

    -- Source tracking
    source_signals UUID[] DEFAULT '{}',
    precedent_type TEXT CHECK (precedent_type IN ('user_history', 'general_safety')),

    -- Safety (always present)
    disclaimer TEXT NOT NULL DEFAULT 'This is a gentle suggestion, not medical advice. Feel free to dismiss if not relevant.',

    -- Lifecycle status
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
        'active',       -- Currently displayed/available
        'dismissed',    -- User dismissed
        'acknowledged', -- User viewed
        'expired',      -- Time window passed
        'superseded'    -- Replaced by newer
    )),

    -- Timestamps
    expires_at TIMESTAMPTZ,
    dismissed_at TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ,
    dismiss_reason TEXT CHECK (dismiss_reason IN (
        'not_relevant', 'already_doing', 'not_now', 'no_reason', NULL
    )),

    -- Determinism & versioning
    generated_by_version TEXT NOT NULL,
    input_hash TEXT NOT NULL,         -- For determinism verification
    suggestion_hash TEXT NOT NULL,    -- For cooldown deduplication

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_risk_mitigations_tenant_user ON risk_mitigations(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_risk_mitigations_user_status ON risk_mitigations(user_id, status);
CREATE INDEX IF NOT EXISTS idx_risk_mitigations_user_domain ON risk_mitigations(user_id, domain);
CREATE INDEX IF NOT EXISTS idx_risk_mitigations_created_at ON risk_mitigations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_mitigations_expires_at ON risk_mitigations(expires_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_risk_mitigations_risk_window ON risk_mitigations(risk_window_id);
CREATE INDEX IF NOT EXISTS idx_risk_mitigations_cooldown ON risk_mitigations(user_id, domain, suggestion_hash, created_at DESC);

-- Enable Row Level Security
ALTER TABLE risk_mitigations ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY risk_mitigations_select_own ON risk_mitigations
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY risk_mitigations_update_own ON risk_mitigations
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY risk_mitigations_insert_service ON risk_mitigations
    FOR INSERT
    TO service_role
    WITH CHECK (true);

CREATE POLICY risk_mitigations_service_all ON risk_mitigations
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant permissions
GRANT SELECT, UPDATE ON risk_mitigations TO authenticated;
GRANT ALL ON risk_mitigations TO service_role;

-- ===========================================================================
-- VTID-01143: RPC Functions
-- ===========================================================================

-- Function to get active mitigations for a user
CREATE OR REPLACE FUNCTION d49_get_active_mitigations(
    p_domains TEXT[] DEFAULT NULL,
    p_limit INTEGER DEFAULT 10
)
RETURNS SETOF risk_mitigations
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
    FROM risk_mitigations
    WHERE user_id = v_user_id
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > NOW())
      AND (p_domains IS NULL OR domain = ANY(p_domains))
    ORDER BY created_at DESC
    LIMIT p_limit;
END;
$$;

-- Function to dismiss a mitigation
CREATE OR REPLACE FUNCTION d49_dismiss_mitigation(
    p_mitigation_id UUID,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_exists BOOLEAN;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Check if mitigation exists and belongs to user
    SELECT EXISTS(
        SELECT 1 FROM risk_mitigations
        WHERE id = p_mitigation_id AND user_id = v_user_id
    ) INTO v_exists;

    IF NOT v_exists THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
    END IF;

    UPDATE risk_mitigations
    SET status = 'dismissed',
        dismissed_at = NOW(),
        dismiss_reason = p_reason,
        updated_at = NOW()
    WHERE id = p_mitigation_id AND user_id = v_user_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', p_mitigation_id,
        'dismissed_at', NOW()
    );
END;
$$;

-- Function to acknowledge a mitigation
CREATE OR REPLACE FUNCTION d49_acknowledge_mitigation(
    p_mitigation_id UUID
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

    UPDATE risk_mitigations
    SET status = 'acknowledged',
        acknowledged_at = NOW(),
        updated_at = NOW()
    WHERE id = p_mitigation_id
      AND user_id = v_user_id
      AND status = 'active';

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND_OR_NOT_ACTIVE');
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'id', p_mitigation_id,
        'acknowledged_at', NOW()
    );
END;
$$;

-- Function to get mitigation history
CREATE OR REPLACE FUNCTION d49_get_mitigation_history(
    p_domains TEXT[] DEFAULT NULL,
    p_statuses TEXT[] DEFAULT NULL,
    p_since TIMESTAMPTZ DEFAULT NULL,
    p_limit INTEGER DEFAULT 20
)
RETURNS SETOF risk_mitigations
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
    FROM risk_mitigations
    WHERE user_id = v_user_id
      AND created_at >= v_since
      AND (p_domains IS NULL OR domain = ANY(p_domains))
      AND (p_statuses IS NULL OR status = ANY(p_statuses))
    ORDER BY created_at DESC
    LIMIT p_limit;
END;
$$;

-- Function to check if similar mitigation was recently shown (cooldown check)
CREATE OR REPLACE FUNCTION d49_check_cooldown(
    p_domain TEXT,
    p_suggestion_hash TEXT,
    p_cooldown_days INTEGER DEFAULT 14
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_last_shown TIMESTAMPTZ;
    v_days_since INTEGER;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    SELECT created_at INTO v_last_shown
    FROM risk_mitigations
    WHERE user_id = v_user_id
      AND domain = p_domain
      AND suggestion_hash = p_suggestion_hash
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_last_shown IS NULL THEN
        RETURN jsonb_build_object(
            'ok', true,
            'on_cooldown', false,
            'can_show', true
        );
    END IF;

    v_days_since := EXTRACT(DAY FROM (NOW() - v_last_shown));

    RETURN jsonb_build_object(
        'ok', true,
        'on_cooldown', v_days_since < p_cooldown_days,
        'can_show', v_days_since >= p_cooldown_days,
        'last_shown', v_last_shown,
        'days_since', v_days_since,
        'cooldown_days', p_cooldown_days
    );
END;
$$;

-- Function to expire old mitigations (cleanup job)
CREATE OR REPLACE FUNCTION d49_expire_old_mitigations()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE risk_mitigations
    SET status = 'expired',
        updated_at = NOW()
    WHERE status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at < NOW();

    GET DIAGNOSTICS v_count = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', true,
        'expired_count', v_count
    );
END;
$$;

-- ===========================================================================
-- Grant execute permissions on functions
-- ===========================================================================

GRANT EXECUTE ON FUNCTION d49_get_active_mitigations TO authenticated;
GRANT EXECUTE ON FUNCTION d49_dismiss_mitigation TO authenticated;
GRANT EXECUTE ON FUNCTION d49_acknowledge_mitigation TO authenticated;
GRANT EXECUTE ON FUNCTION d49_get_mitigation_history TO authenticated;
GRANT EXECUTE ON FUNCTION d49_check_cooldown TO authenticated;
GRANT EXECUTE ON FUNCTION d49_expire_old_mitigations TO service_role;

GRANT EXECUTE ON FUNCTION d49_get_active_mitigations TO service_role;
GRANT EXECUTE ON FUNCTION d49_dismiss_mitigation TO service_role;
GRANT EXECUTE ON FUNCTION d49_acknowledge_mitigation TO service_role;
GRANT EXECUTE ON FUNCTION d49_get_mitigation_history TO service_role;
GRANT EXECUTE ON FUNCTION d49_check_cooldown TO service_role;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON TABLE risk_mitigations IS 'VTID-01143: D49 Risk mitigation suggestions generated from risk windows and early signals. Suggestions only, never actions.';

COMMENT ON COLUMN risk_mitigations.domain IS 'Mitigation domain: sleep, nutrition, movement, mental, routine, social';
COMMENT ON COLUMN risk_mitigations.suggested_adjustment IS 'Plain language suggestion using safe, non-prescriptive language';
COMMENT ON COLUMN risk_mitigations.why_this_helps IS 'Short explanation of why this may help';
COMMENT ON COLUMN risk_mitigations.effort_level IS 'Always low - D49 only generates low-effort suggestions';
COMMENT ON COLUMN risk_mitigations.precedent_type IS 'Whether suggestion has precedent in user history or general safety consensus';
COMMENT ON COLUMN risk_mitigations.suggestion_hash IS 'Hash for cooldown deduplication - prevents showing similar mitigations within 14 days';
COMMENT ON COLUMN risk_mitigations.input_hash IS 'Hash of inputs for determinism verification';

COMMENT ON FUNCTION d49_get_active_mitigations IS 'VTID-01143: Get active mitigations for the current user, optionally filtered by domain';
COMMENT ON FUNCTION d49_dismiss_mitigation IS 'VTID-01143: Dismiss a mitigation with optional reason';
COMMENT ON FUNCTION d49_acknowledge_mitigation IS 'VTID-01143: Mark a mitigation as acknowledged (viewed)';
COMMENT ON FUNCTION d49_get_mitigation_history IS 'VTID-01143: Get mitigation history for the current user';
COMMENT ON FUNCTION d49_check_cooldown IS 'VTID-01143: Check if a similar mitigation was recently shown (cooldown enforcement)';
COMMENT ON FUNCTION d49_expire_old_mitigations IS 'VTID-01143: Expire mitigations past their expiry time (cleanup job)';
