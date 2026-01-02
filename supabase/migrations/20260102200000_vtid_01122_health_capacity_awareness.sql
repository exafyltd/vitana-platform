-- Migration: 20260102200000_vtid_01122_health_capacity_awareness.sql
-- Purpose: VTID-01122 Health State, Energy & Capacity Awareness Engine (D37)
-- Date: 2026-01-02
--
-- Understands the user's current physical and mental capacity to act —
-- without diagnosing, medicalizing, or overreaching.
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01102 (Phase B-Fix) - runtime context bridge
--   - VTID-01083 (D26 Longevity Signals) - sleep, stress, activity signals
--   - VTID-01119 (D27 User Preferences) - health preferences & constraints
--   - VTID-01120 (D28 Emotional/Cognitive) - emotional & cognitive state
--
-- Hard Constraints (from spec):
--   - NEVER diagnose or label conditions
--   - NEVER push intensity upward when energy is low
--   - Respect self-reported fatigue immediately
--   - Health inference must always be reversible
--   - Err on the side of rest and safety

-- ===========================================================================
-- 1. capacity_state (Computed capacity bundles per session)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.capacity_state (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    session_id UUID NULL, -- Optional: link to conversation session

    -- Energy State (core output)
    energy_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK (energy_state IN ('low', 'moderate', 'high', 'unknown')),
    energy_score INT NOT NULL DEFAULT 50
        CHECK (energy_score >= 0 AND energy_score <= 100),

    -- Capacity Envelope (3D capacity model)
    capacity_physical INT NOT NULL DEFAULT 50
        CHECK (capacity_physical >= 0 AND capacity_physical <= 100),
    capacity_cognitive INT NOT NULL DEFAULT 50
        CHECK (capacity_cognitive >= 0 AND capacity_cognitive <= 100),
    capacity_emotional INT NOT NULL DEFAULT 50
        CHECK (capacity_emotional >= 0 AND capacity_emotional <= 100),
    capacity_overall INT NOT NULL DEFAULT 50
        CHECK (capacity_overall >= 0 AND capacity_overall <= 100),
    limiting_dimension TEXT NULL
        CHECK (limiting_dimension IS NULL OR
               limiting_dimension IN ('physical', 'cognitive', 'emotional')),

    -- Context Tags for downstream flows
    context_tags TEXT[] DEFAULT '{}',
    -- Possible: 'low_energy_mode', 'restorative_only', 'light_activity_ok',
    --           'moderate_ok', 'high_capacity_ok'

    -- Intensity Range (what actions are appropriate)
    min_intensity TEXT NOT NULL DEFAULT 'restorative'
        CHECK (min_intensity IN ('restorative', 'light', 'moderate', 'high')),
    max_intensity TEXT NOT NULL DEFAULT 'moderate'
        CHECK (max_intensity IN ('restorative', 'light', 'moderate', 'high')),

    -- Input signals that contributed (for traceability)
    signals JSONB NOT NULL DEFAULT '[]'::JSONB,
    -- Format: [{ "source": "circadian|interaction|self_reported|...",
    --            "state": "low|moderate|high|unknown",
    --            "score": 0-100, "confidence": 0-100,
    --            "evidence": "...", "decay_at": timestamp }]

    -- Evidence trail for explainability
    evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
    -- Format: { "circadian": {}, "interaction_patterns": {},
    --           "self_reported": [], "longevity_state": {},
    --           "emotional_state": {}, "rules_applied": [] }

    -- Override tracking
    is_override BOOLEAN NOT NULL DEFAULT false,
    override_note TEXT NULL,

    -- Confidence
    confidence INT NOT NULL DEFAULT 60
        CHECK (confidence >= 0 AND confidence <= 100),

    -- Non-clinical disclaimer (always present)
    disclaimer TEXT NOT NULL DEFAULT 'These are probabilistic observations about energy and capacity, not medical or clinical assessments. User corrections override all inferences.',

    -- Decay management
    decayed BOOLEAN NOT NULL DEFAULT false,
    decay_at TIMESTAMPTZ NULL,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Unique constraint per session
    CONSTRAINT capacity_state_unique
        UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, session_id)
);

-- Index for efficient session lookups
CREATE INDEX IF NOT EXISTS idx_capacity_state_session
    ON public.capacity_state (tenant_id, user_id, session_id, created_at DESC);

-- Index for non-decayed states
CREATE INDEX IF NOT EXISTS idx_capacity_state_active
    ON public.capacity_state (tenant_id, user_id, decayed, created_at DESC)
    WHERE decayed = false;

-- ===========================================================================
-- 2. capacity_overrides (User corrections immediately override)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.capacity_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Override data
    energy_state TEXT NOT NULL
        CHECK (energy_state IN ('low', 'moderate', 'high')),
    note TEXT NULL,
    previous_state TEXT NULL,

    -- Expiration
    expires_at TIMESTAMPTZ NOT NULL,
    expired BOOLEAN NOT NULL DEFAULT false,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for active overrides
CREATE INDEX IF NOT EXISTS idx_capacity_overrides_active
    ON public.capacity_overrides (tenant_id, user_id, expires_at DESC)
    WHERE expired = false;

-- ===========================================================================
-- 3. capacity_rules (Deterministic rule registry)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.capacity_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_key TEXT NOT NULL UNIQUE,
    rule_version INT NOT NULL DEFAULT 1,

    -- Rule targeting
    signal_source TEXT NOT NULL
        CHECK (signal_source IN ('circadian', 'interaction', 'self_reported',
                                  'longevity', 'emotional', 'preference')),
    target_dimension TEXT NOT NULL
        CHECK (target_dimension IN ('energy', 'physical', 'cognitive', 'emotional')),

    -- Rule logic
    logic JSONB NOT NULL,
    -- Format: { "type": "time_check|pattern_match|threshold|longevity_state|emotional_state",
    --           "conditions": {}, "effect": "increase|decrease", "delta": 0-100 }

    weight INT NOT NULL DEFAULT 50
        CHECK (weight >= 0 AND weight <= 100),
    decay_minutes INT NOT NULL DEFAULT 30,

    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for active rules lookup
CREATE INDEX IF NOT EXISTS idx_capacity_rules_active
    ON public.capacity_rules (signal_source, active);

-- ===========================================================================
-- 4. Seed Default Rules (v1 baseline)
-- ===========================================================================

INSERT INTO public.capacity_rules (rule_key, rule_version, signal_source, target_dimension, logic, weight, decay_minutes, active) VALUES
    -- =======================================================================
    -- CIRCADIAN RULES (Time of day patterns)
    -- =======================================================================

    ('circadian.v1.early_morning_low', 1, 'circadian', 'energy',
     '{"type": "time_check", "hours": [5, 6], "description": "Early morning typically low energy", "effect": "decrease", "delta": 15}'::JSONB,
     60, 60, true),

    ('circadian.v1.morning_peak', 1, 'circadian', 'energy',
     '{"type": "time_check", "hours": [9, 10, 11], "description": "Mid-morning typically peak energy", "effect": "increase", "delta": 15}'::JSONB,
     60, 60, true),

    ('circadian.v1.post_lunch_dip', 1, 'circadian', 'energy',
     '{"type": "time_check", "hours": [13, 14], "description": "Post-lunch energy dip", "effect": "decrease", "delta": 10}'::JSONB,
     55, 45, true),

    ('circadian.v1.afternoon_recovery', 1, 'circadian', 'energy',
     '{"type": "time_check", "hours": [15, 16, 17], "description": "Afternoon energy recovery", "effect": "increase", "delta": 10}'::JSONB,
     55, 60, true),

    ('circadian.v1.evening_wind_down', 1, 'circadian', 'energy',
     '{"type": "time_check", "hours": [20, 21, 22], "description": "Evening wind-down period", "effect": "decrease", "delta": 15}'::JSONB,
     60, 60, true),

    ('circadian.v1.late_night_low', 1, 'circadian', 'energy',
     '{"type": "time_check", "hours": [23, 0, 1, 2, 3, 4], "description": "Late night / very early morning - low energy", "effect": "decrease", "delta": 25}'::JSONB,
     75, 120, true),

    -- =======================================================================
    -- INTERACTION PATTERN RULES
    -- =======================================================================

    ('interaction.v1.short_replies', 1, 'interaction', 'cognitive',
     '{"type": "pattern_check", "condition": "avg_length_below", "threshold": 20, "description": "Short replies suggest cognitive fatigue", "effect": "decrease", "delta": 15}'::JSONB,
     65, 30, true),

    ('interaction.v1.slow_responses', 1, 'interaction', 'energy',
     '{"type": "pacing_check", "condition": "response_delay_above", "threshold_seconds": 120, "description": "Delayed responses suggest low energy", "effect": "decrease", "delta": 15}'::JSONB,
     60, 30, true),

    ('interaction.v1.rapid_engaged', 1, 'interaction', 'energy',
     '{"type": "pacing_check", "condition": "response_delay_below", "threshold_seconds": 30, "description": "Quick responses suggest good energy", "effect": "increase", "delta": 10}'::JSONB,
     55, 20, true),

    -- =======================================================================
    -- SELF-REPORTED RULES (Highest priority)
    -- =======================================================================

    ('self_reported.v1.tired', 1, 'self_reported', 'energy',
     '{"type": "keyword_match", "keywords": ["tired", "exhausted", "fatigued", "drained", "low energy", "no energy", "worn out"], "description": "User explicitly reports fatigue", "effect": "decrease", "delta": 40}'::JSONB,
     95, 60, true),

    ('self_reported.v1.energized', 1, 'self_reported', 'energy',
     '{"type": "keyword_match", "keywords": ["energized", "refreshed", "great", "rested", "ready", "pumped", "awake"], "description": "User explicitly reports high energy", "effect": "increase", "delta": 35}'::JSONB,
     95, 60, true),

    ('self_reported.v1.overwhelmed', 1, 'self_reported', 'cognitive',
     '{"type": "keyword_match", "keywords": ["overwhelmed", "too much", "can''t think", "brain fog", "confused"], "description": "User reports cognitive overload", "effect": "decrease", "delta": 35}'::JSONB,
     90, 45, true),

    ('self_reported.v1.focused', 1, 'self_reported', 'cognitive',
     '{"type": "keyword_match", "keywords": ["focused", "clear", "sharp", "on it", "in the zone"], "description": "User reports high cognitive capacity", "effect": "increase", "delta": 30}'::JSONB,
     90, 45, true),

    ('self_reported.v1.stressed', 1, 'self_reported', 'emotional',
     '{"type": "keyword_match", "keywords": ["stressed", "anxious", "worried", "upset", "frustrated", "irritated"], "description": "User reports emotional strain", "effect": "decrease", "delta": 30}'::JSONB,
     90, 45, true),

    ('self_reported.v1.calm', 1, 'self_reported', 'emotional',
     '{"type": "keyword_match", "keywords": ["calm", "relaxed", "peaceful", "content", "happy", "good mood"], "description": "User reports positive emotional state", "effect": "increase", "delta": 25}'::JSONB,
     85, 45, true),

    -- =======================================================================
    -- LONGEVITY STATE RULES (D26 integration)
    -- =======================================================================

    ('longevity.v1.poor_sleep', 1, 'longevity', 'energy',
     '{"type": "longevity_state", "signal": "sleep_quality", "condition": "below", "threshold": 40, "description": "Poor sleep quality reduces energy", "effect": "decrease", "delta": 25}'::JSONB,
     80, 120, true),

    ('longevity.v1.good_sleep', 1, 'longevity', 'energy',
     '{"type": "longevity_state", "signal": "sleep_quality", "condition": "above", "threshold": 70, "description": "Good sleep quality increases energy", "effect": "increase", "delta": 20}'::JSONB,
     75, 120, true),

    ('longevity.v1.high_stress', 1, 'longevity', 'emotional',
     '{"type": "longevity_state", "signal": "stress_level", "condition": "above", "threshold": 70, "description": "High stress reduces emotional capacity", "effect": "decrease", "delta": 25}'::JSONB,
     80, 60, true),

    ('longevity.v1.low_stress', 1, 'longevity', 'emotional',
     '{"type": "longevity_state", "signal": "stress_level", "condition": "below", "threshold": 30, "description": "Low stress increases emotional capacity", "effect": "increase", "delta": 15}'::JSONB,
     70, 60, true),

    ('longevity.v1.active', 1, 'longevity', 'physical',
     '{"type": "longevity_state", "signal": "activity_level", "condition": "above", "threshold": 60, "description": "Regular activity indicates physical readiness", "effect": "increase", "delta": 15}'::JSONB,
     65, 120, true),

    ('longevity.v1.sedentary', 1, 'longevity', 'physical',
     '{"type": "longevity_state", "signal": "activity_level", "condition": "below", "threshold": 20, "description": "Low activity may indicate reduced physical readiness", "effect": "decrease", "delta": 10}'::JSONB,
     55, 120, true),

    -- =======================================================================
    -- EMOTIONAL STATE RULES (D28 integration)
    -- =======================================================================

    ('emotional.v1.fatigued', 1, 'emotional', 'cognitive',
     '{"type": "emotional_state", "cognitive_state": "fatigued", "threshold": 50, "description": "D28 fatigued signal reduces cognitive capacity", "effect": "decrease", "delta": 25}'::JSONB,
     80, 30, true),

    ('emotional.v1.overloaded', 1, 'emotional', 'cognitive',
     '{"type": "emotional_state", "cognitive_state": "overloaded", "threshold": 50, "description": "D28 overloaded signal reduces cognitive capacity", "effect": "decrease", "delta": 30}'::JSONB,
     85, 20, true),

    ('emotional.v1.stressed', 1, 'emotional', 'emotional',
     '{"type": "emotional_state", "emotional_state": "stressed", "threshold": 50, "description": "D28 stressed signal reduces emotional capacity", "effect": "decrease", "delta": 20}'::JSONB,
     75, 30, true),

    ('emotional.v1.anxious', 1, 'emotional', 'emotional',
     '{"type": "emotional_state", "emotional_state": "anxious", "threshold": 50, "description": "D28 anxious signal reduces emotional capacity", "effect": "decrease", "delta": 20}'::JSONB,
     75, 30, true),

    ('emotional.v1.motivated', 1, 'emotional', 'energy',
     '{"type": "emotional_state", "emotional_state": "motivated", "threshold": 50, "description": "D28 motivated signal increases energy", "effect": "increase", "delta": 15}'::JSONB,
     70, 45, true),

    ('emotional.v1.engaged', 1, 'emotional', 'cognitive',
     '{"type": "emotional_state", "cognitive_state": "engaged", "threshold": 50, "description": "D28 engaged signal increases cognitive capacity", "effect": "increase", "delta": 15}'::JSONB,
     70, 30, true),

    ('emotional.v1.low_engagement', 1, 'emotional', 'energy',
     '{"type": "emotional_state", "engagement_level": "low", "description": "Low engagement suggests reduced energy", "effect": "decrease", "delta": 15}'::JSONB,
     65, 20, true)

ON CONFLICT (rule_key) DO NOTHING;

-- ===========================================================================
-- 5. Enable RLS on capacity tables
-- ===========================================================================

ALTER TABLE public.capacity_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capacity_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capacity_rules ENABLE ROW LEVEL SECURITY;

-- capacity_state RLS
DROP POLICY IF EXISTS capacity_state_select ON public.capacity_state;
CREATE POLICY capacity_state_select ON public.capacity_state
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS capacity_state_insert ON public.capacity_state;
CREATE POLICY capacity_state_insert ON public.capacity_state
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS capacity_state_update ON public.capacity_state;
CREATE POLICY capacity_state_update ON public.capacity_state
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid())
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

-- capacity_overrides RLS
DROP POLICY IF EXISTS capacity_overrides_select ON public.capacity_overrides;
CREATE POLICY capacity_overrides_select ON public.capacity_overrides
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS capacity_overrides_insert ON public.capacity_overrides;
CREATE POLICY capacity_overrides_insert ON public.capacity_overrides
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS capacity_overrides_update ON public.capacity_overrides;
CREATE POLICY capacity_overrides_update ON public.capacity_overrides
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

-- capacity_rules: read-only for authenticated users
DROP POLICY IF EXISTS capacity_rules_select ON public.capacity_rules;
CREATE POLICY capacity_rules_select ON public.capacity_rules
    FOR SELECT TO authenticated
    USING (true);

-- ===========================================================================
-- 6. RPC: capacity_compute(p_message text, p_session_id uuid, ...)
-- Compute capacity state from multiple signal sources
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.capacity_compute(
    p_message TEXT DEFAULT NULL,
    p_session_id UUID DEFAULT NULL,
    p_self_reported_energy TEXT DEFAULT NULL,
    p_self_reported_note TEXT DEFAULT NULL,
    p_include_wearables BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_message_lower TEXT;
    v_current_hour INT;

    -- Score accumulators (start at 50 - neutral)
    v_energy_score INT := 50;
    v_physical_score INT := 50;
    v_cognitive_score INT := 50;
    v_emotional_score INT := 50;

    -- Confidence tracker
    v_confidence INT := 60;
    v_total_weight INT := 0;

    -- Evidence accumulator
    v_evidence JSONB := '{
        "circadian": {},
        "interaction_patterns": {},
        "self_reported_signals": [],
        "longevity_state": {},
        "emotional_state": {},
        "rules_applied": []
    }'::JSONB;

    v_signals JSONB := '[]'::JSONB;
    v_rules_applied TEXT[] := '{}';
    v_rule RECORD;
    v_matched BOOLEAN;
    v_delta INT;

    -- External data sources
    v_longevity_signals RECORD;
    v_emotional_signals RECORD;
    v_active_override RECORD;

    -- Output variables
    v_energy_state TEXT;
    v_context_tags TEXT[] := '{}';
    v_min_intensity TEXT;
    v_max_intensity TEXT;
    v_limiting_dimension TEXT := NULL;
    v_overall_score INT;
    v_decay_at TIMESTAMPTZ;
BEGIN
    -- Gate 1: Get tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Gate 2: Get user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Prepare message for analysis
    v_message_lower := LOWER(COALESCE(p_message, ''));
    v_current_hour := EXTRACT(HOUR FROM NOW())::INT;
    v_decay_at := NOW() + INTERVAL '30 minutes';

    -- ===========================================================================
    -- Check for active user override (highest priority)
    -- ===========================================================================
    SELECT * INTO v_active_override
    FROM public.capacity_overrides
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND expired = false
      AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_active_override IS NOT NULL THEN
        -- User override takes precedence - return override state
        CASE v_active_override.energy_state
            WHEN 'low' THEN
                v_energy_score := 25;
                v_energy_state := 'low';
                v_context_tags := ARRAY['low_energy_mode', 'restorative_only'];
                v_min_intensity := 'restorative';
                v_max_intensity := 'light';
            WHEN 'moderate' THEN
                v_energy_score := 55;
                v_energy_state := 'moderate';
                v_context_tags := ARRAY['moderate_ok'];
                v_min_intensity := 'light';
                v_max_intensity := 'moderate';
            WHEN 'high' THEN
                v_energy_score := 80;
                v_energy_state := 'high';
                v_context_tags := ARRAY['high_capacity_ok'];
                v_min_intensity := 'moderate';
                v_max_intensity := 'high';
        END CASE;

        -- Return override state immediately
        RETURN jsonb_build_object(
            'ok', true,
            'capacity_state', jsonb_build_object(
                'energy_state', v_energy_state,
                'energy_score', v_energy_score,
                'capacity_envelope', jsonb_build_object(
                    'physical', v_energy_score,
                    'cognitive', v_energy_score,
                    'emotional', v_energy_score,
                    'overall', v_energy_score,
                    'confidence', 100,
                    'limiting_dimension', null
                ),
                'context_tags', v_context_tags,
                'min_intensity', v_min_intensity,
                'max_intensity', v_max_intensity,
                'signals', '[]'::JSONB,
                'confidence', 100,
                'decay_at', v_active_override.expires_at,
                'generated_at', NOW(),
                'disclaimer', 'User-specified energy state active until ' || v_active_override.expires_at::TEXT
            ),
            'is_override', true,
            'override_expires_at', v_active_override.expires_at
        );
    END IF;

    -- ===========================================================================
    -- Self-reported energy takes high priority (if provided)
    -- ===========================================================================
    IF p_self_reported_energy IS NOT NULL THEN
        CASE p_self_reported_energy
            WHEN 'low' THEN v_energy_score := v_energy_score - 30;
            WHEN 'moderate' THEN v_energy_score := v_energy_score; -- No change
            WHEN 'high' THEN v_energy_score := v_energy_score + 25;
            ELSE NULL;
        END CASE;

        v_signals := v_signals || jsonb_build_object(
            'source', 'self_reported',
            'state', p_self_reported_energy,
            'score', CASE p_self_reported_energy
                        WHEN 'low' THEN 25
                        WHEN 'moderate' THEN 50
                        WHEN 'high' THEN 80
                        ELSE 50 END,
            'confidence', 95,
            'evidence', COALESCE(p_self_reported_note, 'User self-reported'),
            'decay_at', NOW() + INTERVAL '60 minutes'
        );

        v_evidence := jsonb_set(
            v_evidence,
            '{self_reported_signals}',
            COALESCE(v_evidence->'self_reported_signals', '[]'::JSONB) ||
            jsonb_build_object(
                'energy_state', p_self_reported_energy,
                'note', p_self_reported_note,
                'at', NOW()
            )
        );

        v_confidence := GREATEST(v_confidence, 90);
    END IF;

    -- ===========================================================================
    -- Fetch D26 Longevity State (if available)
    -- ===========================================================================
    SELECT sleep_quality, stress_level, social_score
    INTO v_longevity_signals
    FROM public.longevity_signals_daily
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND signal_date = CURRENT_DATE
    LIMIT 1;

    IF v_longevity_signals IS NOT NULL THEN
        v_evidence := jsonb_set(
            v_evidence,
            '{longevity_state}',
            jsonb_build_object(
                'sleep_quality', v_longevity_signals.sleep_quality,
                'stress_level', v_longevity_signals.stress_level,
                'social_score', v_longevity_signals.social_score,
                'source', 'D26_longevity_signals_daily'
            )
        );
    END IF;

    -- ===========================================================================
    -- Fetch D28 Emotional/Cognitive State (if available)
    -- ===========================================================================
    SELECT
        emotional_states,
        cognitive_states,
        engagement_level
    INTO v_emotional_signals
    FROM public.emotional_cognitive_signals
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND decayed = false
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_emotional_signals IS NOT NULL THEN
        v_evidence := jsonb_set(
            v_evidence,
            '{emotional_state}',
            jsonb_build_object(
                'emotional_states', v_emotional_signals.emotional_states,
                'cognitive_states', v_emotional_signals.cognitive_states,
                'engagement_level', v_emotional_signals.engagement_level,
                'source', 'D28_emotional_cognitive_signals'
            )
        );
    END IF;

    -- Add circadian context to evidence
    v_evidence := jsonb_set(
        v_evidence,
        '{circadian}',
        jsonb_build_object(
            'current_hour', v_current_hour,
            'time_of_day', CASE
                WHEN v_current_hour >= 5 AND v_current_hour < 7 THEN 'early_morning'
                WHEN v_current_hour >= 7 AND v_current_hour < 12 THEN 'morning'
                WHEN v_current_hour >= 12 AND v_current_hour < 14 THEN 'midday'
                WHEN v_current_hour >= 14 AND v_current_hour < 18 THEN 'afternoon'
                WHEN v_current_hour >= 18 AND v_current_hour < 21 THEN 'evening'
                ELSE 'late_night'
            END
        )
    );

    -- ===========================================================================
    -- Apply Rules
    -- ===========================================================================
    FOR v_rule IN
        SELECT * FROM public.capacity_rules
        WHERE active = true
        ORDER BY weight DESC
    LOOP
        v_matched := false;
        v_delta := COALESCE((v_rule.logic->>'delta')::INT, 10);

        -- Time check rule (circadian)
        IF (v_rule.logic->>'type') = 'time_check' THEN
            IF v_current_hour = ANY(ARRAY(SELECT (jsonb_array_elements_text(v_rule.logic->'hours'))::INT)) THEN
                v_matched := true;
            END IF;
        END IF;

        -- Keyword match rule (self-reported)
        IF (v_rule.logic->>'type') = 'keyword_match' AND v_message_lower != '' THEN
            DECLARE
                v_keyword TEXT;
            BEGIN
                FOR v_keyword IN
                    SELECT jsonb_array_elements_text(v_rule.logic->'keywords')
                LOOP
                    IF v_message_lower LIKE '%' || LOWER(v_keyword) || '%' THEN
                        v_matched := true;
                        EXIT;
                    END IF;
                END LOOP;
            END;
        END IF;

        -- Longevity state rule
        IF (v_rule.logic->>'type') = 'longevity_state' AND v_longevity_signals IS NOT NULL THEN
            DECLARE
                v_signal_name TEXT := v_rule.logic->>'signal';
                v_condition TEXT := v_rule.logic->>'condition';
                v_threshold INT := COALESCE((v_rule.logic->>'threshold')::INT, 50);
                v_signal_value INT;
            BEGIN
                CASE v_signal_name
                    WHEN 'stress_level' THEN v_signal_value := v_longevity_signals.stress_level;
                    WHEN 'sleep_quality' THEN v_signal_value := v_longevity_signals.sleep_quality;
                    WHEN 'social_score' THEN v_signal_value := v_longevity_signals.social_score;
                    ELSE v_signal_value := NULL;
                END CASE;

                IF v_signal_value IS NOT NULL THEN
                    IF v_condition = 'above' AND v_signal_value > v_threshold THEN
                        v_matched := true;
                    ELSIF v_condition = 'below' AND v_signal_value < v_threshold THEN
                        v_matched := true;
                    END IF;
                END IF;
            END;
        END IF;

        -- Emotional state rule (D28 integration)
        IF (v_rule.logic->>'type') = 'emotional_state' AND v_emotional_signals IS NOT NULL THEN
            -- Check emotional states
            IF v_rule.logic ? 'emotional_state' THEN
                DECLARE
                    v_target_state TEXT := v_rule.logic->>'emotional_state';
                    v_threshold INT := COALESCE((v_rule.logic->>'threshold')::INT, 50);
                    v_state RECORD;
                BEGIN
                    FOR v_state IN
                        SELECT * FROM jsonb_array_elements(v_emotional_signals.emotional_states) AS s
                    LOOP
                        IF (v_state.s->>'state') = v_target_state AND
                           (v_state.s->>'score')::INT >= v_threshold THEN
                            v_matched := true;
                            EXIT;
                        END IF;
                    END LOOP;
                END;
            END IF;

            -- Check cognitive states
            IF v_rule.logic ? 'cognitive_state' THEN
                DECLARE
                    v_target_state TEXT := v_rule.logic->>'cognitive_state';
                    v_threshold INT := COALESCE((v_rule.logic->>'threshold')::INT, 50);
                    v_state RECORD;
                BEGIN
                    FOR v_state IN
                        SELECT * FROM jsonb_array_elements(v_emotional_signals.cognitive_states) AS s
                    LOOP
                        IF (v_state.s->>'state') = v_target_state AND
                           (v_state.s->>'score')::INT >= v_threshold THEN
                            v_matched := true;
                            EXIT;
                        END IF;
                    END LOOP;
                END;
            END IF;

            -- Check engagement level
            IF v_rule.logic ? 'engagement_level' THEN
                IF v_emotional_signals.engagement_level = (v_rule.logic->>'engagement_level') THEN
                    v_matched := true;
                END IF;
            END IF;
        END IF;

        -- ===========================================================================
        -- Apply Score Deltas
        -- ===========================================================================
        IF v_matched THEN
            v_rules_applied := array_append(v_rules_applied, v_rule.rule_key);

            -- Determine direction
            IF (v_rule.logic->>'effect') = 'decrease' THEN
                v_delta := -v_delta;
            END IF;

            -- Apply to target dimension
            CASE v_rule.target_dimension
                WHEN 'energy' THEN
                    v_energy_score := v_energy_score + v_delta;
                WHEN 'physical' THEN
                    v_physical_score := v_physical_score + v_delta;
                WHEN 'cognitive' THEN
                    v_cognitive_score := v_cognitive_score + v_delta;
                WHEN 'emotional' THEN
                    v_emotional_score := v_emotional_score + v_delta;
            END CASE;

            v_total_weight := v_total_weight + v_rule.weight;

            -- Add signal
            v_signals := v_signals || jsonb_build_object(
                'source', v_rule.signal_source,
                'state', CASE WHEN v_delta > 0 THEN 'high' WHEN v_delta < 0 THEN 'low' ELSE 'moderate' END,
                'score', 50 + v_delta,
                'confidence', v_rule.weight,
                'evidence', v_rule.logic->>'description',
                'decay_at', NOW() + (v_rule.decay_minutes || ' minutes')::INTERVAL
            );
        END IF;
    END LOOP;

    -- Update evidence with rules applied
    v_evidence := jsonb_set(
        v_evidence,
        '{rules_applied}',
        to_jsonb(v_rules_applied)
    );

    -- ===========================================================================
    -- Normalize Scores and Determine State
    -- ===========================================================================

    -- Clamp scores to 0-100
    v_energy_score := GREATEST(0, LEAST(100, v_energy_score));
    v_physical_score := GREATEST(0, LEAST(100, v_physical_score));
    v_cognitive_score := GREATEST(0, LEAST(100, v_cognitive_score));
    v_emotional_score := GREATEST(0, LEAST(100, v_emotional_score));

    -- Overall is minimum of all dimensions
    v_overall_score := LEAST(v_energy_score, v_physical_score, v_cognitive_score, v_emotional_score);

    -- Determine limiting dimension
    IF v_overall_score = v_physical_score AND v_physical_score < 50 THEN
        v_limiting_dimension := 'physical';
    ELSIF v_overall_score = v_cognitive_score AND v_cognitive_score < 50 THEN
        v_limiting_dimension := 'cognitive';
    ELSIF v_overall_score = v_emotional_score AND v_emotional_score < 50 THEN
        v_limiting_dimension := 'emotional';
    END IF;

    -- Determine energy state from score
    IF v_energy_score < 35 THEN
        v_energy_state := 'low';
        v_context_tags := ARRAY['low_energy_mode', 'restorative_only'];
        v_min_intensity := 'restorative';
        v_max_intensity := 'light';
    ELSIF v_energy_score < 65 THEN
        v_energy_state := 'moderate';
        v_context_tags := ARRAY['light_activity_ok', 'moderate_ok'];
        v_min_intensity := 'light';
        v_max_intensity := 'moderate';
    ELSE
        v_energy_state := 'high';
        v_context_tags := ARRAY['moderate_ok', 'high_capacity_ok'];
        v_min_intensity := 'moderate';
        v_max_intensity := 'high';
    END IF;

    -- Adjust context tags based on limiting dimension
    IF v_limiting_dimension = 'cognitive' AND v_cognitive_score < 35 THEN
        v_context_tags := array_append(v_context_tags, 'cognitive_rest_needed');
    END IF;
    IF v_limiting_dimension = 'emotional' AND v_emotional_score < 35 THEN
        v_context_tags := array_append(v_context_tags, 'emotional_rest_needed');
    END IF;

    -- Calculate confidence based on evidence
    IF v_total_weight > 0 THEN
        v_confidence := LEAST(100, 40 + (v_total_weight / 5));
    END IF;

    -- ===========================================================================
    -- Upsert Capacity State Row
    -- ===========================================================================
    INSERT INTO public.capacity_state (
        tenant_id,
        user_id,
        session_id,
        energy_state,
        energy_score,
        capacity_physical,
        capacity_cognitive,
        capacity_emotional,
        capacity_overall,
        limiting_dimension,
        context_tags,
        min_intensity,
        max_intensity,
        signals,
        evidence,
        confidence,
        decay_at
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_session_id,
        v_energy_state,
        v_energy_score,
        v_physical_score,
        v_cognitive_score,
        v_emotional_score,
        v_overall_score,
        v_limiting_dimension,
        v_context_tags,
        v_min_intensity,
        v_max_intensity,
        v_signals,
        v_evidence,
        v_confidence,
        v_decay_at
    )
    ON CONFLICT (tenant_id, user_id, session_id)
    DO UPDATE SET
        energy_state = EXCLUDED.energy_state,
        energy_score = EXCLUDED.energy_score,
        capacity_physical = EXCLUDED.capacity_physical,
        capacity_cognitive = EXCLUDED.capacity_cognitive,
        capacity_emotional = EXCLUDED.capacity_emotional,
        capacity_overall = EXCLUDED.capacity_overall,
        limiting_dimension = EXCLUDED.limiting_dimension,
        context_tags = EXCLUDED.context_tags,
        min_intensity = EXCLUDED.min_intensity,
        max_intensity = EXCLUDED.max_intensity,
        signals = EXCLUDED.signals,
        evidence = EXCLUDED.evidence,
        confidence = EXCLUDED.confidence,
        decay_at = EXCLUDED.decay_at,
        updated_at = NOW();

    -- Return capacity bundle
    RETURN jsonb_build_object(
        'ok', true,
        'capacity_state', jsonb_build_object(
            'energy_state', v_energy_state,
            'energy_score', v_energy_score,
            'capacity_envelope', jsonb_build_object(
                'physical', v_physical_score,
                'cognitive', v_cognitive_score,
                'emotional', v_emotional_score,
                'overall', v_overall_score,
                'confidence', v_confidence,
                'limiting_dimension', v_limiting_dimension
            ),
            'context_tags', v_context_tags,
            'min_intensity', v_min_intensity,
            'max_intensity', v_max_intensity,
            'signals', v_signals,
            'confidence', v_confidence,
            'decay_at', v_decay_at,
            'generated_at', NOW(),
            'disclaimer', 'These are probabilistic observations about energy and capacity, not medical or clinical assessments. User corrections override all inferences.'
        ),
        'evidence', v_evidence
    );
END;
$$;

-- ===========================================================================
-- 7. RPC: capacity_get_current(p_session_id uuid)
-- Get current capacity state (checking for overrides first)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.capacity_get_current(
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
    v_state RECORD;
    v_override RECORD;
BEGIN
    -- Gate 1: Get tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Gate 2: Get user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Check for active override first
    SELECT * INTO v_override
    FROM public.capacity_overrides
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND expired = false
      AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 1;

    -- Mark decayed states
    UPDATE public.capacity_state
    SET decayed = true, updated_at = NOW()
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND decayed = false
      AND decay_at < NOW();

    -- Fetch current state
    SELECT * INTO v_state
    FROM public.capacity_state
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND decayed = false
      AND (p_session_id IS NULL OR session_id = p_session_id)
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_state IS NULL AND v_override IS NULL THEN
        -- No state available - return unknown
        RETURN jsonb_build_object(
            'ok', true,
            'capacity_state', jsonb_build_object(
                'energy_state', 'unknown',
                'energy_score', 50,
                'capacity_envelope', jsonb_build_object(
                    'physical', 50,
                    'cognitive', 50,
                    'emotional', 50,
                    'overall', 50,
                    'confidence', 30,
                    'limiting_dimension', null
                ),
                'context_tags', ARRAY['moderate_ok'],
                'min_intensity', 'light',
                'max_intensity', 'moderate',
                'signals', '[]'::JSONB,
                'confidence', 30,
                'decay_at', NOW() + INTERVAL '30 minutes',
                'generated_at', NOW(),
                'disclaimer', 'No capacity data available. Defaulting to moderate capacity. User corrections override all inferences.'
            ),
            'has_override', false
        );
    END IF;

    -- Return current state
    RETURN jsonb_build_object(
        'ok', true,
        'capacity_state', jsonb_build_object(
            'energy_state', COALESCE(v_state.energy_state, 'unknown'),
            'energy_score', COALESCE(v_state.energy_score, 50),
            'capacity_envelope', jsonb_build_object(
                'physical', COALESCE(v_state.capacity_physical, 50),
                'cognitive', COALESCE(v_state.capacity_cognitive, 50),
                'emotional', COALESCE(v_state.capacity_emotional, 50),
                'overall', COALESCE(v_state.capacity_overall, 50),
                'confidence', COALESCE(v_state.confidence, 30),
                'limiting_dimension', v_state.limiting_dimension
            ),
            'context_tags', COALESCE(v_state.context_tags, ARRAY['moderate_ok']),
            'min_intensity', COALESCE(v_state.min_intensity, 'light'),
            'max_intensity', COALESCE(v_state.max_intensity, 'moderate'),
            'signals', COALESCE(v_state.signals, '[]'::JSONB),
            'confidence', COALESCE(v_state.confidence, 30),
            'decay_at', COALESCE(v_state.decay_at, NOW() + INTERVAL '30 minutes'),
            'generated_at', v_state.created_at,
            'disclaimer', COALESCE(v_state.disclaimer, 'These are probabilistic observations about energy and capacity, not medical or clinical assessments.')
        ),
        'has_override', v_override IS NOT NULL,
        'override_expires_at', v_override.expires_at
    );
END;
$$;

-- ===========================================================================
-- 8. RPC: capacity_override(p_energy_state text, p_note text, p_duration_minutes int)
-- User correction immediately overrides capacity state
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.capacity_override(
    p_energy_state TEXT,
    p_note TEXT DEFAULT NULL,
    p_duration_minutes INT DEFAULT 60
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_previous_state TEXT;
    v_override_id UUID;
    v_expires_at TIMESTAMPTZ;
BEGIN
    -- Gate 1: Get tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Gate 2: Get user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Validate energy state
    IF p_energy_state NOT IN ('low', 'moderate', 'high') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_STATE',
            'message', 'energy_state must be low, moderate, or high'
        );
    END IF;

    -- Clamp duration
    p_duration_minutes := GREATEST(5, LEAST(480, p_duration_minutes));
    v_expires_at := NOW() + (p_duration_minutes || ' minutes')::INTERVAL;

    -- Get previous state
    SELECT energy_state INTO v_previous_state
    FROM public.capacity_state
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND decayed = false
    ORDER BY created_at DESC
    LIMIT 1;

    -- Expire any existing overrides
    UPDATE public.capacity_overrides
    SET expired = true
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND expired = false;

    -- Create new override
    INSERT INTO public.capacity_overrides (
        tenant_id,
        user_id,
        energy_state,
        note,
        previous_state,
        expires_at
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_energy_state,
        p_note,
        v_previous_state,
        v_expires_at
    )
    RETURNING id INTO v_override_id;

    RETURN jsonb_build_object(
        'ok', true,
        'message', 'Capacity state overridden by user',
        'override_id', v_override_id,
        'previous_state', v_previous_state,
        'new_state', p_energy_state,
        'expires_at', v_expires_at
    );
END;
$$;

-- ===========================================================================
-- 9. RPC: capacity_filter_actions(p_actions jsonb, p_respect_capacity boolean)
-- Filter/rank actions by current capacity
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.capacity_filter_actions(
    p_actions JSONB,
    p_respect_capacity BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_capacity_result JSONB;
    v_energy_state TEXT;
    v_max_intensity TEXT;
    v_action RECORD;
    v_filtered_actions JSONB := '[]'::JSONB;
    v_intensity_order TEXT[] := ARRAY['restorative', 'light', 'moderate', 'high'];
    v_action_intensity_idx INT;
    v_max_intensity_idx INT;
    v_capacity_fit TEXT;
    v_recommended BOOLEAN;
    v_blocked_count INT := 0;
    v_recommended_count INT := 0;
BEGIN
    -- Get current capacity
    v_capacity_result := public.capacity_get_current(NULL);

    IF NOT (v_capacity_result->>'ok')::BOOLEAN THEN
        RETURN v_capacity_result;
    END IF;

    v_energy_state := v_capacity_result->'capacity_state'->>'energy_state';
    v_max_intensity := v_capacity_result->'capacity_state'->>'max_intensity';

    -- Get max intensity index
    v_max_intensity_idx := array_position(v_intensity_order, v_max_intensity);
    IF v_max_intensity_idx IS NULL THEN
        v_max_intensity_idx := 3; -- Default to moderate
    END IF;

    -- Process each action
    FOR v_action IN
        SELECT * FROM jsonb_array_elements(p_actions) AS a
    LOOP
        -- Get action intensity index
        v_action_intensity_idx := array_position(v_intensity_order, v_action.a->>'intensity');
        IF v_action_intensity_idx IS NULL THEN
            v_action_intensity_idx := 3; -- Default to moderate
        END IF;

        -- Determine capacity fit
        IF p_respect_capacity THEN
            IF v_action_intensity_idx <= v_max_intensity_idx - 1 THEN
                v_capacity_fit := 'excellent';
                v_recommended := true;
            ELSIF v_action_intensity_idx = v_max_intensity_idx THEN
                v_capacity_fit := 'good';
                v_recommended := true;
            ELSIF v_action_intensity_idx = v_max_intensity_idx + 1 THEN
                v_capacity_fit := 'marginal';
                v_recommended := v_energy_state != 'low';
            ELSE
                v_capacity_fit := 'exceeds';
                v_recommended := false;
            END IF;
        ELSE
            v_capacity_fit := 'unknown';
            v_recommended := true;
        END IF;

        -- Count
        IF v_recommended THEN
            v_recommended_count := v_recommended_count + 1;
        ELSE
            v_blocked_count := v_blocked_count + 1;
        END IF;

        -- Add to result
        v_filtered_actions := v_filtered_actions || jsonb_build_object(
            'action', v_action.a->>'action',
            'action_type', v_action.a->>'action_type',
            'intensity', v_action.a->>'intensity',
            'capacity_fit', v_capacity_fit,
            'confidence', (v_capacity_result->'capacity_state'->>'confidence')::INT,
            'reason', CASE
                WHEN v_capacity_fit = 'exceeds' THEN 'Intensity exceeds current capacity'
                WHEN v_capacity_fit = 'marginal' THEN 'At edge of capacity'
                WHEN v_capacity_fit = 'excellent' THEN 'Well within capacity'
                ELSE 'Good fit for current capacity'
            END,
            'recommended', v_recommended
        );
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'filtered_actions', v_filtered_actions,
        'capacity_state', v_capacity_result->'capacity_state',
        'blocked_count', v_blocked_count,
        'recommended_count', v_recommended_count
    );
END;
$$;

-- ===========================================================================
-- 10. Permissions
-- ===========================================================================

-- Grant execute on RPCs to authenticated users
GRANT EXECUTE ON FUNCTION public.capacity_compute(TEXT, UUID, TEXT, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.capacity_get_current(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.capacity_override(TEXT, TEXT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.capacity_filter_actions(JSONB, BOOLEAN) TO authenticated;

-- Grant table access (RLS enforces row-level security)
GRANT SELECT ON public.capacity_state TO authenticated;
GRANT SELECT ON public.capacity_overrides TO authenticated;
GRANT SELECT ON public.capacity_rules TO authenticated;

-- ===========================================================================
-- 11. Comments
-- ===========================================================================

COMMENT ON TABLE public.capacity_state IS 'VTID-01122: Computed capacity state per session. Probabilistic, never diagnostic.';
COMMENT ON TABLE public.capacity_overrides IS 'VTID-01122: User overrides that immediately take precedence over inferences.';
COMMENT ON TABLE public.capacity_rules IS 'VTID-01122: Deterministic rule registry for capacity computation.';

COMMENT ON FUNCTION public.capacity_compute IS 'VTID-01122: Compute capacity state from multiple signal sources. Deterministic, rule-based only.';
COMMENT ON FUNCTION public.capacity_get_current IS 'VTID-01122: Get current capacity state (with override check).';
COMMENT ON FUNCTION public.capacity_override IS 'VTID-01122: User correction immediately overrides capacity state.';
COMMENT ON FUNCTION public.capacity_filter_actions IS 'VTID-01122: Filter actions by current capacity for health-aligned recommendations.';
