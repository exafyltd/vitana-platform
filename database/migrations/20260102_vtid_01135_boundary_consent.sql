-- Migration: 20260102_vtid_01135_boundary_consent.sql
-- Purpose: VTID-01135 D41 - Ethical Boundaries, Personal Limits & Consent Sensitivity Engine
-- Date: 2026-01-02
--
-- This migration creates the tables and functions for the Boundary & Consent
-- Sensitivity Engine, ensuring the system NEVER crosses personal, ethical,
-- or psychological boundaries.
--
-- Hard Constraints (Non-Negotiable):
--   - Never infer sensitive traits without explicit consent
--   - Never escalate intimacy or depth automatically
--   - Silence is NOT consent
--   - Emotional vulnerability suppresses monetization
--   - Default to protection when uncertain
--   - Boundaries override optimization goals

-- ===========================================================================
-- VTID-01135: Personal Boundaries Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS user_personal_boundaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Boundary levels (enum values stored as text)
    privacy_level TEXT NOT NULL DEFAULT 'moderate' CHECK (privacy_level IN ('open', 'moderate', 'guarded', 'private', 'strict')),
    privacy_score INTEGER NOT NULL DEFAULT 50 CHECK (privacy_score >= 0 AND privacy_score <= 100),

    health_sensitivity TEXT NOT NULL DEFAULT 'moderate' CHECK (health_sensitivity IN ('open', 'moderate', 'sensitive', 'restricted')),
    health_sensitivity_score INTEGER NOT NULL DEFAULT 50 CHECK (health_sensitivity_score >= 0 AND health_sensitivity_score <= 100),

    monetization_tolerance TEXT NOT NULL DEFAULT 'moderate' CHECK (monetization_tolerance IN ('open', 'moderate', 'limited', 'minimal', 'none')),
    monetization_score INTEGER NOT NULL DEFAULT 50 CHECK (monetization_score >= 0 AND monetization_score <= 100),

    social_exposure_limit TEXT NOT NULL DEFAULT 'moderate' CHECK (social_exposure_limit IN ('open', 'moderate', 'limited', 'minimal', 'none')),
    social_exposure_score INTEGER NOT NULL DEFAULT 50 CHECK (social_exposure_score >= 0 AND social_exposure_score <= 100),

    emotional_safety_level TEXT NOT NULL DEFAULT 'cautious' CHECK (emotional_safety_level IN ('stable', 'cautious', 'vulnerable', 'fragile')),
    emotional_safety_score INTEGER NOT NULL DEFAULT 50 CHECK (emotional_safety_score >= 0 AND emotional_safety_score <= 100),

    -- Source tracking
    source TEXT NOT NULL DEFAULT 'default' CHECK (source IN ('explicit', 'inferred', 'default')),
    confidence INTEGER NOT NULL DEFAULT 50 CHECK (confidence >= 0 AND confidence <= 100),

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Unique constraint: one boundary record per user per tenant
    CONSTRAINT unique_user_boundaries UNIQUE (tenant_id, user_id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_user_boundaries_tenant_id ON user_personal_boundaries(tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_boundaries_user_id ON user_personal_boundaries(user_id);
CREATE INDEX IF NOT EXISTS idx_user_boundaries_tenant_user ON user_personal_boundaries(tenant_id, user_id);

-- Enable RLS
ALTER TABLE user_personal_boundaries ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY user_boundaries_select_own ON user_personal_boundaries
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY user_boundaries_insert_own ON user_personal_boundaries
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY user_boundaries_update_own ON user_personal_boundaries
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY user_boundaries_service_all ON user_personal_boundaries
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON user_personal_boundaries TO authenticated;
GRANT ALL ON user_personal_boundaries TO service_role;

-- ===========================================================================
-- VTID-01135: Consent States Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS user_consent_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Consent topic
    topic TEXT NOT NULL CHECK (topic IN (
        'health_general', 'health_mental', 'health_physical', 'health_medications', 'health_conditions',
        'financial_general', 'financial_spending', 'financial_income', 'financial_investments',
        'social_introductions', 'social_group_activities', 'social_contact_sharing',
        'personal_relationships', 'personal_family', 'personal_work', 'personal_goals',
        'proactive_nudges', 'memory_surfacing', 'monetization_suggestions', 'autonomy_actions',
        'data_collection', 'data_sharing', 'third_party_access'
    )),

    -- Consent status
    status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('granted', 'denied', 'soft_refusal', 'revoked', 'expired', 'unknown')),
    confidence INTEGER NOT NULL DEFAULT 50 CHECK (confidence >= 0 AND confidence <= 100),

    -- Temporal tracking
    granted_at TIMESTAMPTZ,
    denied_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,

    -- Source tracking
    source TEXT NOT NULL DEFAULT 'explicit' CHECK (source IN ('explicit', 'behavioral', 'inferred')),
    source_reference TEXT,

    -- Reversibility
    can_revert BOOLEAN NOT NULL DEFAULT true,
    revert_cooldown_hours INTEGER NOT NULL DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Unique constraint: one consent state per topic per user per tenant
    CONSTRAINT unique_consent_state UNIQUE (tenant_id, user_id, topic)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_consent_states_tenant_id ON user_consent_states(tenant_id);
CREATE INDEX IF NOT EXISTS idx_consent_states_user_id ON user_consent_states(user_id);
CREATE INDEX IF NOT EXISTS idx_consent_states_topic ON user_consent_states(topic);
CREATE INDEX IF NOT EXISTS idx_consent_states_status ON user_consent_states(status);
CREATE INDEX IF NOT EXISTS idx_consent_states_tenant_user ON user_consent_states(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_consent_states_expires_at ON user_consent_states(expires_at) WHERE expires_at IS NOT NULL;

-- Enable RLS
ALTER TABLE user_consent_states ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY consent_states_select_own ON user_consent_states
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY consent_states_insert_own ON user_consent_states
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY consent_states_update_own ON user_consent_states
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY consent_states_delete_own ON user_consent_states
    FOR DELETE
    USING (auth.uid() = user_id);

CREATE POLICY consent_states_service_all ON user_consent_states
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON user_consent_states TO authenticated;
GRANT ALL ON user_consent_states TO service_role;

-- ===========================================================================
-- VTID-01135: Boundary Check Audit Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS boundary_check_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Check details
    check_id UUID NOT NULL,
    request_id UUID,
    session_id UUID,

    -- Action details
    action_type TEXT NOT NULL,
    action_details JSONB DEFAULT '{}'::jsonb,

    -- Result
    allowed BOOLEAN NOT NULL,
    boundary_type TEXT NOT NULL CHECK (boundary_type IN ('hard_boundary', 'soft_boundary', 'consent_required', 'topic_blocked', 'safe_to_proceed')),
    primary_domain TEXT CHECK (primary_domain IN ('health', 'social', 'financial', 'emotional', 'privacy', 'autonomy', 'content', 'system')),

    -- Evidence
    triggered_boundaries TEXT[] DEFAULT ARRAY[]::TEXT[],
    user_explanation TEXT,
    confidence INTEGER NOT NULL DEFAULT 100,

    -- Context snapshot (for debugging/audit)
    boundaries_snapshot JSONB DEFAULT '{}'::jsonb,
    consent_snapshot JSONB DEFAULT '{}'::jsonb,
    vulnerability_snapshot JSONB DEFAULT '{}'::jsonb,

    -- Performance
    check_duration_ms INTEGER NOT NULL DEFAULT 0,

    -- Timestamps
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_boundary_audit_tenant_id ON boundary_check_audit(tenant_id);
CREATE INDEX IF NOT EXISTS idx_boundary_audit_user_id ON boundary_check_audit(user_id);
CREATE INDEX IF NOT EXISTS idx_boundary_audit_check_id ON boundary_check_audit(check_id);
CREATE INDEX IF NOT EXISTS idx_boundary_audit_action_type ON boundary_check_audit(action_type);
CREATE INDEX IF NOT EXISTS idx_boundary_audit_allowed ON boundary_check_audit(allowed);
CREATE INDEX IF NOT EXISTS idx_boundary_audit_checked_at ON boundary_check_audit(checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_boundary_audit_tenant_user ON boundary_check_audit(tenant_id, user_id);

-- Enable RLS
ALTER TABLE boundary_check_audit ENABLE ROW LEVEL SECURITY;

-- RLS Policies (read-only for users, service can insert)
CREATE POLICY boundary_audit_select_own ON boundary_check_audit
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY boundary_audit_service_all ON boundary_check_audit
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant permissions
GRANT SELECT ON boundary_check_audit TO authenticated;
GRANT ALL ON boundary_check_audit TO service_role;

-- ===========================================================================
-- VTID-01135: RPC Functions
-- ===========================================================================

-- Get personal boundaries for current user
CREATE OR REPLACE FUNCTION d41_get_personal_boundaries()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_result JSONB;
BEGIN
    -- Get current user context
    v_user_id := auth.uid();

    -- For dev-sandbox, use the request context if available
    IF v_user_id IS NULL THEN
        v_user_id := current_setting('request.jwt.claims', true)::jsonb->>'sub';
    END IF;

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'privacy_level', 'moderate',
            'privacy_score', 50,
            'health_sensitivity', 'moderate',
            'health_sensitivity_score', 50,
            'monetization_tolerance', 'moderate',
            'monetization_score', 50,
            'social_exposure_limit', 'moderate',
            'social_exposure_score', 50,
            'emotional_safety_level', 'cautious',
            'emotional_safety_score', 50,
            'source', 'default',
            'confidence', 50
        );
    END IF;

    -- Get tenant from profile
    SELECT tenant_id INTO v_tenant_id
    FROM profiles
    WHERE id = v_user_id
    LIMIT 1;

    -- Get boundaries or return defaults
    SELECT jsonb_build_object(
        'privacy_level', b.privacy_level,
        'privacy_score', b.privacy_score,
        'health_sensitivity', b.health_sensitivity,
        'health_sensitivity_score', b.health_sensitivity_score,
        'monetization_tolerance', b.monetization_tolerance,
        'monetization_score', b.monetization_score,
        'social_exposure_limit', b.social_exposure_limit,
        'social_exposure_score', b.social_exposure_score,
        'emotional_safety_level', b.emotional_safety_level,
        'emotional_safety_score', b.emotional_safety_score,
        'source', b.source,
        'confidence', b.confidence,
        'last_updated', b.updated_at
    ) INTO v_result
    FROM user_personal_boundaries b
    WHERE b.user_id = v_user_id
    AND (v_tenant_id IS NULL OR b.tenant_id = v_tenant_id)
    LIMIT 1;

    -- Return defaults if no record found
    IF v_result IS NULL THEN
        v_result := jsonb_build_object(
            'privacy_level', 'moderate',
            'privacy_score', 50,
            'health_sensitivity', 'moderate',
            'health_sensitivity_score', 50,
            'monetization_tolerance', 'moderate',
            'monetization_score', 50,
            'social_exposure_limit', 'moderate',
            'social_exposure_score', 50,
            'emotional_safety_level', 'cautious',
            'emotional_safety_score', 50,
            'source', 'default',
            'confidence', 50
        );
    END IF;

    RETURN v_result;
END;
$$;

-- Set a personal boundary
CREATE OR REPLACE FUNCTION d41_set_personal_boundary(
    p_boundary_type TEXT,
    p_value TEXT,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_old_value TEXT;
    v_score INTEGER;
    v_action TEXT;
BEGIN
    -- Get current user
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        v_user_id := current_setting('request.jwt.claims', true)::jsonb->>'sub';
    END IF;

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get tenant
    SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = v_user_id LIMIT 1;
    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::UUID; -- Default tenant
    END IF;

    -- Calculate score based on value
    v_score := CASE
        WHEN p_value IN ('open', 'stable') THEN 20
        WHEN p_value = 'moderate' THEN 50
        WHEN p_value IN ('guarded', 'limited', 'cautious', 'sensitive') THEN 70
        WHEN p_value IN ('private', 'minimal', 'vulnerable', 'restricted') THEN 85
        WHEN p_value IN ('strict', 'none', 'fragile') THEN 100
        ELSE 50
    END;

    -- Try to get existing boundary
    EXECUTE format('SELECT %I FROM user_personal_boundaries WHERE user_id = $1 AND tenant_id = $2', p_boundary_type)
    INTO v_old_value
    USING v_user_id, v_tenant_id;

    -- Upsert boundary
    INSERT INTO user_personal_boundaries (
        tenant_id, user_id,
        privacy_level, privacy_score,
        health_sensitivity, health_sensitivity_score,
        monetization_tolerance, monetization_score,
        social_exposure_limit, social_exposure_score,
        emotional_safety_level, emotional_safety_score,
        source, confidence
    )
    VALUES (
        v_tenant_id, v_user_id,
        CASE WHEN p_boundary_type = 'privacy_level' THEN p_value ELSE 'moderate' END,
        CASE WHEN p_boundary_type = 'privacy_level' THEN v_score ELSE 50 END,
        CASE WHEN p_boundary_type = 'health_sensitivity' THEN p_value ELSE 'moderate' END,
        CASE WHEN p_boundary_type = 'health_sensitivity' THEN v_score ELSE 50 END,
        CASE WHEN p_boundary_type = 'monetization_tolerance' THEN p_value ELSE 'moderate' END,
        CASE WHEN p_boundary_type = 'monetization_tolerance' THEN v_score ELSE 50 END,
        CASE WHEN p_boundary_type = 'social_exposure_limit' THEN p_value ELSE 'moderate' END,
        CASE WHEN p_boundary_type = 'social_exposure_limit' THEN v_score ELSE 50 END,
        CASE WHEN p_boundary_type = 'emotional_safety_level' THEN p_value ELSE 'cautious' END,
        CASE WHEN p_boundary_type = 'emotional_safety_level' THEN v_score ELSE 50 END,
        'explicit', 100
    )
    ON CONFLICT (tenant_id, user_id)
    DO UPDATE SET
        privacy_level = CASE WHEN p_boundary_type = 'privacy_level' THEN p_value ELSE user_personal_boundaries.privacy_level END,
        privacy_score = CASE WHEN p_boundary_type = 'privacy_level' THEN v_score ELSE user_personal_boundaries.privacy_score END,
        health_sensitivity = CASE WHEN p_boundary_type = 'health_sensitivity' THEN p_value ELSE user_personal_boundaries.health_sensitivity END,
        health_sensitivity_score = CASE WHEN p_boundary_type = 'health_sensitivity' THEN v_score ELSE user_personal_boundaries.health_sensitivity_score END,
        monetization_tolerance = CASE WHEN p_boundary_type = 'monetization_tolerance' THEN p_value ELSE user_personal_boundaries.monetization_tolerance END,
        monetization_score = CASE WHEN p_boundary_type = 'monetization_tolerance' THEN v_score ELSE user_personal_boundaries.monetization_score END,
        social_exposure_limit = CASE WHEN p_boundary_type = 'social_exposure_limit' THEN p_value ELSE user_personal_boundaries.social_exposure_limit END,
        social_exposure_score = CASE WHEN p_boundary_type = 'social_exposure_limit' THEN v_score ELSE user_personal_boundaries.social_exposure_score END,
        emotional_safety_level = CASE WHEN p_boundary_type = 'emotional_safety_level' THEN p_value ELSE user_personal_boundaries.emotional_safety_level END,
        emotional_safety_score = CASE WHEN p_boundary_type = 'emotional_safety_level' THEN v_score ELSE user_personal_boundaries.emotional_safety_score END,
        source = 'explicit',
        confidence = 100,
        updated_at = NOW();

    v_action := CASE WHEN v_old_value IS NULL THEN 'boundary_created' ELSE 'boundary_updated' END;

    RETURN jsonb_build_object(
        'ok', true,
        'boundary_type', p_boundary_type,
        'old_value', v_old_value,
        'new_value', p_value,
        'action', v_action
    );
END;
$$;

-- Get consent bundle for current user
CREATE OR REPLACE FUNCTION d41_get_consent_bundle()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_consent_states JSONB;
    v_granted_count INTEGER;
    v_denied_count INTEGER;
BEGIN
    -- Get current user
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        v_user_id := current_setting('request.jwt.claims', true)::jsonb->>'sub';
    END IF;

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'consent_states', '[]'::jsonb,
            'default_stance', 'protective',
            'consent_count', 0,
            'granted_count', 0,
            'denied_count', 0,
            'generated_at', NOW()
        );
    END IF;

    -- Get tenant
    SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = v_user_id LIMIT 1;

    -- Expire old consents first
    UPDATE user_consent_states
    SET status = 'expired', updated_at = NOW()
    WHERE user_id = v_user_id
    AND (v_tenant_id IS NULL OR tenant_id = v_tenant_id)
    AND expires_at IS NOT NULL
    AND expires_at < NOW()
    AND status != 'expired';

    -- Get all consent states
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', c.id,
        'topic', c.topic,
        'status', c.status,
        'confidence', c.confidence,
        'granted_at', c.granted_at,
        'denied_at', c.denied_at,
        'expires_at', c.expires_at,
        'last_updated', c.updated_at,
        'source', c.source,
        'source_reference', c.source_reference,
        'can_revert', c.can_revert,
        'revert_cooldown_hours', c.revert_cooldown_hours
    )), '[]'::jsonb) INTO v_consent_states
    FROM user_consent_states c
    WHERE c.user_id = v_user_id
    AND (v_tenant_id IS NULL OR c.tenant_id = v_tenant_id);

    -- Count statuses
    SELECT
        COUNT(*) FILTER (WHERE status = 'granted'),
        COUNT(*) FILTER (WHERE status IN ('denied', 'revoked'))
    INTO v_granted_count, v_denied_count
    FROM user_consent_states
    WHERE user_id = v_user_id
    AND (v_tenant_id IS NULL OR tenant_id = v_tenant_id);

    RETURN jsonb_build_object(
        'consent_states', v_consent_states,
        'default_stance', 'protective',
        'consent_count', jsonb_array_length(v_consent_states),
        'granted_count', COALESCE(v_granted_count, 0),
        'denied_count', COALESCE(v_denied_count, 0),
        'generated_at', NOW()
    );
END;
$$;

-- Set consent for a topic
CREATE OR REPLACE FUNCTION d41_set_consent(
    p_topic TEXT,
    p_status TEXT,
    p_expires_at TIMESTAMPTZ DEFAULT NULL,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_consent_id UUID;
    v_action TEXT;
BEGIN
    -- Get current user
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        v_user_id := current_setting('request.jwt.claims', true)::jsonb->>'sub';
    END IF;

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get tenant
    SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = v_user_id LIMIT 1;
    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::UUID;
    END IF;

    -- Check if consent exists
    SELECT id INTO v_consent_id
    FROM user_consent_states
    WHERE user_id = v_user_id AND tenant_id = v_tenant_id AND topic = p_topic;

    IF v_consent_id IS NOT NULL THEN
        -- Update existing
        UPDATE user_consent_states
        SET
            status = p_status,
            confidence = 100,
            granted_at = CASE WHEN p_status = 'granted' THEN NOW() ELSE granted_at END,
            denied_at = CASE WHEN p_status IN ('denied', 'revoked') THEN NOW() ELSE denied_at END,
            expires_at = p_expires_at,
            source = 'explicit',
            source_reference = p_reason,
            updated_at = NOW()
        WHERE id = v_consent_id;

        v_action := 'consent_updated';
    ELSE
        -- Insert new
        INSERT INTO user_consent_states (
            tenant_id, user_id, topic, status, confidence,
            granted_at, denied_at, expires_at, source, source_reference
        )
        VALUES (
            v_tenant_id, v_user_id, p_topic, p_status, 100,
            CASE WHEN p_status = 'granted' THEN NOW() ELSE NULL END,
            CASE WHEN p_status IN ('denied', 'revoked') THEN NOW() ELSE NULL END,
            p_expires_at, 'explicit', p_reason
        )
        RETURNING id INTO v_consent_id;

        v_action := 'consent_created';
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_consent_id,
        'topic', p_topic,
        'status', p_status,
        'expires_at', p_expires_at,
        'action', v_action
    );
END;
$$;

-- Revoke consent for a topic
CREATE OR REPLACE FUNCTION d41_revoke_consent(
    p_topic TEXT,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_consent_id UUID;
    v_previous_status TEXT;
BEGIN
    -- Get current user
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        v_user_id := current_setting('request.jwt.claims', true)::jsonb->>'sub';
    END IF;

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get tenant
    SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = v_user_id LIMIT 1;

    -- Get existing consent
    SELECT id, status INTO v_consent_id, v_previous_status
    FROM user_consent_states
    WHERE user_id = v_user_id
    AND (v_tenant_id IS NULL OR tenant_id = v_tenant_id)
    AND topic = p_topic;

    IF v_consent_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'CONSENT_NOT_FOUND',
            'message', 'No consent record found for this topic'
        );
    END IF;

    -- Revoke consent
    UPDATE user_consent_states
    SET
        status = 'revoked',
        denied_at = NOW(),
        source_reference = COALESCE(p_reason, source_reference),
        updated_at = NOW()
    WHERE id = v_consent_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_consent_id,
        'topic', p_topic,
        'previous_status', v_previous_status
    );
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION d41_get_personal_boundaries() TO authenticated;
GRANT EXECUTE ON FUNCTION d41_set_personal_boundary(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION d41_get_consent_bundle() TO authenticated;
GRANT EXECUTE ON FUNCTION d41_set_consent(TEXT, TEXT, TIMESTAMPTZ, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION d41_revoke_consent(TEXT, TEXT) TO authenticated;

-- Service role gets all permissions
GRANT EXECUTE ON FUNCTION d41_get_personal_boundaries() TO service_role;
GRANT EXECUTE ON FUNCTION d41_set_personal_boundary(TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION d41_get_consent_bundle() TO service_role;
GRANT EXECUTE ON FUNCTION d41_set_consent(TEXT, TEXT, TIMESTAMPTZ, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION d41_revoke_consent(TEXT, TEXT) TO service_role;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON TABLE user_personal_boundaries IS 'VTID-01135 D41: Stores user personal boundary preferences (privacy, health sensitivity, monetization tolerance, etc.)';
COMMENT ON TABLE user_consent_states IS 'VTID-01135 D41: Tracks granular consent states per topic with temporal awareness. Silence is NOT consent.';
COMMENT ON TABLE boundary_check_audit IS 'VTID-01135 D41: Audit trail for all boundary checks. Used for debugging, safety review, and user trust.';

COMMENT ON FUNCTION d41_get_personal_boundaries() IS 'Get personal boundaries for the current user, returns defaults if not set';
COMMENT ON FUNCTION d41_set_personal_boundary(TEXT, TEXT, TEXT) IS 'Set a specific personal boundary type to a new value';
COMMENT ON FUNCTION d41_get_consent_bundle() IS 'Get all consent states for the current user, auto-expires old consents';
COMMENT ON FUNCTION d41_set_consent(TEXT, TEXT, TIMESTAMPTZ, TEXT) IS 'Set consent status for a specific topic';
COMMENT ON FUNCTION d41_revoke_consent(TEXT, TEXT) IS 'Revoke consent for a specific topic';
