-- Migration: 20260102000000_vtid_01121_feedback_trust_repair.sql
-- Purpose: VTID-01121 User Feedback, Correction & Trust Repair Engine
-- Date: 2026-01-02
--
-- Creates the feedback processing and trust repair system for ORB:
--   - user_corrections: Records all user corrections with affected components
--   - behavior_constraints: Rejected behaviors that must not resurface
--   - trust_scores: Component-level trust scores
--   - correction_rules: Deterministic rules applied after corrections
--   - safety_flags: Safety escalation tracking
--   - feedback_propagation_log: Tracks downstream propagation
--
-- Feedback Types Supported:
--   - explicit_correction: "that's wrong"
--   - preference_clarification: User clarifies preferences
--   - boundary_enforcement: User sets hard boundaries
--   - tone_adjustment: Adjust communication style
--   - suggestion_rejection: User rejects suggestion
--   - autonomy_refusal: User declines ORB autonomy
--
-- Deterministic Rules:
--   - Same feedback → same correction outcome
--   - Corrections override inference
--   - Rejected behavior blocked permanently
--   - Feedback propagates to all downstream layers
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01104 (Memory Core v1) - memory_items table

-- ===========================================================================
-- 1. FEEDBACK TYPES ENUM
-- ===========================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'feedback_type_enum') THEN
        CREATE TYPE public.feedback_type_enum AS ENUM (
            'explicit_correction',
            'preference_clarification',
            'boundary_enforcement',
            'tone_adjustment',
            'suggestion_rejection',
            'autonomy_refusal'
        );
    END IF;
END$$;

-- ===========================================================================
-- 2. USER_CORRECTIONS TABLE - Core feedback recording
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.user_corrections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Feedback details
    feedback_type TEXT NOT NULL CHECK (feedback_type IN (
        'explicit_correction',
        'preference_clarification',
        'boundary_enforcement',
        'tone_adjustment',
        'suggestion_rejection',
        'autonomy_refusal'
    )),
    content TEXT NOT NULL CHECK (content != ''),
    context JSONB DEFAULT '{}',  -- conversation context, session info

    -- Affected components (for propagation)
    affected_component TEXT NOT NULL DEFAULT 'general' CHECK (affected_component IN (
        'general', 'memory', 'preferences', 'behavior', 'tone', 'autonomy', 'suggestions', 'health', 'relationships'
    )),
    affected_item_id UUID NULL,  -- Optional: specific memory item, preference, etc.
    affected_item_type TEXT NULL,

    -- Processing state
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'applied', 'propagated', 'failed')),
    processing_result JSONB DEFAULT NULL,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ NULL,

    -- Audit trail
    session_id TEXT NULL,
    source TEXT NOT NULL DEFAULT 'orb' CHECK (source IN ('orb', 'app', 'api', 'system'))
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_user_corrections_tenant_user_created
    ON public.user_corrections (tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_corrections_status
    ON public.user_corrections (tenant_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_user_corrections_type
    ON public.user_corrections (tenant_id, user_id, feedback_type);
CREATE INDEX IF NOT EXISTS idx_user_corrections_component
    ON public.user_corrections (tenant_id, user_id, affected_component);

-- Enable RLS
ALTER TABLE public.user_corrections ENABLE ROW LEVEL SECURITY;

-- RLS policies
DROP POLICY IF EXISTS user_corrections_select ON public.user_corrections;
CREATE POLICY user_corrections_select ON public.user_corrections
    FOR SELECT TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS user_corrections_insert ON public.user_corrections;
CREATE POLICY user_corrections_insert ON public.user_corrections
    FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS user_corrections_update ON public.user_corrections;
CREATE POLICY user_corrections_update ON public.user_corrections
    FOR UPDATE TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    )
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS user_corrections_all_service_role ON public.user_corrections;
CREATE POLICY user_corrections_all_service_role ON public.user_corrections
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.user_corrections IS 'VTID-01121: User feedback and correction records';

-- ===========================================================================
-- 3. BEHAVIOR_CONSTRAINTS TABLE - Rejected behaviors that must not resurface
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.behavior_constraints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Constraint definition
    constraint_type TEXT NOT NULL CHECK (constraint_type IN (
        'blocked_behavior', 'blocked_topic', 'blocked_suggestion', 'blocked_tone', 'boundary'
    )),
    constraint_key TEXT NOT NULL,  -- Normalized key for matching
    description TEXT NOT NULL,

    -- Source reference
    source_correction_id UUID REFERENCES public.user_corrections(id) ON DELETE SET NULL,

    -- Activity state
    is_active BOOLEAN NOT NULL DEFAULT true,
    strength INT NOT NULL DEFAULT 100 CHECK (strength >= 0 AND strength <= 100),  -- 100 = hard block

    -- Expiry (NULL = permanent)
    expires_at TIMESTAMPTZ NULL,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, user_id, constraint_type, constraint_key)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_behavior_constraints_tenant_user_active
    ON public.behavior_constraints (tenant_id, user_id, is_active, constraint_type);
CREATE INDEX IF NOT EXISTS idx_behavior_constraints_key
    ON public.behavior_constraints (tenant_id, user_id, constraint_key);
CREATE INDEX IF NOT EXISTS idx_behavior_constraints_expires
    ON public.behavior_constraints (tenant_id, user_id, expires_at)
    WHERE expires_at IS NOT NULL;

-- Enable RLS
ALTER TABLE public.behavior_constraints ENABLE ROW LEVEL SECURITY;

-- RLS policies
DROP POLICY IF EXISTS behavior_constraints_select ON public.behavior_constraints;
CREATE POLICY behavior_constraints_select ON public.behavior_constraints
    FOR SELECT TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS behavior_constraints_insert ON public.behavior_constraints;
CREATE POLICY behavior_constraints_insert ON public.behavior_constraints
    FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS behavior_constraints_update ON public.behavior_constraints;
CREATE POLICY behavior_constraints_update ON public.behavior_constraints
    FOR UPDATE TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    )
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS behavior_constraints_delete ON public.behavior_constraints;
CREATE POLICY behavior_constraints_delete ON public.behavior_constraints
    FOR DELETE TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS behavior_constraints_all_service_role ON public.behavior_constraints;
CREATE POLICY behavior_constraints_all_service_role ON public.behavior_constraints
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.behavior_constraints IS 'VTID-01121: Blocked behaviors and constraints from user corrections';

-- ===========================================================================
-- 4. TRUST_SCORES TABLE - Component-level trust scoring
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.trust_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Component being scored
    component TEXT NOT NULL CHECK (component IN (
        'overall', 'memory', 'suggestions', 'preferences', 'autonomy', 'tone', 'health_advice', 'relationships'
    )),

    -- Trust score (0-100, lower = less trust from user)
    score INT NOT NULL DEFAULT 80 CHECK (score >= 0 AND score <= 100),

    -- Trend tracking
    corrections_count INT NOT NULL DEFAULT 0,
    last_correction_at TIMESTAMPTZ NULL,
    last_positive_at TIMESTAMPTZ NULL,
    consecutive_corrections INT NOT NULL DEFAULT 0,

    -- Recovery tracking
    recovery_actions_taken INT NOT NULL DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, user_id, component)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_trust_scores_tenant_user
    ON public.trust_scores (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_trust_scores_component_score
    ON public.trust_scores (tenant_id, user_id, component, score);

-- Enable RLS
ALTER TABLE public.trust_scores ENABLE ROW LEVEL SECURITY;

-- RLS policies
DROP POLICY IF EXISTS trust_scores_select ON public.trust_scores;
CREATE POLICY trust_scores_select ON public.trust_scores
    FOR SELECT TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS trust_scores_insert ON public.trust_scores;
CREATE POLICY trust_scores_insert ON public.trust_scores
    FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS trust_scores_update ON public.trust_scores;
CREATE POLICY trust_scores_update ON public.trust_scores
    FOR UPDATE TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    )
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS trust_scores_all_service_role ON public.trust_scores;
CREATE POLICY trust_scores_all_service_role ON public.trust_scores
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.trust_scores IS 'VTID-01121: Component-level trust scores based on user feedback';

-- ===========================================================================
-- 5. SAFETY_FLAGS TABLE - Safety escalation tracking
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.safety_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Flag details
    flag_type TEXT NOT NULL CHECK (flag_type IN (
        'medical_correction', 'emotional_correction', 'abuse_detected', 'noise_detected', 'escalation_required'
    )),
    severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),

    -- Source
    source_correction_id UUID REFERENCES public.user_corrections(id) ON DELETE SET NULL,
    description TEXT NOT NULL,

    -- Resolution
    is_resolved BOOLEAN NOT NULL DEFAULT false,
    resolution_notes TEXT NULL,
    resolved_at TIMESTAMPTZ NULL,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_safety_flags_tenant_user_unresolved
    ON public.safety_flags (tenant_id, user_id, is_resolved)
    WHERE is_resolved = false;
CREATE INDEX IF NOT EXISTS idx_safety_flags_severity
    ON public.safety_flags (tenant_id, severity, is_resolved);

-- Enable RLS
ALTER TABLE public.safety_flags ENABLE ROW LEVEL SECURITY;

-- RLS policies (only service_role can view safety flags for security)
DROP POLICY IF EXISTS safety_flags_select_service ON public.safety_flags;
CREATE POLICY safety_flags_select_service ON public.safety_flags
    FOR SELECT TO service_role USING (true);

DROP POLICY IF EXISTS safety_flags_all_service_role ON public.safety_flags;
CREATE POLICY safety_flags_all_service_role ON public.safety_flags
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.safety_flags IS 'VTID-01121: Safety escalation flags from sensitive corrections';

-- ===========================================================================
-- 6. FEEDBACK_PROPAGATION_LOG TABLE - Downstream propagation tracking
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.feedback_propagation_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Source correction
    correction_id UUID NOT NULL REFERENCES public.user_corrections(id) ON DELETE CASCADE,

    -- Target of propagation
    target_layer TEXT NOT NULL CHECK (target_layer IN (
        'memory', 'preferences', 'behavior_constraints', 'trust_scores', 'topic_profile', 'relationship_edges'
    )),
    target_item_id UUID NULL,

    -- Action taken
    action TEXT NOT NULL CHECK (action IN (
        'created', 'updated', 'deleted', 'downgraded', 'blocked', 'flagged'
    )),
    action_details JSONB NOT NULL DEFAULT '{}',

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_feedback_propagation_correction
    ON public.feedback_propagation_log (correction_id);
CREATE INDEX IF NOT EXISTS idx_feedback_propagation_tenant_user_layer
    ON public.feedback_propagation_log (tenant_id, user_id, target_layer, created_at DESC);

-- Enable RLS
ALTER TABLE public.feedback_propagation_log ENABLE ROW LEVEL SECURITY;

-- RLS policies
DROP POLICY IF EXISTS feedback_propagation_log_select ON public.feedback_propagation_log;
CREATE POLICY feedback_propagation_log_select ON public.feedback_propagation_log
    FOR SELECT TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS feedback_propagation_log_insert ON public.feedback_propagation_log;
CREATE POLICY feedback_propagation_log_insert ON public.feedback_propagation_log
    FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS feedback_propagation_log_all_service_role ON public.feedback_propagation_log;
CREATE POLICY feedback_propagation_log_all_service_role ON public.feedback_propagation_log
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.feedback_propagation_log IS 'VTID-01121: Tracks downstream propagation of corrections';

-- ===========================================================================
-- 7. RPC: record_user_correction
-- ===========================================================================
-- Main entry point for user corrections. Processes feedback deterministically.

CREATE OR REPLACE FUNCTION public.record_user_correction(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_feedback_type TEXT;
    v_content TEXT;
    v_context JSONB;
    v_affected_component TEXT;
    v_affected_item_id UUID;
    v_affected_item_type TEXT;
    v_session_id TEXT;
    v_source TEXT;
    v_correction_id UUID;
    v_trust_delta INT;
    v_current_trust INT;
    v_new_trust INT;
    v_constraint_key TEXT;
    v_propagations JSONB := '[]'::JSONB;
    v_safety_flag_needed BOOLEAN := false;
    v_safety_flag_type TEXT;
    v_safety_severity TEXT;

    -- Deterministic constants
    c_explicit_correction_trust_delta INT := -15;
    c_preference_trust_delta INT := -5;
    c_boundary_trust_delta INT := -10;
    c_tone_trust_delta INT := -5;
    c_rejection_trust_delta INT := -8;
    c_autonomy_refusal_trust_delta INT := -20;
    c_minimum_trust INT := 10;
    c_default_trust INT := 80;
BEGIN
    -- 1. Get context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    v_user_id := public.current_user_id();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- 2. Parse payload
    v_feedback_type := p_payload->>'feedback_type';
    v_content := p_payload->>'content';
    v_context := COALESCE(p_payload->'context', '{}'::JSONB);
    v_affected_component := COALESCE(p_payload->>'affected_component', 'general');
    v_affected_item_id := (p_payload->>'affected_item_id')::UUID;
    v_affected_item_type := p_payload->>'affected_item_type';
    v_session_id := p_payload->>'session_id';
    v_source := COALESCE(p_payload->>'source', 'orb');

    -- 3. Validate required fields
    IF v_feedback_type IS NULL OR v_feedback_type NOT IN (
        'explicit_correction', 'preference_clarification', 'boundary_enforcement',
        'tone_adjustment', 'suggestion_rejection', 'autonomy_refusal'
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_FEEDBACK_TYPE');
    END IF;

    IF v_content IS NULL OR v_content = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'CONTENT_REQUIRED');
    END IF;

    -- 4. Insert correction record
    INSERT INTO public.user_corrections (
        tenant_id, user_id, feedback_type, content, context,
        affected_component, affected_item_id, affected_item_type,
        session_id, source, status
    )
    VALUES (
        v_tenant_id, v_user_id, v_feedback_type, v_content, v_context,
        v_affected_component, v_affected_item_id, v_affected_item_type,
        v_session_id, v_source, 'processing'
    )
    RETURNING id INTO v_correction_id;

    -- 5. Determine trust delta based on feedback type
    CASE v_feedback_type
        WHEN 'explicit_correction' THEN
            v_trust_delta := c_explicit_correction_trust_delta;
        WHEN 'preference_clarification' THEN
            v_trust_delta := c_preference_trust_delta;
        WHEN 'boundary_enforcement' THEN
            v_trust_delta := c_boundary_trust_delta;
        WHEN 'tone_adjustment' THEN
            v_trust_delta := c_tone_trust_delta;
        WHEN 'suggestion_rejection' THEN
            v_trust_delta := c_rejection_trust_delta;
        WHEN 'autonomy_refusal' THEN
            v_trust_delta := c_autonomy_refusal_trust_delta;
        ELSE
            v_trust_delta := -10;
    END CASE;

    -- 6. Update trust scores for affected component
    -- Get current score or initialize
    SELECT score INTO v_current_trust
    FROM public.trust_scores
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id AND component = v_affected_component;

    IF v_current_trust IS NULL THEN
        v_current_trust := c_default_trust;
    END IF;

    v_new_trust := GREATEST(c_minimum_trust, v_current_trust + v_trust_delta);

    -- Upsert trust score
    INSERT INTO public.trust_scores (
        tenant_id, user_id, component, score,
        corrections_count, last_correction_at, consecutive_corrections
    )
    VALUES (
        v_tenant_id, v_user_id, v_affected_component, v_new_trust,
        1, NOW(), 1
    )
    ON CONFLICT (tenant_id, user_id, component)
    DO UPDATE SET
        score = EXCLUDED.score,
        corrections_count = trust_scores.corrections_count + 1,
        last_correction_at = NOW(),
        consecutive_corrections = trust_scores.consecutive_corrections + 1,
        updated_at = NOW();

    -- Log trust score propagation
    v_propagations := v_propagations || jsonb_build_object(
        'target_layer', 'trust_scores',
        'action', 'downgraded',
        'details', jsonb_build_object(
            'component', v_affected_component,
            'old_score', v_current_trust,
            'new_score', v_new_trust,
            'delta', v_trust_delta
        )
    );

    -- Also update overall trust
    IF v_affected_component != 'overall' THEN
        SELECT score INTO v_current_trust
        FROM public.trust_scores
        WHERE tenant_id = v_tenant_id AND user_id = v_user_id AND component = 'overall';

        IF v_current_trust IS NULL THEN
            v_current_trust := c_default_trust;
        END IF;

        -- Overall gets half the delta
        v_new_trust := GREATEST(c_minimum_trust, v_current_trust + (v_trust_delta / 2));

        INSERT INTO public.trust_scores (
            tenant_id, user_id, component, score,
            corrections_count, last_correction_at, consecutive_corrections
        )
        VALUES (
            v_tenant_id, v_user_id, 'overall', v_new_trust,
            1, NOW(), 1
        )
        ON CONFLICT (tenant_id, user_id, component)
        DO UPDATE SET
            score = EXCLUDED.score,
            corrections_count = trust_scores.corrections_count + 1,
            last_correction_at = NOW(),
            consecutive_corrections = trust_scores.consecutive_corrections + 1,
            updated_at = NOW();
    END IF;

    -- 7. Create behavior constraint if applicable
    IF v_feedback_type IN ('boundary_enforcement', 'autonomy_refusal', 'suggestion_rejection') THEN
        -- Generate constraint key from content (normalized)
        v_constraint_key := lower(regexp_replace(substring(v_content, 1, 100), '[^a-zA-Z0-9]+', '_', 'g'));

        INSERT INTO public.behavior_constraints (
            tenant_id, user_id, constraint_type, constraint_key,
            description, source_correction_id, strength
        )
        VALUES (
            v_tenant_id, v_user_id,
            CASE v_feedback_type
                WHEN 'boundary_enforcement' THEN 'boundary'
                WHEN 'autonomy_refusal' THEN 'blocked_behavior'
                WHEN 'suggestion_rejection' THEN 'blocked_suggestion'
            END,
            v_constraint_key,
            v_content,
            v_correction_id,
            100  -- Hard block
        )
        ON CONFLICT (tenant_id, user_id, constraint_type, constraint_key)
        DO UPDATE SET
            description = EXCLUDED.description,
            source_correction_id = EXCLUDED.source_correction_id,
            is_active = true,
            strength = 100,
            updated_at = NOW();

        -- Log constraint propagation
        v_propagations := v_propagations || jsonb_build_object(
            'target_layer', 'behavior_constraints',
            'action', 'created',
            'details', jsonb_build_object(
                'constraint_type', CASE v_feedback_type
                    WHEN 'boundary_enforcement' THEN 'boundary'
                    WHEN 'autonomy_refusal' THEN 'blocked_behavior'
                    WHEN 'suggestion_rejection' THEN 'blocked_suggestion'
                END,
                'constraint_key', v_constraint_key,
                'strength', 100
            )
        );
    END IF;

    -- 8. Check for safety-sensitive corrections
    IF v_affected_component = 'health' OR v_content ~* '(medical|medication|health|doctor|pain|symptoms)' THEN
        v_safety_flag_needed := true;
        v_safety_flag_type := 'medical_correction';
        v_safety_severity := 'high';
    ELSIF v_content ~* '(upset|angry|frustrated|hurt|emotional|feelings|sad|anxious)' THEN
        v_safety_flag_needed := true;
        v_safety_flag_type := 'emotional_correction';
        v_safety_severity := 'medium';
    END IF;

    IF v_safety_flag_needed THEN
        INSERT INTO public.safety_flags (
            tenant_id, user_id, flag_type, severity,
            source_correction_id, description
        )
        VALUES (
            v_tenant_id, v_user_id, v_safety_flag_type, v_safety_severity,
            v_correction_id, 'Auto-flagged: ' || v_content
        );

        v_propagations := v_propagations || jsonb_build_object(
            'target_layer', 'safety_flags',
            'action', 'flagged',
            'details', jsonb_build_object(
                'flag_type', v_safety_flag_type,
                'severity', v_safety_severity
            )
        );
    END IF;

    -- 9. Update memory item confidence if specific item affected
    IF v_affected_item_id IS NOT NULL AND v_affected_item_type = 'memory_item' THEN
        -- Downgrade memory item importance
        UPDATE public.memory_items
        SET importance = GREATEST(0, importance - 30)
        WHERE id = v_affected_item_id
          AND tenant_id = v_tenant_id
          AND user_id = v_user_id;

        IF FOUND THEN
            v_propagations := v_propagations || jsonb_build_object(
                'target_layer', 'memory',
                'target_item_id', v_affected_item_id,
                'action', 'downgraded',
                'details', jsonb_build_object('importance_delta', -30)
            );
        END IF;
    END IF;

    -- 10. Log all propagations
    INSERT INTO public.feedback_propagation_log (
        tenant_id, user_id, correction_id, target_layer, target_item_id, action, action_details
    )
    SELECT
        v_tenant_id, v_user_id, v_correction_id,
        (prop->>'target_layer')::TEXT,
        (prop->>'target_item_id')::UUID,
        (prop->>'action')::TEXT,
        prop->'details'
    FROM jsonb_array_elements(v_propagations) AS prop;

    -- 11. Update correction status to applied
    UPDATE public.user_corrections
    SET
        status = 'applied',
        processed_at = NOW(),
        processing_result = jsonb_build_object(
            'propagations', v_propagations,
            'trust_impact', v_trust_delta,
            'safety_flagged', v_safety_flag_needed
        )
    WHERE id = v_correction_id;

    -- 12. Return success
    RETURN jsonb_build_object(
        'ok', true,
        'correction_id', v_correction_id,
        'feedback_type', v_feedback_type,
        'affected_component', v_affected_component,
        'trust_impact', v_trust_delta,
        'propagations', v_propagations,
        'safety_flagged', v_safety_flag_needed
    );
END;
$$;

-- Grant execute
GRANT EXECUTE ON FUNCTION public.record_user_correction(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_user_correction(JSONB) TO service_role;

COMMENT ON FUNCTION public.record_user_correction IS 'VTID-01121: Record user correction with deterministic propagation';

-- ===========================================================================
-- 8. RPC: get_trust_scores
-- ===========================================================================
-- Returns current trust scores for all components

CREATE OR REPLACE FUNCTION public.get_trust_scores()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_scores JSONB;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := public.current_user_id();

    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'component', ts.component,
                'score', ts.score,
                'corrections_count', ts.corrections_count,
                'consecutive_corrections', ts.consecutive_corrections,
                'last_correction_at', ts.last_correction_at,
                'last_positive_at', ts.last_positive_at,
                'recovery_actions_taken', ts.recovery_actions_taken,
                'updated_at', ts.updated_at
            )
            ORDER BY
                CASE ts.component WHEN 'overall' THEN 0 ELSE 1 END,
                ts.score ASC
        ),
        '[]'::JSONB
    )
    INTO v_scores
    FROM public.trust_scores ts
    WHERE ts.tenant_id = v_tenant_id AND ts.user_id = v_user_id;

    RETURN jsonb_build_object(
        'ok', true,
        'scores', v_scores,
        'count', jsonb_array_length(v_scores)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_trust_scores() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_trust_scores() TO service_role;

COMMENT ON FUNCTION public.get_trust_scores IS 'VTID-01121: Get current trust scores for all components';

-- ===========================================================================
-- 9. RPC: get_behavior_constraints
-- ===========================================================================
-- Returns active behavior constraints

CREATE OR REPLACE FUNCTION public.get_behavior_constraints(
    p_constraint_type TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_constraints JSONB;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := public.current_user_id();

    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', bc.id,
                'constraint_type', bc.constraint_type,
                'constraint_key', bc.constraint_key,
                'description', bc.description,
                'strength', bc.strength,
                'is_active', bc.is_active,
                'expires_at', bc.expires_at,
                'created_at', bc.created_at
            )
            ORDER BY bc.created_at DESC
        ),
        '[]'::JSONB
    )
    INTO v_constraints
    FROM public.behavior_constraints bc
    WHERE bc.tenant_id = v_tenant_id
      AND bc.user_id = v_user_id
      AND bc.is_active = true
      AND (bc.expires_at IS NULL OR bc.expires_at > NOW())
      AND (p_constraint_type IS NULL OR bc.constraint_type = p_constraint_type);

    RETURN jsonb_build_object(
        'ok', true,
        'constraints', v_constraints,
        'count', jsonb_array_length(v_constraints)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_behavior_constraints(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_behavior_constraints(TEXT) TO service_role;

COMMENT ON FUNCTION public.get_behavior_constraints IS 'VTID-01121: Get active behavior constraints';

-- ===========================================================================
-- 10. RPC: repair_trust
-- ===========================================================================
-- Called when ORB acknowledges a mistake and takes corrective action

CREATE OR REPLACE FUNCTION public.repair_trust(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_component TEXT;
    v_correction_id UUID;
    v_repair_action TEXT;
    v_current_score INT;
    v_new_score INT;
    v_recovery_delta INT := 5;  -- Modest recovery per action
    c_max_trust INT := 80;  -- Cap recovery below full trust
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := public.current_user_id();

    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    v_component := COALESCE(p_payload->>'component', 'overall');
    v_correction_id := (p_payload->>'correction_id')::UUID;
    v_repair_action := p_payload->>'repair_action';

    IF v_repair_action IS NULL OR v_repair_action = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'REPAIR_ACTION_REQUIRED');
    END IF;

    -- Get current score
    SELECT score INTO v_current_score
    FROM public.trust_scores
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id AND component = v_component;

    IF v_current_score IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NO_TRUST_SCORE_FOR_COMPONENT');
    END IF;

    -- Calculate new score (capped at max_trust)
    v_new_score := LEAST(c_max_trust, v_current_score + v_recovery_delta);

    -- Update trust score
    UPDATE public.trust_scores
    SET
        score = v_new_score,
        consecutive_corrections = 0,  -- Reset consecutive count
        last_positive_at = NOW(),
        recovery_actions_taken = recovery_actions_taken + 1,
        updated_at = NOW()
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id AND component = v_component;

    -- Log the repair action
    IF v_correction_id IS NOT NULL THEN
        INSERT INTO public.feedback_propagation_log (
            tenant_id, user_id, correction_id, target_layer, action, action_details
        )
        VALUES (
            v_tenant_id, v_user_id, v_correction_id, 'trust_scores', 'updated',
            jsonb_build_object(
                'repair_action', v_repair_action,
                'component', v_component,
                'old_score', v_current_score,
                'new_score', v_new_score,
                'delta', v_recovery_delta
            )
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'component', v_component,
        'old_score', v_current_score,
        'new_score', v_new_score,
        'recovery_delta', v_recovery_delta,
        'repair_action', v_repair_action
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.repair_trust(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.repair_trust(JSONB) TO service_role;

COMMENT ON FUNCTION public.repair_trust IS 'VTID-01121: Repair trust score after corrective action';

-- ===========================================================================
-- 11. RPC: get_correction_history
-- ===========================================================================
-- Returns user's correction history for auditability

CREATE OR REPLACE FUNCTION public.get_correction_history(
    p_limit INT DEFAULT 50,
    p_offset INT DEFAULT 0,
    p_feedback_type TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_corrections JSONB;
    v_total_count INT;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := public.current_user_id();

    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Cap limits
    IF p_limit IS NULL OR p_limit < 1 THEN p_limit := 50; END IF;
    IF p_limit > 200 THEN p_limit := 200; END IF;
    IF p_offset IS NULL OR p_offset < 0 THEN p_offset := 0; END IF;

    -- Get total count
    SELECT COUNT(*) INTO v_total_count
    FROM public.user_corrections uc
    WHERE uc.tenant_id = v_tenant_id
      AND uc.user_id = v_user_id
      AND (p_feedback_type IS NULL OR uc.feedback_type = p_feedback_type);

    -- Get corrections
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', uc.id,
                'feedback_type', uc.feedback_type,
                'content', uc.content,
                'affected_component', uc.affected_component,
                'status', uc.status,
                'processing_result', uc.processing_result,
                'created_at', uc.created_at,
                'processed_at', uc.processed_at
            )
            ORDER BY uc.created_at DESC
        ),
        '[]'::JSONB
    )
    INTO v_corrections
    FROM (
        SELECT *
        FROM public.user_corrections
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND (p_feedback_type IS NULL OR feedback_type = p_feedback_type)
        ORDER BY created_at DESC
        LIMIT p_limit
        OFFSET p_offset
    ) uc;

    RETURN jsonb_build_object(
        'ok', true,
        'corrections', v_corrections,
        'count', jsonb_array_length(v_corrections),
        'total', v_total_count,
        'limit', p_limit,
        'offset', p_offset
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_correction_history(INT, INT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_correction_history(INT, INT, TEXT) TO service_role;

COMMENT ON FUNCTION public.get_correction_history IS 'VTID-01121: Get user correction history for auditability';

-- ===========================================================================
-- 12. RPC: check_behavior_constraint
-- ===========================================================================
-- Check if a specific behavior is constrained (for ORB to check before acting)

CREATE OR REPLACE FUNCTION public.check_behavior_constraint(
    p_constraint_type TEXT,
    p_constraint_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_constraint RECORD;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := public.current_user_id();

    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Normalize key for matching
    p_constraint_key := lower(regexp_replace(p_constraint_key, '[^a-zA-Z0-9]+', '_', 'g'));

    SELECT id, constraint_type, constraint_key, description, strength, is_active, expires_at
    INTO v_constraint
    FROM public.behavior_constraints
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND constraint_type = p_constraint_type
      AND constraint_key = p_constraint_key
      AND is_active = true
      AND (expires_at IS NULL OR expires_at > NOW());

    IF v_constraint.id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', true,
            'is_constrained', false,
            'constraint_type', p_constraint_type,
            'constraint_key', p_constraint_key
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'is_constrained', true,
        'constraint_id', v_constraint.id,
        'constraint_type', v_constraint.constraint_type,
        'constraint_key', v_constraint.constraint_key,
        'description', v_constraint.description,
        'strength', v_constraint.strength,
        'expires_at', v_constraint.expires_at
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_behavior_constraint(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_behavior_constraint(TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION public.check_behavior_constraint IS 'VTID-01121: Check if behavior is constrained before acting';

-- ===========================================================================
-- 13. Permissions
-- ===========================================================================

-- Grant table permissions to authenticated
GRANT SELECT, INSERT, UPDATE ON public.user_corrections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.behavior_constraints TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.trust_scores TO authenticated;
GRANT SELECT, INSERT ON public.feedback_propagation_log TO authenticated;
-- safety_flags only accessible via service_role (already set in RLS)

-- Service role gets all
GRANT ALL ON public.user_corrections TO service_role;
GRANT ALL ON public.behavior_constraints TO service_role;
GRANT ALL ON public.trust_scores TO service_role;
GRANT ALL ON public.safety_flags TO service_role;
GRANT ALL ON public.feedback_propagation_log TO service_role;

-- ===========================================================================
-- Migration Complete
-- ===========================================================================

-- Summary:
-- Tables created:
--   - user_corrections: Core feedback recording
--   - behavior_constraints: Blocked behaviors and constraints
--   - trust_scores: Component-level trust scoring
--   - safety_flags: Safety escalation tracking
--   - feedback_propagation_log: Downstream propagation tracking
--
-- RPC functions:
--   - record_user_correction: Main entry point for corrections
--   - get_trust_scores: Get current trust scores
--   - get_behavior_constraints: Get active constraints
--   - repair_trust: Repair trust after corrective action
--   - get_correction_history: Get correction history for audit
--   - check_behavior_constraint: Check if behavior is constrained
