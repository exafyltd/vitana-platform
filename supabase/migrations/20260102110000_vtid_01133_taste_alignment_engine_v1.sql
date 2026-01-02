-- Migration: 20260102110000_vtid_01133_taste_alignment_engine_v1.sql
-- Purpose: VTID-01133 D39 Core Intelligence - Taste, Aesthetic & Lifestyle Alignment Engine v1
-- Date: 2026-01-02
--
-- Aligns all recommendations with the user's taste, aesthetic preferences, and lifestyle identity.
-- Ensures suggestions "feel like me" to the user, increasing resonance, trust, and long-term engagement.
--
-- Core Question: "Does this fit who I am and how I like to live?"
--
-- Dependencies:
--   - VTID-01119 (D27 User Preference Modeling) - preference bundle
--   - VTID-01120 (D28 Emotional/Cognitive) - emotional signals
--   - VTID-01096 (Cross-Domain Personalization) - weakness detection
--   - D20-D38 Intelligence Stack

-- ===========================================================================
-- 1. TASTE PROFILE TABLE
-- ===========================================================================
-- Captures user's taste preferences: simplicity, premium orientation, aesthetic style, tone

CREATE TABLE IF NOT EXISTS public.user_taste_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Taste dimensions (per spec section 2.1)
    simplicity_preference TEXT NOT NULL DEFAULT 'balanced'
        CHECK (simplicity_preference IN ('minimalist', 'balanced', 'comprehensive')),
    premium_orientation TEXT NOT NULL DEFAULT 'quality_balanced'
        CHECK (premium_orientation IN ('value_focused', 'quality_balanced', 'premium_oriented')),
    aesthetic_style TEXT NOT NULL DEFAULT 'neutral'
        CHECK (aesthetic_style IN ('modern', 'classic', 'eclectic', 'natural', 'functional', 'neutral')),
    tone_affinity TEXT NOT NULL DEFAULT 'neutral'
        CHECK (tone_affinity IN ('technical', 'expressive', 'casual', 'professional', 'minimalist', 'neutral')),

    -- Confidence and metadata
    confidence INT NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 100),
    source TEXT NOT NULL DEFAULT 'inferred' CHECK (source IN ('explicit', 'inferred', 'onboarding', 'hybrid')),
    evidence JSONB NOT NULL DEFAULT '[]'::JSONB,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One profile per user per tenant
    UNIQUE (tenant_id, user_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_user_taste_profiles_tenant_user
    ON public.user_taste_profiles (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_user_taste_profiles_confidence
    ON public.user_taste_profiles (tenant_id, user_id, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_user_taste_profiles_updated
    ON public.user_taste_profiles (updated_at DESC);

-- ===========================================================================
-- 2. LIFESTYLE PROFILE TABLE
-- ===========================================================================
-- Captures user's lifestyle patterns: routine style, social orientation, etc.

CREATE TABLE IF NOT EXISTS public.user_lifestyle_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Lifestyle dimensions (per spec section 2.2)
    routine_style TEXT NOT NULL DEFAULT 'hybrid'
        CHECK (routine_style IN ('structured', 'flexible', 'hybrid')),
    social_orientation TEXT NOT NULL DEFAULT 'adaptive'
        CHECK (social_orientation IN ('solo_focused', 'small_groups', 'social_oriented', 'adaptive')),
    convenience_bias TEXT NOT NULL DEFAULT 'balanced'
        CHECK (convenience_bias IN ('convenience_first', 'balanced', 'intentional_living')),
    experience_type TEXT NOT NULL DEFAULT 'blended'
        CHECK (experience_type IN ('digital_native', 'physical_focused', 'blended')),
    novelty_tolerance TEXT NOT NULL DEFAULT 'moderate'
        CHECK (novelty_tolerance IN ('conservative', 'moderate', 'explorer')),

    -- Confidence and metadata
    confidence INT NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 100),
    source TEXT NOT NULL DEFAULT 'inferred' CHECK (source IN ('explicit', 'inferred', 'onboarding', 'hybrid')),
    evidence JSONB NOT NULL DEFAULT '[]'::JSONB,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One profile per user per tenant
    UNIQUE (tenant_id, user_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_user_lifestyle_profiles_tenant_user
    ON public.user_lifestyle_profiles (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_user_lifestyle_profiles_confidence
    ON public.user_lifestyle_profiles (tenant_id, user_id, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_user_lifestyle_profiles_updated
    ON public.user_lifestyle_profiles (updated_at DESC);

-- ===========================================================================
-- 3. TASTE SIGNALS TABLE
-- ===========================================================================
-- Records signals used to infer taste/lifestyle preferences

CREATE TABLE IF NOT EXISTS public.taste_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Signal metadata
    signal_type TEXT NOT NULL CHECK (signal_type IN ('taste', 'lifestyle')),
    source TEXT NOT NULL CHECK (source IN (
        'explicit_setting', 'language_analysis', 'brand_interaction',
        'reaction_pattern', 'diary_content', 'behavior_pattern',
        'social_pattern', 'onboarding'
    )),
    dimension TEXT NOT NULL, -- e.g., 'simplicity_preference', 'routine_style'
    inferred_value TEXT NOT NULL,

    -- Confidence and evidence
    confidence INT NOT NULL DEFAULT 50 CHECK (confidence >= 0 AND confidence <= 100),
    evidence JSONB NULL,

    -- Context
    context JSONB NULL, -- Additional context (session_id, action_id, etc.)

    -- Timestamps
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed BOOLEAN NOT NULL DEFAULT FALSE,
    processed_at TIMESTAMPTZ NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_taste_signals_tenant_user
    ON public.taste_signals (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_taste_signals_type_dimension
    ON public.taste_signals (tenant_id, user_id, signal_type, dimension);

CREATE INDEX IF NOT EXISTS idx_taste_signals_unprocessed
    ON public.taste_signals (tenant_id, user_id, processed) WHERE processed = FALSE;

CREATE INDEX IF NOT EXISTS idx_taste_signals_observed
    ON public.taste_signals (observed_at DESC);

-- ===========================================================================
-- 4. TASTE REACTIONS TABLE
-- ===========================================================================
-- Records user reactions to recommendations for implicit taste learning

CREATE TABLE IF NOT EXISTS public.taste_reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Reaction details
    action_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    reaction TEXT NOT NULL CHECK (reaction IN (
        'accepted', 'rejected', 'saved', 'dismissed', 'engaged', 'skipped'
    )),

    -- Action attributes for learning
    action_attributes JSONB NOT NULL DEFAULT '{}'::JSONB,

    -- Alignment score at time of reaction (for feedback loop)
    alignment_score_at_reaction NUMERIC(4,3) NULL CHECK (alignment_score_at_reaction >= 0 AND alignment_score_at_reaction <= 1),

    -- Context
    session_id TEXT NULL,
    context JSONB NULL,

    -- Processing
    processed BOOLEAN NOT NULL DEFAULT FALSE,
    processed_at TIMESTAMPTZ NULL,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_taste_reactions_tenant_user
    ON public.taste_reactions (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_taste_reactions_action
    ON public.taste_reactions (tenant_id, user_id, action_type, reaction);

CREATE INDEX IF NOT EXISTS idx_taste_reactions_unprocessed
    ON public.taste_reactions (tenant_id, user_id, processed) WHERE processed = FALSE;

CREATE INDEX IF NOT EXISTS idx_taste_reactions_created
    ON public.taste_reactions (created_at DESC);

-- ===========================================================================
-- 5. TASTE ALIGNMENT BUNDLES TABLE
-- ===========================================================================
-- Computed alignment bundles for fast downstream consumption

CREATE TABLE IF NOT EXISTS public.taste_alignment_bundles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Profiles (denormalized for fast access)
    taste_profile JSONB NOT NULL DEFAULT '{}'::JSONB,
    lifestyle_profile JSONB NOT NULL DEFAULT '{}'::JSONB,

    -- Aggregate metrics
    combined_confidence INT NOT NULL DEFAULT 0 CHECK (combined_confidence >= 0 AND combined_confidence <= 100),
    profile_completeness INT NOT NULL DEFAULT 0 CHECK (profile_completeness >= 0 AND profile_completeness <= 100),
    sparse_data BOOLEAN NOT NULL DEFAULT TRUE,

    -- Processing metadata
    signal_count INT NOT NULL DEFAULT 0,
    reaction_count INT NOT NULL DEFAULT 0,
    last_signal_at TIMESTAMPTZ NULL,
    last_reaction_at TIMESTAMPTZ NULL,

    -- Timestamps
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One bundle per user per tenant
    UNIQUE (tenant_id, user_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_taste_alignment_bundles_tenant_user
    ON public.taste_alignment_bundles (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_taste_alignment_bundles_computed
    ON public.taste_alignment_bundles (computed_at DESC);

-- ===========================================================================
-- 6. TASTE ALIGNMENT AUDIT TABLE
-- ===========================================================================
-- Full audit trail for all taste alignment changes

CREATE TABLE IF NOT EXISTS public.taste_alignment_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Audit metadata
    action TEXT NOT NULL CHECK (action IN (
        'taste_profile_updated', 'lifestyle_profile_updated',
        'signal_recorded', 'inference_applied',
        'bundle_computed', 'actions_scored', 'reaction_recorded'
    )),
    target_type TEXT NOT NULL CHECK (target_type IN (
        'taste_profile', 'lifestyle_profile', 'signal', 'bundle', 'scoring', 'reaction'
    )),
    target_id UUID NULL,

    -- Change details
    old_value JSONB NULL,
    new_value JSONB NULL,
    confidence_delta INT NULL,

    -- Metadata
    metadata JSONB NULL,
    reason_code TEXT NULL,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_taste_alignment_audit_tenant_user
    ON public.taste_alignment_audit (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_taste_alignment_audit_action
    ON public.taste_alignment_audit (action);

CREATE INDEX IF NOT EXISTS idx_taste_alignment_audit_target
    ON public.taste_alignment_audit (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_taste_alignment_audit_created
    ON public.taste_alignment_audit (created_at DESC);

-- ===========================================================================
-- 7. ROW LEVEL SECURITY
-- ===========================================================================

-- Enable RLS on all tables
ALTER TABLE public.user_taste_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_lifestyle_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.taste_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.taste_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.taste_alignment_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.taste_alignment_audit ENABLE ROW LEVEL SECURITY;

-- user_taste_profiles: User owns their taste profile
DROP POLICY IF EXISTS user_taste_profiles_select ON public.user_taste_profiles;
CREATE POLICY user_taste_profiles_select ON public.user_taste_profiles
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS user_taste_profiles_insert ON public.user_taste_profiles;
CREATE POLICY user_taste_profiles_insert ON public.user_taste_profiles
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS user_taste_profiles_update ON public.user_taste_profiles;
CREATE POLICY user_taste_profiles_update ON public.user_taste_profiles
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid())
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

-- user_lifestyle_profiles: User owns their lifestyle profile
DROP POLICY IF EXISTS user_lifestyle_profiles_select ON public.user_lifestyle_profiles;
CREATE POLICY user_lifestyle_profiles_select ON public.user_lifestyle_profiles
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS user_lifestyle_profiles_insert ON public.user_lifestyle_profiles;
CREATE POLICY user_lifestyle_profiles_insert ON public.user_lifestyle_profiles
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS user_lifestyle_profiles_update ON public.user_lifestyle_profiles;
CREATE POLICY user_lifestyle_profiles_update ON public.user_lifestyle_profiles
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid())
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

-- taste_signals: User owns their signals
DROP POLICY IF EXISTS taste_signals_select ON public.taste_signals;
CREATE POLICY taste_signals_select ON public.taste_signals
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS taste_signals_insert ON public.taste_signals;
CREATE POLICY taste_signals_insert ON public.taste_signals
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

-- taste_reactions: User owns their reactions
DROP POLICY IF EXISTS taste_reactions_select ON public.taste_reactions;
CREATE POLICY taste_reactions_select ON public.taste_reactions
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS taste_reactions_insert ON public.taste_reactions;
CREATE POLICY taste_reactions_insert ON public.taste_reactions
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

-- taste_alignment_bundles: User owns their bundle
DROP POLICY IF EXISTS taste_alignment_bundles_select ON public.taste_alignment_bundles;
CREATE POLICY taste_alignment_bundles_select ON public.taste_alignment_bundles
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS taste_alignment_bundles_insert ON public.taste_alignment_bundles;
CREATE POLICY taste_alignment_bundles_insert ON public.taste_alignment_bundles
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS taste_alignment_bundles_update ON public.taste_alignment_bundles;
CREATE POLICY taste_alignment_bundles_update ON public.taste_alignment_bundles
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid())
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

-- taste_alignment_audit: User can view their audit history
DROP POLICY IF EXISTS taste_alignment_audit_select ON public.taste_alignment_audit;
CREATE POLICY taste_alignment_audit_select ON public.taste_alignment_audit
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS taste_alignment_audit_insert ON public.taste_alignment_audit;
CREATE POLICY taste_alignment_audit_insert ON public.taste_alignment_audit
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

-- ===========================================================================
-- 8. RPC FUNCTIONS
-- ===========================================================================

-- 8.1 taste_profile_get - Get user's taste profile
CREATE OR REPLACE FUNCTION public.taste_profile_get()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_profile RECORD;
BEGIN
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    SELECT * INTO v_profile
    FROM public.user_taste_profiles
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id;

    IF v_profile IS NULL THEN
        -- Return default profile
        RETURN jsonb_build_object(
            'ok', true,
            'profile', jsonb_build_object(
                'simplicity_preference', 'balanced',
                'premium_orientation', 'quality_balanced',
                'aesthetic_style', 'neutral',
                'tone_affinity', 'neutral',
                'confidence', 0,
                'source', 'default'
            ),
            'exists', false
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'profile', jsonb_build_object(
            'id', v_profile.id,
            'simplicity_preference', v_profile.simplicity_preference,
            'premium_orientation', v_profile.premium_orientation,
            'aesthetic_style', v_profile.aesthetic_style,
            'tone_affinity', v_profile.tone_affinity,
            'confidence', v_profile.confidence,
            'source', v_profile.source,
            'updated_at', v_profile.updated_at
        ),
        'exists', true
    );
END;
$$;

-- 8.2 taste_profile_set - Set user's taste profile (explicit)
CREATE OR REPLACE FUNCTION public.taste_profile_set(
    p_simplicity_preference TEXT DEFAULT NULL,
    p_premium_orientation TEXT DEFAULT NULL,
    p_aesthetic_style TEXT DEFAULT NULL,
    p_tone_affinity TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_profile_id UUID;
    v_old_profile JSONB;
    v_updated_fields TEXT[] := '{}';
    v_new_confidence INT;
BEGIN
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get existing profile for audit
    SELECT id, to_jsonb(p.*) INTO v_profile_id, v_old_profile
    FROM public.user_taste_profiles p
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id;

    IF v_profile_id IS NULL THEN
        -- Create new profile
        INSERT INTO public.user_taste_profiles (
            tenant_id, user_id,
            simplicity_preference, premium_orientation, aesthetic_style, tone_affinity,
            confidence, source
        ) VALUES (
            v_tenant_id, v_user_id,
            COALESCE(p_simplicity_preference, 'balanced'),
            COALESCE(p_premium_orientation, 'quality_balanced'),
            COALESCE(p_aesthetic_style, 'neutral'),
            COALESCE(p_tone_affinity, 'neutral'),
            100, 'explicit'
        )
        RETURNING id INTO v_profile_id;

        v_updated_fields := ARRAY['simplicity_preference', 'premium_orientation', 'aesthetic_style', 'tone_affinity'];
        v_new_confidence := 100;
    ELSE
        -- Update existing profile
        UPDATE public.user_taste_profiles
        SET
            simplicity_preference = COALESCE(p_simplicity_preference, simplicity_preference),
            premium_orientation = COALESCE(p_premium_orientation, premium_orientation),
            aesthetic_style = COALESCE(p_aesthetic_style, aesthetic_style),
            tone_affinity = COALESCE(p_tone_affinity, tone_affinity),
            confidence = 100,
            source = 'explicit',
            updated_at = NOW()
        WHERE id = v_profile_id
        RETURNING confidence INTO v_new_confidence;

        -- Track which fields were updated
        IF p_simplicity_preference IS NOT NULL THEN v_updated_fields := array_append(v_updated_fields, 'simplicity_preference'); END IF;
        IF p_premium_orientation IS NOT NULL THEN v_updated_fields := array_append(v_updated_fields, 'premium_orientation'); END IF;
        IF p_aesthetic_style IS NOT NULL THEN v_updated_fields := array_append(v_updated_fields, 'aesthetic_style'); END IF;
        IF p_tone_affinity IS NOT NULL THEN v_updated_fields := array_append(v_updated_fields, 'tone_affinity'); END IF;
    END IF;

    -- Write audit log
    INSERT INTO public.taste_alignment_audit (
        tenant_id, user_id, action, target_type, target_id,
        old_value, new_value, reason_code
    ) VALUES (
        v_tenant_id, v_user_id, 'taste_profile_updated', 'taste_profile', v_profile_id,
        v_old_profile,
        jsonb_build_object(
            'simplicity_preference', p_simplicity_preference,
            'premium_orientation', p_premium_orientation,
            'aesthetic_style', p_aesthetic_style,
            'tone_affinity', p_tone_affinity
        ),
        'user_explicit_set'
    );

    RETURN jsonb_build_object(
        'ok', true,
        'profile_id', v_profile_id,
        'profile_type', 'taste',
        'updated_fields', v_updated_fields,
        'new_confidence', v_new_confidence
    );
END;
$$;

-- 8.3 lifestyle_profile_get - Get user's lifestyle profile
CREATE OR REPLACE FUNCTION public.lifestyle_profile_get()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_profile RECORD;
BEGIN
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    SELECT * INTO v_profile
    FROM public.user_lifestyle_profiles
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id;

    IF v_profile IS NULL THEN
        -- Return default profile
        RETURN jsonb_build_object(
            'ok', true,
            'profile', jsonb_build_object(
                'routine_style', 'hybrid',
                'social_orientation', 'adaptive',
                'convenience_bias', 'balanced',
                'experience_type', 'blended',
                'novelty_tolerance', 'moderate',
                'confidence', 0,
                'source', 'default'
            ),
            'exists', false
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'profile', jsonb_build_object(
            'id', v_profile.id,
            'routine_style', v_profile.routine_style,
            'social_orientation', v_profile.social_orientation,
            'convenience_bias', v_profile.convenience_bias,
            'experience_type', v_profile.experience_type,
            'novelty_tolerance', v_profile.novelty_tolerance,
            'confidence', v_profile.confidence,
            'source', v_profile.source,
            'updated_at', v_profile.updated_at
        ),
        'exists', true
    );
END;
$$;

-- 8.4 lifestyle_profile_set - Set user's lifestyle profile (explicit)
CREATE OR REPLACE FUNCTION public.lifestyle_profile_set(
    p_routine_style TEXT DEFAULT NULL,
    p_social_orientation TEXT DEFAULT NULL,
    p_convenience_bias TEXT DEFAULT NULL,
    p_experience_type TEXT DEFAULT NULL,
    p_novelty_tolerance TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_profile_id UUID;
    v_old_profile JSONB;
    v_updated_fields TEXT[] := '{}';
    v_new_confidence INT;
BEGIN
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get existing profile for audit
    SELECT id, to_jsonb(p.*) INTO v_profile_id, v_old_profile
    FROM public.user_lifestyle_profiles p
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id;

    IF v_profile_id IS NULL THEN
        -- Create new profile
        INSERT INTO public.user_lifestyle_profiles (
            tenant_id, user_id,
            routine_style, social_orientation, convenience_bias, experience_type, novelty_tolerance,
            confidence, source
        ) VALUES (
            v_tenant_id, v_user_id,
            COALESCE(p_routine_style, 'hybrid'),
            COALESCE(p_social_orientation, 'adaptive'),
            COALESCE(p_convenience_bias, 'balanced'),
            COALESCE(p_experience_type, 'blended'),
            COALESCE(p_novelty_tolerance, 'moderate'),
            100, 'explicit'
        )
        RETURNING id INTO v_profile_id;

        v_updated_fields := ARRAY['routine_style', 'social_orientation', 'convenience_bias', 'experience_type', 'novelty_tolerance'];
        v_new_confidence := 100;
    ELSE
        -- Update existing profile
        UPDATE public.user_lifestyle_profiles
        SET
            routine_style = COALESCE(p_routine_style, routine_style),
            social_orientation = COALESCE(p_social_orientation, social_orientation),
            convenience_bias = COALESCE(p_convenience_bias, convenience_bias),
            experience_type = COALESCE(p_experience_type, experience_type),
            novelty_tolerance = COALESCE(p_novelty_tolerance, novelty_tolerance),
            confidence = 100,
            source = 'explicit',
            updated_at = NOW()
        WHERE id = v_profile_id
        RETURNING confidence INTO v_new_confidence;

        -- Track which fields were updated
        IF p_routine_style IS NOT NULL THEN v_updated_fields := array_append(v_updated_fields, 'routine_style'); END IF;
        IF p_social_orientation IS NOT NULL THEN v_updated_fields := array_append(v_updated_fields, 'social_orientation'); END IF;
        IF p_convenience_bias IS NOT NULL THEN v_updated_fields := array_append(v_updated_fields, 'convenience_bias'); END IF;
        IF p_experience_type IS NOT NULL THEN v_updated_fields := array_append(v_updated_fields, 'experience_type'); END IF;
        IF p_novelty_tolerance IS NOT NULL THEN v_updated_fields := array_append(v_updated_fields, 'novelty_tolerance'); END IF;
    END IF;

    -- Write audit log
    INSERT INTO public.taste_alignment_audit (
        tenant_id, user_id, action, target_type, target_id,
        old_value, new_value, reason_code
    ) VALUES (
        v_tenant_id, v_user_id, 'lifestyle_profile_updated', 'lifestyle_profile', v_profile_id,
        v_old_profile,
        jsonb_build_object(
            'routine_style', p_routine_style,
            'social_orientation', p_social_orientation,
            'convenience_bias', p_convenience_bias,
            'experience_type', p_experience_type,
            'novelty_tolerance', p_novelty_tolerance
        ),
        'user_explicit_set'
    );

    RETURN jsonb_build_object(
        'ok', true,
        'profile_id', v_profile_id,
        'profile_type', 'lifestyle',
        'updated_fields', v_updated_fields,
        'new_confidence', v_new_confidence
    );
END;
$$;

-- 8.5 taste_alignment_bundle_get - Get complete alignment bundle
CREATE OR REPLACE FUNCTION public.taste_alignment_bundle_get()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_taste RECORD;
    v_lifestyle RECORD;
    v_signal_count INT;
    v_reaction_count INT;
    v_combined_confidence INT;
    v_profile_completeness INT;
    v_sparse_data BOOLEAN;
BEGIN
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get taste profile
    SELECT * INTO v_taste
    FROM public.user_taste_profiles
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id;

    -- Get lifestyle profile
    SELECT * INTO v_lifestyle
    FROM public.user_lifestyle_profiles
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id;

    -- Count signals and reactions
    SELECT COUNT(*) INTO v_signal_count
    FROM public.taste_signals
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id;

    SELECT COUNT(*) INTO v_reaction_count
    FROM public.taste_reactions
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id;

    -- Calculate combined confidence
    v_combined_confidence := (COALESCE(v_taste.confidence, 0) + COALESCE(v_lifestyle.confidence, 0)) / 2;

    -- Calculate profile completeness (based on non-default values)
    v_profile_completeness := 0;
    IF v_taste IS NOT NULL THEN
        IF v_taste.simplicity_preference != 'balanced' THEN v_profile_completeness := v_profile_completeness + 10; END IF;
        IF v_taste.premium_orientation != 'quality_balanced' THEN v_profile_completeness := v_profile_completeness + 10; END IF;
        IF v_taste.aesthetic_style != 'neutral' THEN v_profile_completeness := v_profile_completeness + 10; END IF;
        IF v_taste.tone_affinity != 'neutral' THEN v_profile_completeness := v_profile_completeness + 10; END IF;
    END IF;
    IF v_lifestyle IS NOT NULL THEN
        IF v_lifestyle.routine_style != 'hybrid' THEN v_profile_completeness := v_profile_completeness + 12; END IF;
        IF v_lifestyle.social_orientation != 'adaptive' THEN v_profile_completeness := v_profile_completeness + 12; END IF;
        IF v_lifestyle.convenience_bias != 'balanced' THEN v_profile_completeness := v_profile_completeness + 12; END IF;
        IF v_lifestyle.experience_type != 'blended' THEN v_profile_completeness := v_profile_completeness + 12; END IF;
        IF v_lifestyle.novelty_tolerance != 'moderate' THEN v_profile_completeness := v_profile_completeness + 12; END IF;
    END IF;

    -- Determine if data is sparse
    v_sparse_data := v_combined_confidence < 30 OR v_profile_completeness < 20;

    RETURN jsonb_build_object(
        'ok', true,
        'bundle', jsonb_build_object(
            'taste_profile', CASE WHEN v_taste IS NOT NULL THEN jsonb_build_object(
                'simplicity_preference', v_taste.simplicity_preference,
                'premium_orientation', v_taste.premium_orientation,
                'aesthetic_style', v_taste.aesthetic_style,
                'tone_affinity', v_taste.tone_affinity,
                'confidence', v_taste.confidence,
                'last_updated_at', v_taste.updated_at
            ) ELSE jsonb_build_object(
                'simplicity_preference', 'balanced',
                'premium_orientation', 'quality_balanced',
                'aesthetic_style', 'neutral',
                'tone_affinity', 'neutral',
                'confidence', 0
            ) END,
            'lifestyle_profile', CASE WHEN v_lifestyle IS NOT NULL THEN jsonb_build_object(
                'routine_style', v_lifestyle.routine_style,
                'social_orientation', v_lifestyle.social_orientation,
                'convenience_bias', v_lifestyle.convenience_bias,
                'experience_type', v_lifestyle.experience_type,
                'novelty_tolerance', v_lifestyle.novelty_tolerance,
                'confidence', v_lifestyle.confidence,
                'last_updated_at', v_lifestyle.updated_at
            ) ELSE jsonb_build_object(
                'routine_style', 'hybrid',
                'social_orientation', 'adaptive',
                'convenience_bias', 'balanced',
                'experience_type', 'blended',
                'novelty_tolerance', 'moderate',
                'confidence', 0
            ) END,
            'combined_confidence', v_combined_confidence,
            'profile_completeness', v_profile_completeness,
            'sparse_data', v_sparse_data,
            'signal_count', v_signal_count,
            'reaction_count', v_reaction_count,
            'computed_at', NOW()
        )
    );
END;
$$;

-- 8.6 taste_reaction_record - Record user reaction for learning
CREATE OR REPLACE FUNCTION public.taste_reaction_record(
    p_action_id TEXT,
    p_action_type TEXT,
    p_reaction TEXT,
    p_action_attributes JSONB DEFAULT '{}'::JSONB,
    p_alignment_score NUMERIC DEFAULT NULL,
    p_session_id TEXT DEFAULT NULL,
    p_context JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_reaction_id UUID;
BEGIN
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Validate reaction type
    IF p_reaction NOT IN ('accepted', 'rejected', 'saved', 'dismissed', 'engaged', 'skipped') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_REACTION', 'message', 'Reaction must be one of: accepted, rejected, saved, dismissed, engaged, skipped');
    END IF;

    -- Insert reaction
    INSERT INTO public.taste_reactions (
        tenant_id, user_id,
        action_id, action_type, reaction,
        action_attributes, alignment_score_at_reaction,
        session_id, context
    ) VALUES (
        v_tenant_id, v_user_id,
        p_action_id, p_action_type, p_reaction,
        p_action_attributes, p_alignment_score,
        p_session_id, p_context
    )
    RETURNING id INTO v_reaction_id;

    -- Write audit log
    INSERT INTO public.taste_alignment_audit (
        tenant_id, user_id, action, target_type, target_id,
        new_value, reason_code
    ) VALUES (
        v_tenant_id, v_user_id, 'reaction_recorded', 'reaction', v_reaction_id,
        jsonb_build_object(
            'action_id', p_action_id,
            'action_type', p_action_type,
            'reaction', p_reaction
        ),
        'user_interaction'
    );

    RETURN jsonb_build_object(
        'ok', true,
        'recorded', true,
        'reaction_id', v_reaction_id
    );
END;
$$;

-- 8.7 taste_alignment_audit_get - Get audit history
CREATE OR REPLACE FUNCTION public.taste_alignment_audit_get(
    p_limit INT DEFAULT 50,
    p_offset INT DEFAULT 0,
    p_target_type TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_audit JSONB;
    v_total INT;
BEGIN
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Cap limits
    IF p_limit IS NULL OR p_limit < 1 THEN p_limit := 50; END IF;
    IF p_limit > 100 THEN p_limit := 100; END IF;
    IF p_offset IS NULL OR p_offset < 0 THEN p_offset := 0; END IF;

    -- Get total count
    SELECT COUNT(*) INTO v_total
    FROM public.taste_alignment_audit
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND (p_target_type IS NULL OR target_type = p_target_type);

    -- Get audit entries
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', id,
                'action', action,
                'target_type', target_type,
                'target_id', target_id,
                'old_value', old_value,
                'new_value', new_value,
                'confidence_delta', confidence_delta,
                'metadata', metadata,
                'reason_code', reason_code,
                'created_at', created_at
            )
            ORDER BY created_at DESC
        ),
        '[]'::JSONB
    )
    INTO v_audit
    FROM public.taste_alignment_audit
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND (p_target_type IS NULL OR target_type = p_target_type)
    ORDER BY created_at DESC
    LIMIT p_limit
    OFFSET p_offset;

    RETURN jsonb_build_object(
        'ok', true,
        'audit', v_audit,
        'pagination', jsonb_build_object(
            'limit', p_limit,
            'offset', p_offset,
            'total', v_total,
            'has_more', (p_offset + p_limit) < v_total
        )
    );
END;
$$;

-- ===========================================================================
-- 9. PERMISSIONS
-- ===========================================================================

-- RPC functions: callable by authenticated users
GRANT EXECUTE ON FUNCTION public.taste_profile_get() TO authenticated;
GRANT EXECUTE ON FUNCTION public.taste_profile_set(TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lifestyle_profile_get() TO authenticated;
GRANT EXECUTE ON FUNCTION public.lifestyle_profile_set(TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.taste_alignment_bundle_get() TO authenticated;
GRANT EXECUTE ON FUNCTION public.taste_reaction_record(TEXT, TEXT, TEXT, JSONB, NUMERIC, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.taste_alignment_audit_get(INT, INT, TEXT) TO authenticated;

-- Tables: allow authenticated users to interact (RLS enforces row-level access)
GRANT SELECT, INSERT, UPDATE ON public.user_taste_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_lifestyle_profiles TO authenticated;
GRANT SELECT, INSERT ON public.taste_signals TO authenticated;
GRANT SELECT, INSERT ON public.taste_reactions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.taste_alignment_bundles TO authenticated;
GRANT SELECT, INSERT ON public.taste_alignment_audit TO authenticated;

-- ===========================================================================
-- 10. COMMENTS
-- ===========================================================================

COMMENT ON TABLE public.user_taste_profiles IS 'VTID-01133: User taste preferences (simplicity, premium, aesthetic, tone)';
COMMENT ON TABLE public.user_lifestyle_profiles IS 'VTID-01133: User lifestyle patterns (routine, social, convenience, experience, novelty)';
COMMENT ON TABLE public.taste_signals IS 'VTID-01133: Signals used for taste/lifestyle inference';
COMMENT ON TABLE public.taste_reactions IS 'VTID-01133: User reactions for implicit taste learning';
COMMENT ON TABLE public.taste_alignment_bundles IS 'VTID-01133: Computed alignment bundles for downstream consumption';
COMMENT ON TABLE public.taste_alignment_audit IS 'VTID-01133: Audit log for taste alignment changes';

COMMENT ON FUNCTION public.taste_profile_get IS 'VTID-01133: Get user taste profile';
COMMENT ON FUNCTION public.taste_profile_set IS 'VTID-01133: Set user taste profile (explicit)';
COMMENT ON FUNCTION public.lifestyle_profile_get IS 'VTID-01133: Get user lifestyle profile';
COMMENT ON FUNCTION public.lifestyle_profile_set IS 'VTID-01133: Set user lifestyle profile (explicit)';
COMMENT ON FUNCTION public.taste_alignment_bundle_get IS 'VTID-01133: Get complete taste/lifestyle alignment bundle';
COMMENT ON FUNCTION public.taste_reaction_record IS 'VTID-01133: Record user reaction for taste learning';
COMMENT ON FUNCTION public.taste_alignment_audit_get IS 'VTID-01133: Get taste alignment audit history';
