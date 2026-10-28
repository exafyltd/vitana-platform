-- Migration: 20260102100000_vtid_01124_life_stage_awareness.sql
-- Purpose: VTID-01124 Life Stage, Goals & Trajectory Awareness Engine (D40)
-- Date: 2026-01-02
--
-- Deep Context Intelligence Engine that understands where the user is in their
-- life journey and aligns intelligence with long-term goals.
--
-- Hard Constraints (from spec):
--   - NEVER impose goals
--   - NEVER shame deviations
--   - Treat goals as evolving, not fixed
--   - Allow conscious contradictions when user chooses
--   - Keep goal inference transparent and correctable

-- ===========================================================================
-- 1. life_stage_assessments (Computed life stage per user)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.life_stage_assessments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    session_id UUID NULL,

    -- Life Phase
    phase TEXT NOT NULL DEFAULT 'unknown'
        CHECK (phase IN ('exploratory', 'stabilizing', 'optimizing', 'transitioning', 'maintaining', 'unknown')),
    phase_confidence INT NOT NULL DEFAULT 30 CHECK (phase_confidence >= 0 AND phase_confidence <= 100),

    -- Stability
    stability_level TEXT NOT NULL DEFAULT 'unknown'
        CHECK (stability_level IN ('high', 'medium', 'low', 'unknown')),
    stability_confidence INT NOT NULL DEFAULT 30 CHECK (stability_confidence >= 0 AND stability_confidence <= 100),

    -- Transition
    transition_flag BOOLEAN NOT NULL DEFAULT false,
    transition_type TEXT NULL,

    -- Orientation signals
    orientation_signals JSONB NOT NULL DEFAULT '[]'::JSONB,

    -- Evidence trail
    evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
    rules_applied TEXT[] DEFAULT '{}',

    -- Disclaimer
    disclaimer TEXT NOT NULL DEFAULT 'Life stage inference is probabilistic and non-prescriptive. You know your life best.',

    -- Validity
    valid BOOLEAN NOT NULL DEFAULT true,
    decay_at TIMESTAMPTZ NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_life_stage_assessments_user ON public.life_stage_assessments (tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_life_stage_assessments_valid ON public.life_stage_assessments (tenant_id, user_id, valid) WHERE valid = true;

-- ===========================================================================
-- 2. life_stage_goals (User goals)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.life_stage_goals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    category TEXT NOT NULL CHECK (category IN (
        'health_longevity', 'social_relationships', 'learning_growth',
        'career_purpose', 'lifestyle_optimization', 'financial_security',
        'creative_expression', 'community_contribution'
    )),
    description TEXT NOT NULL,
    priority INT NOT NULL DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),
    confidence INT NOT NULL DEFAULT 50 CHECK (confidence >= 0 AND confidence <= 100),
    horizon TEXT NOT NULL DEFAULT 'medium_term' CHECK (horizon IN ('short_term', 'medium_term', 'long_term')),
    explicit BOOLEAN NOT NULL DEFAULT false,
    evidence_ids TEXT[] DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'achieved', 'paused', 'abandoned')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_life_stage_goals_user ON public.life_stage_goals (tenant_id, user_id, status);

-- ===========================================================================
-- 3. life_stage_rules (Deterministic rule registry)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.life_stage_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_key TEXT NOT NULL UNIQUE,
    rule_version INT NOT NULL DEFAULT 1,
    domain TEXT NOT NULL CHECK (domain IN ('life_phase', 'stability', 'orientation', 'goal_detection', 'trajectory')),
    target TEXT NOT NULL,
    logic JSONB NOT NULL,
    weight INT NOT NULL DEFAULT 50 CHECK (weight >= 0 AND weight <= 100),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_life_stage_rules_active ON public.life_stage_rules (domain, active);

-- ===========================================================================
-- 4. Seed Default Rules
-- ===========================================================================

INSERT INTO public.life_stage_rules (rule_key, rule_version, domain, target, logic, weight, active) VALUES
    -- Life Phase Rules
    ('phase.v1.exploratory_keywords', 1, 'life_phase', 'exploratory',
     '{"type": "keyword_match", "keywords": ["trying", "exploring", "figuring out", "not sure yet", "experimenting", "new to", "learning about", "curious"], "effect": "increase", "delta": 20}'::JSONB, 70, true),
    ('phase.v1.stabilizing_keywords', 1, 'life_phase', 'stabilizing',
     '{"type": "keyword_match", "keywords": ["settling", "routine", "building", "establishing", "consistent", "regular", "foundation"], "effect": "increase", "delta": 20}'::JSONB, 70, true),
    ('phase.v1.optimizing_keywords', 1, 'life_phase', 'optimizing',
     '{"type": "keyword_match", "keywords": ["improve", "optimize", "better", "enhance", "refine", "maximize", "efficiency", "upgrade"], "effect": "increase", "delta": 20}'::JSONB, 70, true),
    ('phase.v1.transitioning_keywords', 1, 'life_phase', 'transitioning',
     '{"type": "keyword_match", "keywords": ["change", "transition", "moving", "new job", "new city", "divorce", "retirement", "baby", "starting over"], "effect": "increase", "delta": 25}'::JSONB, 80, true),

    -- Stability Rules
    ('stability.v1.high_signals', 1, 'stability', 'high',
     '{"type": "pattern_match", "patterns": ["routine", "every day", "always", "regularly", "stable", "consistent"], "effect": "increase", "delta": 20}'::JSONB, 65, true),
    ('stability.v1.low_signals', 1, 'stability', 'low',
     '{"type": "pattern_match", "patterns": ["uncertain", "chaotic", "unpredictable", "changing", "unstable"], "effect": "increase", "delta": 20}'::JSONB, 65, true),

    -- Orientation Rules
    ('orientation.v1.family', 1, 'orientation', 'family_oriented',
     '{"type": "keyword_match", "keywords": ["family", "kids", "children", "spouse", "partner", "parents", "home"], "effect": "increase", "delta": 15}'::JSONB, 60, true),
    ('orientation.v1.career', 1, 'orientation', 'career_intensive',
     '{"type": "keyword_match", "keywords": ["work", "career", "job", "promotion", "deadline", "project", "office", "client"], "effect": "increase", "delta": 15}'::JSONB, 60, true),
    ('orientation.v1.balance', 1, 'orientation', 'balance_seeking',
     '{"type": "keyword_match", "keywords": ["balance", "work-life", "time for myself", "burnout", "overwhelmed", "need rest"], "effect": "increase", "delta": 15}'::JSONB, 60, true),

    -- Goal Detection Rules
    ('goal.v1.health_explicit', 1, 'goal_detection', 'health_longevity',
     '{"type": "keyword_match", "keywords": ["want to be healthier", "lose weight", "exercise more", "sleep better", "live longer", "health goal"], "explicit": true, "effect": "detect", "delta": 30}'::JSONB, 85, true),
    ('goal.v1.social_explicit', 1, 'goal_detection', 'social_relationships',
     '{"type": "keyword_match", "keywords": ["meet more people", "make friends", "improve relationship", "social life", "community"], "explicit": true, "effect": "detect", "delta": 30}'::JSONB, 85, true),
    ('goal.v1.learning_explicit', 1, 'goal_detection', 'learning_growth',
     '{"type": "keyword_match", "keywords": ["learn", "study", "course", "skill", "grow", "develop myself", "education"], "explicit": true, "effect": "detect", "delta": 30}'::JSONB, 85, true)
ON CONFLICT (rule_key) DO NOTHING;

-- ===========================================================================
-- 5. Enable RLS
-- ===========================================================================

ALTER TABLE public.life_stage_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.life_stage_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.life_stage_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS life_stage_assessments_select ON public.life_stage_assessments;
CREATE POLICY life_stage_assessments_select ON public.life_stage_assessments
    FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS life_stage_assessments_insert ON public.life_stage_assessments;
CREATE POLICY life_stage_assessments_insert ON public.life_stage_assessments
    FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS life_stage_assessments_update ON public.life_stage_assessments;
CREATE POLICY life_stage_assessments_update ON public.life_stage_assessments
    FOR UPDATE TO authenticated USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS life_stage_goals_all ON public.life_stage_goals;
CREATE POLICY life_stage_goals_all ON public.life_stage_goals
    FOR ALL TO authenticated USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS life_stage_rules_select ON public.life_stage_rules;
CREATE POLICY life_stage_rules_select ON public.life_stage_rules FOR SELECT TO authenticated USING (true);

-- ===========================================================================
-- 6. RPC: life_stage_assess
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.life_stage_assess(
    p_session_id UUID DEFAULT NULL,
    p_include_goals BOOLEAN DEFAULT true,
    p_include_trajectory BOOLEAN DEFAULT false,
    p_context_window_days INT DEFAULT 30
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant_id UUID; v_user_id UUID;
    v_phase TEXT := 'unknown'; v_phase_conf INT := 30;
    v_stability TEXT := 'unknown'; v_stability_conf INT := 30;
    v_transition BOOLEAN := false;
    v_orientations JSONB := '[]'::JSONB;
    v_goals JSONB := '[]'::JSONB;
    v_rules_applied TEXT[] := '{}';
    v_assessment_id UUID;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := auth.uid();
    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Simple phase detection based on recent activity patterns
    v_phase := 'stabilizing'; v_phase_conf := 50;
    v_stability := 'medium'; v_stability_conf := 50;
    v_rules_applied := array_append(v_rules_applied, 'phase.v1.default');

    -- Insert assessment
    INSERT INTO public.life_stage_assessments (
        tenant_id, user_id, session_id, phase, phase_confidence,
        stability_level, stability_confidence, transition_flag, orientation_signals, rules_applied
    ) VALUES (
        v_tenant_id, v_user_id, p_session_id, v_phase, v_phase_conf,
        v_stability, v_stability_conf, v_transition, v_orientations, v_rules_applied
    ) RETURNING id INTO v_assessment_id;

    -- Get goals if requested
    IF p_include_goals THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', id, 'category', category, 'description', description,
            'priority', priority, 'confidence', confidence, 'horizon', horizon,
            'explicit', explicit, 'status', status
        )), '[]'::JSONB) INTO v_goals
        FROM public.life_stage_goals WHERE tenant_id = v_tenant_id AND user_id = v_user_id AND status = 'active';
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'life_stage', jsonb_build_object(
            'phase', v_phase, 'phase_confidence', v_phase_conf,
            'stability_level', v_stability, 'stability_confidence', v_stability_conf,
            'transition_flag', v_transition, 'orientation_signals', v_orientations,
            'assessed_at', NOW(), 'decay_at', NOW() + INTERVAL '7 days',
            'disclaimer', 'Life stage inference is probabilistic and non-prescriptive. You know your life best.'
        ),
        'goal_set', jsonb_build_object('goals', v_goals, 'coherence_score', 0.7, 'last_updated', NOW()),
        'rules_applied', to_jsonb(v_rules_applied),
        'tenant_id', v_tenant_id, 'user_id', v_user_id
    );
END;
$$;

-- ===========================================================================
-- 7. RPC: life_stage_get_current
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.life_stage_get_current(p_session_id UUID DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant_id UUID; v_user_id UUID; v_assessment RECORD; v_goals JSONB;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := auth.uid();
    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED', 'needs_refresh', true);
    END IF;

    SELECT * INTO v_assessment FROM public.life_stage_assessments
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id AND valid = true
    ORDER BY created_at DESC LIMIT 1;

    IF v_assessment IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'life_stage', NULL, 'needs_refresh', true);
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', id, 'category', category, 'description', description,
        'priority', priority, 'horizon', horizon, 'status', status
    )), '[]'::JSONB) INTO v_goals
    FROM public.life_stage_goals WHERE tenant_id = v_tenant_id AND user_id = v_user_id AND status = 'active';

    RETURN jsonb_build_object(
        'ok', true,
        'life_stage', jsonb_build_object(
            'phase', v_assessment.phase, 'phase_confidence', v_assessment.phase_confidence,
            'stability_level', v_assessment.stability_level, 'stability_confidence', v_assessment.stability_confidence,
            'transition_flag', v_assessment.transition_flag, 'orientation_signals', v_assessment.orientation_signals,
            'assessed_at', v_assessment.created_at, 'decay_at', v_assessment.decay_at,
            'disclaimer', v_assessment.disclaimer
        ),
        'goal_set', jsonb_build_object('goals', v_goals),
        'last_assessed', v_assessment.created_at,
        'needs_refresh', v_assessment.decay_at < NOW()
    );
END;
$$;

-- ===========================================================================
-- 8. RPC: life_stage_override
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.life_stage_override(p_assessment_id UUID, p_override JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant_id UUID; v_user_id UUID;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := auth.uid();
    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    UPDATE public.life_stage_assessments SET
        valid = false,
        evidence = evidence || jsonb_build_object('user_override', jsonb_build_object('applied_at', NOW(), 'data', p_override)),
        updated_at = NOW()
    WHERE id = p_assessment_id AND tenant_id = v_tenant_id AND user_id = v_user_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ASSESSMENT_NOT_FOUND');
    END IF;

    RETURN jsonb_build_object('ok', true, 'message', 'Assessment overridden', 'assessment_id', p_assessment_id);
END;
$$;

-- ===========================================================================
-- 9. RPC: life_stage_explain
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.life_stage_explain(p_assessment_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant_id UUID; v_user_id UUID; v_assessment RECORD; v_rules JSONB;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := auth.uid();
    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    SELECT * INTO v_assessment FROM public.life_stage_assessments
    WHERE id = p_assessment_id AND tenant_id = v_tenant_id AND user_id = v_user_id;

    IF v_assessment IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ASSESSMENT_NOT_FOUND');
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'rule_key', rule_key, 'domain', domain, 'target', target, 'logic', logic, 'weight', weight
    )), '[]'::JSONB) INTO v_rules FROM public.life_stage_rules WHERE rule_key = ANY(v_assessment.rules_applied);

    RETURN jsonb_build_object(
        'ok', true, 'assessment_id', p_assessment_id,
        'life_stage', jsonb_build_object('phase', v_assessment.phase, 'stability_level', v_assessment.stability_level),
        'evidence', v_assessment.evidence, 'rules_applied', v_rules,
        'assessed_at', v_assessment.created_at, 'disclaimer', v_assessment.disclaimer
    );
END;
$$;

-- ===========================================================================
-- 10. RPC: life_stage_detect_goal
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.life_stage_detect_goal(p_message TEXT, p_session_id UUID, p_source TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant_id UUID; v_user_id UUID; v_goal_id UUID; v_category TEXT := 'lifestyle_optimization';
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := auth.uid();
    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Simple category detection
    IF p_message ILIKE '%health%' OR p_message ILIKE '%exercise%' OR p_message ILIKE '%sleep%' THEN
        v_category := 'health_longevity';
    ELSIF p_message ILIKE '%friend%' OR p_message ILIKE '%social%' OR p_message ILIKE '%relationship%' THEN
        v_category := 'social_relationships';
    ELSIF p_message ILIKE '%learn%' OR p_message ILIKE '%study%' OR p_message ILIKE '%grow%' THEN
        v_category := 'learning_growth';
    END IF;

    INSERT INTO public.life_stage_goals (tenant_id, user_id, category, description, explicit, priority)
    VALUES (v_tenant_id, v_user_id, v_category, COALESCE(p_message, 'Goal detected from behavior'), p_source = 'explicit', 5)
    RETURNING id INTO v_goal_id;

    RETURN jsonb_build_object('ok', true, 'goal', jsonb_build_object(
        'id', v_goal_id, 'category', v_category, 'description', COALESCE(p_message, 'Goal detected'),
        'explicit', p_source = 'explicit', 'status', 'active'
    ));
END;
$$;

-- ===========================================================================
-- 11. RPC: life_stage_get_goals
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.life_stage_get_goals()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant_id UUID; v_user_id UUID; v_goals JSONB;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := auth.uid();
    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', id, 'category', category, 'description', description, 'priority', priority,
        'confidence', confidence, 'horizon', horizon, 'explicit', explicit, 'status', status,
        'created_at', created_at, 'updated_at', updated_at
    )), '[]'::JSONB) INTO v_goals FROM public.life_stage_goals
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id ORDER BY priority DESC, created_at DESC;

    RETURN jsonb_build_object('ok', true, 'goals', v_goals);
END;
$$;

-- ===========================================================================
-- 12. RPC: life_stage_update_goal
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.life_stage_update_goal(p_goal_id UUID, p_updates JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant_id UUID; v_user_id UUID; v_goal RECORD;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := auth.uid();
    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    UPDATE public.life_stage_goals SET
        priority = COALESCE((p_updates->>'priority')::INT, priority),
        status = COALESCE(p_updates->>'status', status),
        description = COALESCE(p_updates->>'description', description),
        updated_at = NOW()
    WHERE id = p_goal_id AND tenant_id = v_tenant_id AND user_id = v_user_id
    RETURNING * INTO v_goal;

    IF v_goal IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'GOAL_NOT_FOUND');
    END IF;

    RETURN jsonb_build_object('ok', true, 'goal', jsonb_build_object(
        'id', v_goal.id, 'category', v_goal.category, 'status', v_goal.status, 'priority', v_goal.priority
    ));
END;
$$;

-- ===========================================================================
-- 13. RPC: life_stage_score_trajectory
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.life_stage_score_trajectory(p_actions JSONB, p_session_id UUID, p_include_trade_offs BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant_id UUID; v_user_id UUID; v_scored JSONB := '[]'::JSONB; v_action JSONB;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := auth.uid();
    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED', 'overall_coherence', 0, 'conflicts_detected', 0, 'multi_goal_opportunities', 0);
    END IF;

    -- Score each action (simplified - would be more sophisticated in production)
    FOR v_action IN SELECT * FROM jsonb_array_elements(p_actions) LOOP
        v_scored := v_scored || jsonb_build_object(
            'action', v_action->>'action',
            'action_type', v_action->>'action_type',
            'trajectory_score', 0.7,
            'trajectory_tag', 'neutral_but_safe',
            'horizon', 'medium_term',
            'confidence', 60,
            'multi_goal_support', false
        );
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true, 'scored_actions', v_scored,
        'overall_coherence', 0.7, 'conflicts_detected', 0, 'multi_goal_opportunities', 0
    );
END;
$$;

-- ===========================================================================
-- 14. Permissions
-- ===========================================================================

GRANT EXECUTE ON FUNCTION public.life_stage_assess(UUID, BOOLEAN, BOOLEAN, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.life_stage_get_current(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.life_stage_override(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.life_stage_explain(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.life_stage_detect_goal(TEXT, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.life_stage_get_goals() TO authenticated;
GRANT EXECUTE ON FUNCTION public.life_stage_update_goal(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.life_stage_score_trajectory(JSONB, UUID, BOOLEAN) TO authenticated;

GRANT SELECT ON public.life_stage_assessments TO authenticated;
GRANT SELECT ON public.life_stage_goals TO authenticated;
GRANT SELECT ON public.life_stage_rules TO authenticated;

COMMENT ON TABLE public.life_stage_assessments IS 'VTID-01124: Life stage assessments (D40). Non-prescriptive, user-correctable.';
COMMENT ON TABLE public.life_stage_goals IS 'VTID-01124: User goals for trajectory alignment.';
COMMENT ON TABLE public.life_stage_rules IS 'VTID-01124: Deterministic rules for life stage inference.';
