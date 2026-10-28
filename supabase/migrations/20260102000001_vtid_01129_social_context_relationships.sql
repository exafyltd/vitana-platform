-- Migration: 20260102000001_vtid_01129_social_context_relationships.sql
-- Purpose: VTID-01129 D35 Social Context, Relationship Weighting & Proximity Engine
-- Date: 2026-01-02
--
-- Implements:
--   - Social comfort profiles (per user)
--   - Social proximity scoring cache
--   - Relationship tier classification
--   - Context-aware filtering
--
-- D35 ensures the system reasons about:
--   - Personal relationships
--   - Social proximity
--   - Group relevance
--   - Social comfort & trust
--
-- Dependencies:
--   - VTID-01087 (Relationship Graph Memory)
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01102 (Phase B-Fix) - runtime context bridge

-- ===========================================================================
-- A. social_comfort_profiles - User's social comfort settings
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.social_comfort_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Comfort levels: 'comfortable', 'neutral', 'uncomfortable', 'unknown'
    one_to_one TEXT NOT NULL DEFAULT 'neutral' CHECK (
        one_to_one IN ('comfortable', 'neutral', 'uncomfortable', 'unknown')
    ),
    one_to_one_confidence INT NOT NULL DEFAULT 50 CHECK (
        one_to_one_confidence >= 0 AND one_to_one_confidence <= 100
    ),

    small_group TEXT NOT NULL DEFAULT 'neutral' CHECK (
        small_group IN ('comfortable', 'neutral', 'uncomfortable', 'unknown')
    ),
    small_group_confidence INT NOT NULL DEFAULT 50 CHECK (
        small_group_confidence >= 0 AND small_group_confidence <= 100
    ),

    large_group TEXT NOT NULL DEFAULT 'unknown' CHECK (
        large_group IN ('comfortable', 'neutral', 'uncomfortable', 'unknown')
    ),
    large_group_confidence INT NOT NULL DEFAULT 0 CHECK (
        large_group_confidence >= 0 AND large_group_confidence <= 100
    ),

    new_people TEXT NOT NULL DEFAULT 'unknown' CHECK (
        new_people IN ('comfortable', 'neutral', 'uncomfortable', 'unknown')
    ),
    new_people_confidence INT NOT NULL DEFAULT 0 CHECK (
        new_people_confidence >= 0 AND new_people_confidence <= 100
    ),

    -- Overall social energy (0-100)
    social_energy INT NOT NULL DEFAULT 50 CHECK (
        social_energy >= 0 AND social_energy <= 100
    ),

    -- Evidence that informed this profile (JSONB array)
    evidence JSONB NOT NULL DEFAULT '[]',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One profile per user
    CONSTRAINT unique_user_comfort_profile UNIQUE (tenant_id, user_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_social_comfort_profiles_tenant_user
    ON public.social_comfort_profiles (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_social_comfort_profiles_energy
    ON public.social_comfort_profiles (social_energy);

-- ===========================================================================
-- B. social_proximity_cache - Cached proximity scores for connections
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.social_proximity_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    node_id UUID NOT NULL REFERENCES public.relationship_nodes(id) ON DELETE CASCADE,

    -- Computed proximity score (0-100 raw, 0.0-1.0 normalized)
    raw_score INT NOT NULL CHECK (raw_score >= 0 AND raw_score <= 100),
    normalized_score NUMERIC(4,3) NOT NULL CHECK (normalized_score >= 0 AND normalized_score <= 1),

    -- Relationship tier classification
    tier TEXT NOT NULL CHECK (
        tier IN ('close', 'weak', 'community', 'professional')
    ),

    -- Factor breakdown for explainability
    factor_interaction_recency INT NOT NULL DEFAULT 0 CHECK (
        factor_interaction_recency >= 0 AND factor_interaction_recency <= 100
    ),
    factor_shared_interests INT NOT NULL DEFAULT 0 CHECK (
        factor_shared_interests >= 0 AND factor_shared_interests <= 100
    ),
    factor_physical_proximity INT CHECK (
        factor_physical_proximity IS NULL OR
        (factor_physical_proximity >= 0 AND factor_physical_proximity <= 100)
    ),
    factor_emotional_tone INT NOT NULL DEFAULT 50 CHECK (
        factor_emotional_tone >= 0 AND factor_emotional_tone <= 100
    ),
    factor_contextual_relevance INT NOT NULL DEFAULT 50 CHECK (
        factor_contextual_relevance >= 0 AND factor_contextual_relevance <= 100
    ),

    -- Context that was used for scoring
    context_domain TEXT,

    -- Cache management
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'),

    -- One cached score per user per node per domain
    CONSTRAINT unique_user_node_proximity UNIQUE (tenant_id, user_id, node_id, context_domain)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_social_proximity_cache_tenant_user
    ON public.social_proximity_cache (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_social_proximity_cache_node
    ON public.social_proximity_cache (node_id);

CREATE INDEX IF NOT EXISTS idx_social_proximity_cache_score
    ON public.social_proximity_cache (normalized_score DESC);

CREATE INDEX IF NOT EXISTS idx_social_proximity_cache_expires
    ON public.social_proximity_cache (expires_at);

CREATE INDEX IF NOT EXISTS idx_social_proximity_cache_tier
    ON public.social_proximity_cache (tier);

-- ===========================================================================
-- C. social_context_audit - Audit trail for D59 compliance
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.social_context_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Action type
    action TEXT NOT NULL CHECK (
        action IN (
            'comfort_profile_created',
            'comfort_profile_updated',
            'proximity_computed',
            'context_computed',
            'action_filtered',
            'boundary_respected'
        )
    ),

    -- Action details
    target_type TEXT,  -- 'comfort_profile', 'proximity_score', 'context_bundle', 'action'
    target_id UUID,
    old_value JSONB,
    new_value JSONB,

    -- Context
    session_id TEXT,
    domain TEXT,
    intent_type TEXT,

    -- Metadata
    metadata JSONB DEFAULT '{}',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for audit queries
CREATE INDEX IF NOT EXISTS idx_social_context_audit_tenant_user
    ON public.social_context_audit (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_social_context_audit_action
    ON public.social_context_audit (action);

CREATE INDEX IF NOT EXISTS idx_social_context_audit_created
    ON public.social_context_audit (created_at DESC);

-- ===========================================================================
-- D. RLS Policies
-- ===========================================================================

-- Enable RLS
ALTER TABLE public.social_comfort_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_proximity_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_context_audit ENABLE ROW LEVEL SECURITY;

-- social_comfort_profiles: user + tenant isolation
DROP POLICY IF EXISTS social_comfort_profiles_select ON public.social_comfort_profiles;
CREATE POLICY social_comfort_profiles_select ON public.social_comfort_profiles
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS social_comfort_profiles_insert ON public.social_comfort_profiles;
CREATE POLICY social_comfort_profiles_insert ON public.social_comfort_profiles
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS social_comfort_profiles_update ON public.social_comfort_profiles;
CREATE POLICY social_comfort_profiles_update ON public.social_comfort_profiles
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    )
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS social_comfort_profiles_delete ON public.social_comfort_profiles;
CREATE POLICY social_comfort_profiles_delete ON public.social_comfort_profiles
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- social_proximity_cache: user + tenant isolation
DROP POLICY IF EXISTS social_proximity_cache_select ON public.social_proximity_cache;
CREATE POLICY social_proximity_cache_select ON public.social_proximity_cache
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS social_proximity_cache_insert ON public.social_proximity_cache;
CREATE POLICY social_proximity_cache_insert ON public.social_proximity_cache
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS social_proximity_cache_update ON public.social_proximity_cache;
CREATE POLICY social_proximity_cache_update ON public.social_proximity_cache
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    )
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS social_proximity_cache_delete ON public.social_proximity_cache;
CREATE POLICY social_proximity_cache_delete ON public.social_proximity_cache
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- social_context_audit: user + tenant isolation (read-only for users)
DROP POLICY IF EXISTS social_context_audit_select ON public.social_context_audit;
CREATE POLICY social_context_audit_select ON public.social_context_audit
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- Only service role can insert audit entries
DROP POLICY IF EXISTS social_context_audit_insert ON public.social_context_audit;
CREATE POLICY social_context_audit_insert ON public.social_context_audit
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- ===========================================================================
-- E. RPC Functions
-- ===========================================================================

-- ===========================================================================
-- E.1 social_get_comfort_profile - Get or create user's comfort profile
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.social_get_comfort_profile()
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
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Get or create profile
    SELECT * INTO v_profile
    FROM public.social_comfort_profiles
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id;

    IF v_profile.id IS NULL THEN
        -- Create default profile
        INSERT INTO public.social_comfort_profiles (
            tenant_id,
            user_id
        ) VALUES (
            v_tenant_id,
            v_user_id
        )
        RETURNING * INTO v_profile;

        -- Audit
        INSERT INTO public.social_context_audit (
            tenant_id, user_id, action, target_type, target_id, new_value
        ) VALUES (
            v_tenant_id, v_user_id, 'comfort_profile_created', 'comfort_profile', v_profile.id,
            jsonb_build_object('default', true)
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'profile', jsonb_build_object(
            'id', v_profile.id,
            'one_to_one', v_profile.one_to_one,
            'one_to_one_confidence', v_profile.one_to_one_confidence,
            'small_group', v_profile.small_group,
            'small_group_confidence', v_profile.small_group_confidence,
            'large_group', v_profile.large_group,
            'large_group_confidence', v_profile.large_group_confidence,
            'new_people', v_profile.new_people,
            'new_people_confidence', v_profile.new_people_confidence,
            'social_energy', v_profile.social_energy,
            'evidence', v_profile.evidence,
            'updated_at', v_profile.updated_at
        )
    );
END;
$$;

-- ===========================================================================
-- E.2 social_update_comfort_profile - Update user's comfort profile
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.social_update_comfort_profile(
    p_field TEXT,
    p_value TEXT,  -- ComfortLevel or number as string
    p_source TEXT DEFAULT 'explicit'
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
    v_old_value JSONB;
    v_new_value JSONB;
    v_comfort_levels TEXT[] := ARRAY['comfortable', 'neutral', 'uncomfortable', 'unknown'];
    v_valid_sources TEXT[] := ARRAY['diary', 'explicit', 'behavioral', 'preference', 'inferred'];
    v_numeric_value INT;
    v_evidence_entry JSONB;
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Validate source
    IF NOT (p_source = ANY(v_valid_sources)) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_SOURCE',
            'message', 'source must be one of: diary, explicit, behavioral, preference, inferred'
        );
    END IF;

    -- Ensure profile exists
    INSERT INTO public.social_comfort_profiles (tenant_id, user_id)
    VALUES (v_tenant_id, v_user_id)
    ON CONFLICT (tenant_id, user_id) DO NOTHING;

    SELECT id INTO v_profile_id
    FROM public.social_comfort_profiles
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id;

    -- Build evidence entry
    v_evidence_entry := jsonb_build_object(
        'source', p_source,
        'signal', p_field || ':' || p_value,
        'weight', CASE
            WHEN p_source = 'explicit' THEN 1.0
            WHEN p_source = 'diary' THEN 0.9
            WHEN p_source = 'behavioral' THEN 0.7
            WHEN p_source = 'preference' THEN 0.8
            ELSE 0.5
        END,
        'timestamp', NOW()
    );

    -- Handle field-specific updates
    CASE p_field
        WHEN 'one_to_one' THEN
            IF NOT (p_value = ANY(v_comfort_levels)) THEN
                RETURN jsonb_build_object(
                    'ok', false,
                    'error', 'INVALID_VALUE',
                    'message', 'one_to_one must be: comfortable, neutral, uncomfortable, unknown'
                );
            END IF;

            SELECT jsonb_build_object('one_to_one', one_to_one, 'confidence', one_to_one_confidence)
            INTO v_old_value
            FROM public.social_comfort_profiles WHERE id = v_profile_id;

            UPDATE public.social_comfort_profiles
            SET
                one_to_one = p_value,
                one_to_one_confidence = LEAST(one_to_one_confidence + 10, 100),
                evidence = evidence || v_evidence_entry,
                updated_at = NOW()
            WHERE id = v_profile_id;

        WHEN 'small_group' THEN
            IF NOT (p_value = ANY(v_comfort_levels)) THEN
                RETURN jsonb_build_object(
                    'ok', false,
                    'error', 'INVALID_VALUE',
                    'message', 'small_group must be: comfortable, neutral, uncomfortable, unknown'
                );
            END IF;

            SELECT jsonb_build_object('small_group', small_group, 'confidence', small_group_confidence)
            INTO v_old_value
            FROM public.social_comfort_profiles WHERE id = v_profile_id;

            UPDATE public.social_comfort_profiles
            SET
                small_group = p_value,
                small_group_confidence = LEAST(small_group_confidence + 10, 100),
                evidence = evidence || v_evidence_entry,
                updated_at = NOW()
            WHERE id = v_profile_id;

        WHEN 'large_group' THEN
            IF NOT (p_value = ANY(v_comfort_levels)) THEN
                RETURN jsonb_build_object(
                    'ok', false,
                    'error', 'INVALID_VALUE',
                    'message', 'large_group must be: comfortable, neutral, uncomfortable, unknown'
                );
            END IF;

            SELECT jsonb_build_object('large_group', large_group, 'confidence', large_group_confidence)
            INTO v_old_value
            FROM public.social_comfort_profiles WHERE id = v_profile_id;

            UPDATE public.social_comfort_profiles
            SET
                large_group = p_value,
                large_group_confidence = LEAST(large_group_confidence + 10, 100),
                evidence = evidence || v_evidence_entry,
                updated_at = NOW()
            WHERE id = v_profile_id;

        WHEN 'new_people' THEN
            IF NOT (p_value = ANY(v_comfort_levels)) THEN
                RETURN jsonb_build_object(
                    'ok', false,
                    'error', 'INVALID_VALUE',
                    'message', 'new_people must be: comfortable, neutral, uncomfortable, unknown'
                );
            END IF;

            SELECT jsonb_build_object('new_people', new_people, 'confidence', new_people_confidence)
            INTO v_old_value
            FROM public.social_comfort_profiles WHERE id = v_profile_id;

            UPDATE public.social_comfort_profiles
            SET
                new_people = p_value,
                new_people_confidence = LEAST(new_people_confidence + 10, 100),
                evidence = evidence || v_evidence_entry,
                updated_at = NOW()
            WHERE id = v_profile_id;

        WHEN 'social_energy' THEN
            BEGIN
                v_numeric_value := p_value::INT;
            EXCEPTION WHEN OTHERS THEN
                RETURN jsonb_build_object(
                    'ok', false,
                    'error', 'INVALID_VALUE',
                    'message', 'social_energy must be a number between 0 and 100'
                );
            END;

            IF v_numeric_value < 0 OR v_numeric_value > 100 THEN
                RETURN jsonb_build_object(
                    'ok', false,
                    'error', 'INVALID_VALUE',
                    'message', 'social_energy must be between 0 and 100'
                );
            END IF;

            SELECT jsonb_build_object('social_energy', social_energy)
            INTO v_old_value
            FROM public.social_comfort_profiles WHERE id = v_profile_id;

            UPDATE public.social_comfort_profiles
            SET
                social_energy = v_numeric_value,
                evidence = evidence || v_evidence_entry,
                updated_at = NOW()
            WHERE id = v_profile_id;

        ELSE
            RETURN jsonb_build_object(
                'ok', false,
                'error', 'INVALID_FIELD',
                'message', 'field must be: one_to_one, small_group, large_group, new_people, or social_energy'
            );
    END CASE;

    -- Build new value for audit
    v_new_value := jsonb_build_object(p_field, p_value, 'source', p_source);

    -- Audit
    INSERT INTO public.social_context_audit (
        tenant_id, user_id, action, target_type, target_id, old_value, new_value
    ) VALUES (
        v_tenant_id, v_user_id, 'comfort_profile_updated', 'comfort_profile', v_profile_id,
        v_old_value, v_new_value
    );

    -- Return updated profile
    RETURN public.social_get_comfort_profile();
END;
$$;

-- ===========================================================================
-- E.3 social_compute_proximity - Compute proximity score for a connection
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.social_compute_proximity(
    p_node_id UUID,
    p_context_domain TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_node RECORD;
    v_edge RECORD;
    v_cached RECORD;
    v_tier TEXT;
    v_factor_recency INT := 0;
    v_factor_interests INT := 0;
    v_factor_proximity INT := NULL;
    v_factor_tone INT := 50;
    v_factor_relevance INT := 50;
    v_raw_score INT;
    v_normalized_score NUMERIC(4,3);
    v_days_since_interaction INT;
    v_cache_id UUID;
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Check node exists
    SELECT * INTO v_node
    FROM public.relationship_nodes
    WHERE id = p_node_id AND tenant_id = v_tenant_id;

    IF v_node.id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'NODE_NOT_FOUND',
            'message', 'Node not found or not accessible'
        );
    END IF;

    -- Check for valid cached score (not expired)
    SELECT * INTO v_cached
    FROM public.social_proximity_cache
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND node_id = p_node_id
      AND (context_domain = p_context_domain OR (context_domain IS NULL AND p_context_domain IS NULL))
      AND expires_at > NOW();

    IF v_cached.id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'ok', true,
            'cached', true,
            'score', jsonb_build_object(
                'node_id', p_node_id,
                'score', v_cached.normalized_score,
                'raw_score', v_cached.raw_score,
                'tier', v_cached.tier,
                'factors', jsonb_build_object(
                    'interaction_recency', v_cached.factor_interaction_recency,
                    'shared_interests', v_cached.factor_shared_interests,
                    'physical_proximity', v_cached.factor_physical_proximity,
                    'emotional_tone', v_cached.factor_emotional_tone,
                    'contextual_relevance', v_cached.factor_contextual_relevance
                ),
                'computed_at', v_cached.computed_at,
                'ttl_seconds', EXTRACT(EPOCH FROM (v_cached.expires_at - NOW()))::INT
            )
        );
    END IF;

    -- Get strongest edge to this node
    SELECT * INTO v_edge
    FROM public.relationship_edges
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND (from_node_id = p_node_id OR to_node_id = p_node_id)
    ORDER BY strength DESC, last_seen DESC
    LIMIT 1;

    -- Calculate interaction recency factor
    IF v_edge.id IS NOT NULL THEN
        v_days_since_interaction := EXTRACT(DAY FROM (CURRENT_DATE - v_edge.last_seen));
        -- Decay: 100 at 0 days, ~50 at 7 days, ~10 at 30 days
        v_factor_recency := GREATEST(0, 100 - (v_days_since_interaction * 3));

        -- Determine tier based on relationship type and strength
        IF v_edge.relationship_type = 'friend' AND v_edge.strength >= 60 THEN
            v_tier := 'close';
        ELSIF v_edge.relationship_type IN ('member', 'attendee') THEN
            v_tier := 'community';
        ELSIF v_edge.relationship_type IN ('using', 'following') THEN
            v_tier := 'professional';
        ELSE
            v_tier := 'weak';
        END IF;
    ELSE
        -- No direct edge - weak tie at best
        v_factor_recency := 10;
        v_tier := 'weak';
    END IF;

    -- Shared interests factor (based on node domain matching context)
    IF p_context_domain IS NOT NULL AND v_node.domain = p_context_domain THEN
        v_factor_interests := 80;
    ELSIF p_context_domain IS NOT NULL THEN
        v_factor_interests := 30;
    ELSE
        v_factor_interests := 50;
    END IF;

    -- Emotional tone factor (based on edge context if available)
    IF v_edge.context IS NOT NULL AND v_edge.context ? 'emotional_tone' THEN
        v_factor_tone := COALESCE((v_edge.context->>'emotional_tone')::INT, 50);
    ELSE
        -- Default to slightly positive for existing connections
        v_factor_tone := CASE WHEN v_edge.id IS NOT NULL THEN 60 ELSE 50 END;
    END IF;

    -- Contextual relevance (domain matching + strength)
    v_factor_relevance := CASE
        WHEN p_context_domain IS NOT NULL AND v_node.domain = p_context_domain THEN
            70 + COALESCE(v_edge.strength, 0) / 5
        WHEN p_context_domain IS NULL THEN
            50 + COALESCE(v_edge.strength, 0) / 5
        ELSE
            30 + COALESCE(v_edge.strength, 0) / 5
    END;
    v_factor_relevance := LEAST(100, v_factor_relevance);

    -- Calculate raw score (weighted average)
    -- Weights: recency=0.30, interests=0.25, proximity=0.10, tone=0.15, relevance=0.20
    IF v_factor_proximity IS NOT NULL THEN
        v_raw_score := (
            v_factor_recency * 30 +
            v_factor_interests * 25 +
            v_factor_proximity * 10 +
            v_factor_tone * 15 +
            v_factor_relevance * 20
        ) / 100;
    ELSE
        -- Redistribute proximity weight
        v_raw_score := (
            v_factor_recency * 33 +
            v_factor_interests * 28 +
            v_factor_tone * 17 +
            v_factor_relevance * 22
        ) / 100;
    END IF;

    v_normalized_score := v_raw_score::NUMERIC / 100.0;

    -- Cache the result (upsert)
    INSERT INTO public.social_proximity_cache (
        tenant_id, user_id, node_id,
        raw_score, normalized_score, tier,
        factor_interaction_recency, factor_shared_interests,
        factor_physical_proximity, factor_emotional_tone,
        factor_contextual_relevance, context_domain,
        computed_at, expires_at
    ) VALUES (
        v_tenant_id, v_user_id, p_node_id,
        v_raw_score, v_normalized_score, v_tier,
        v_factor_recency, v_factor_interests,
        v_factor_proximity, v_factor_tone,
        v_factor_relevance, p_context_domain,
        NOW(), NOW() + INTERVAL '1 hour'
    )
    ON CONFLICT (tenant_id, user_id, node_id, context_domain) DO UPDATE SET
        raw_score = EXCLUDED.raw_score,
        normalized_score = EXCLUDED.normalized_score,
        tier = EXCLUDED.tier,
        factor_interaction_recency = EXCLUDED.factor_interaction_recency,
        factor_shared_interests = EXCLUDED.factor_shared_interests,
        factor_physical_proximity = EXCLUDED.factor_physical_proximity,
        factor_emotional_tone = EXCLUDED.factor_emotional_tone,
        factor_contextual_relevance = EXCLUDED.factor_contextual_relevance,
        computed_at = NOW(),
        expires_at = NOW() + INTERVAL '1 hour'
    RETURNING id INTO v_cache_id;

    -- Audit
    INSERT INTO public.social_context_audit (
        tenant_id, user_id, action, target_type, target_id,
        domain, new_value
    ) VALUES (
        v_tenant_id, v_user_id, 'proximity_computed', 'proximity_score', v_cache_id,
        p_context_domain,
        jsonb_build_object('node_id', p_node_id, 'score', v_normalized_score, 'tier', v_tier)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'cached', false,
        'score', jsonb_build_object(
            'node_id', p_node_id,
            'score', v_normalized_score,
            'raw_score', v_raw_score,
            'tier', v_tier,
            'factors', jsonb_build_object(
                'interaction_recency', v_factor_recency,
                'shared_interests', v_factor_interests,
                'physical_proximity', v_factor_proximity,
                'emotional_tone', v_factor_tone,
                'contextual_relevance', v_factor_relevance
            ),
            'computed_at', NOW(),
            'ttl_seconds', 3600
        )
    );
END;
$$;

-- ===========================================================================
-- E.4 social_get_relevant_connections - Get top relevant connections
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.social_get_relevant_connections(
    p_context_domain TEXT DEFAULT NULL,
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
    v_connections JSONB;
    v_node_ids UUID[];
    v_node_id UUID;
    v_result JSONB;
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Cap limit
    p_limit := LEAST(GREATEST(p_limit, 1), 50);

    -- Get distinct connected node IDs (prioritize recent, strong connections)
    SELECT ARRAY_AGG(DISTINCT node_id)
    INTO v_node_ids
    FROM (
        SELECT
            CASE
                WHEN e.from_node_id IN (SELECT id FROM public.relationship_nodes WHERE node_type = 'person')
                     AND e.from_node_id != (SELECT id FROM public.relationship_nodes WHERE ref_id = v_user_id LIMIT 1)
                THEN e.from_node_id
                ELSE e.to_node_id
            END as node_id
        FROM public.relationship_edges e
        WHERE e.tenant_id = v_tenant_id
          AND e.user_id = v_user_id
          AND e.strength >= 10
        ORDER BY e.strength DESC, e.last_seen DESC
        LIMIT p_limit * 2  -- Get more than needed for filtering
    ) sub;

    -- Compute proximity for each connection
    v_connections := '[]'::JSONB;

    IF v_node_ids IS NOT NULL THEN
        FOREACH v_node_id IN ARRAY v_node_ids[1:p_limit]
        LOOP
            v_result := public.social_compute_proximity(v_node_id, p_context_domain);
            IF (v_result->>'ok')::BOOLEAN THEN
                v_connections := v_connections || jsonb_build_array(v_result->'score');
            END IF;
        END LOOP;
    END IF;

    -- Sort by score descending
    SELECT COALESCE(
        jsonb_agg(elem ORDER BY (elem->>'score')::NUMERIC DESC),
        '[]'::JSONB
    )
    INTO v_connections
    FROM jsonb_array_elements(v_connections) elem;

    RETURN jsonb_build_object(
        'ok', true,
        'connections', v_connections,
        'count', jsonb_array_length(v_connections),
        'context_domain', p_context_domain
    );
END;
$$;

-- ===========================================================================
-- E.5 social_compute_context - Compute full social context bundle
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.social_compute_context(
    p_domain TEXT DEFAULT NULL,
    p_intent_type TEXT DEFAULT NULL,
    p_emotional_state TEXT DEFAULT NULL,
    p_social_intent BOOLEAN DEFAULT false,
    p_max_connections INT DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_profile_result JSONB;
    v_profile JSONB;
    v_connections_result JSONB;
    v_connections JSONB;
    v_active_set JSONB;
    v_context_tags JSONB;
    v_bundle_id TEXT;
    v_social_energy INT;
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Get comfort profile
    v_profile_result := public.social_get_comfort_profile();
    IF NOT (v_profile_result->>'ok')::BOOLEAN THEN
        RETURN v_profile_result;
    END IF;
    v_profile := v_profile_result->'profile';
    v_social_energy := (v_profile->>'social_energy')::INT;

    -- Get relevant connections
    v_connections_result := public.social_get_relevant_connections(p_domain, p_max_connections);
    IF (v_connections_result->>'ok')::BOOLEAN THEN
        v_connections := v_connections_result->'connections';
    ELSE
        v_connections := '[]'::JSONB;
    END IF;

    -- Determine active relationship set based on context
    v_active_set := jsonb_build_object(
        'close', true,
        'weak', true,
        'community', true,
        'professional', true,
        'primary_tier', NULL,
        'activation_reason', 'default_neutral'
    );

    -- Adjust based on domain
    IF p_domain = 'health' THEN
        v_active_set := jsonb_set(v_active_set, '{primary_tier}', '"close"');
        v_active_set := jsonb_set(v_active_set, '{activation_reason}', '"health_domain_close_priority"');
    ELSIF p_domain = 'business' THEN
        v_active_set := jsonb_set(v_active_set, '{primary_tier}', '"professional"');
        v_active_set := jsonb_set(v_active_set, '{activation_reason}', '"business_domain_professional_priority"');
    ELSIF p_domain = 'relationships' OR p_social_intent THEN
        v_active_set := jsonb_set(v_active_set, '{primary_tier}', '"community"');
        v_active_set := jsonb_set(v_active_set, '{activation_reason}', '"social_intent_community_priority"');
    END IF;

    -- Derive context tags based on comfort profile
    v_context_tags := '[]'::JSONB;

    -- Energy-based tags
    IF v_social_energy < 30 THEN
        v_context_tags := v_context_tags || '["low_energy_mode", "small_group_only", "prefer_known_people"]'::JSONB;
    ELSIF v_social_energy >= 70 THEN
        v_context_tags := v_context_tags || '["high_energy_mode", "social_expansion_ok"]'::JSONB;
    END IF;

    -- Comfort-based tags
    IF v_profile->>'one_to_one' = 'comfortable' AND (v_profile->>'one_to_one_confidence')::INT >= 60 THEN
        v_context_tags := v_context_tags || '["one_on_one_preferred"]'::JSONB;
    END IF;

    IF v_profile->>'large_group' = 'comfortable' AND (v_profile->>'large_group_confidence')::INT >= 60 THEN
        v_context_tags := v_context_tags || '["large_group_ok"]'::JSONB;
    END IF;

    IF v_profile->>'large_group' = 'uncomfortable' AND (v_profile->>'large_group_confidence')::INT >= 50 THEN
        v_context_tags := v_context_tags || '["small_group_only"]'::JSONB;
    END IF;

    IF v_profile->>'new_people' = 'uncomfortable' AND (v_profile->>'new_people_confidence')::INT >= 50 THEN
        v_context_tags := v_context_tags || '["avoid_new_connections", "prefer_known_people"]'::JSONB;
    ELSIF v_profile->>'new_people' = 'comfortable' AND (v_profile->>'new_people_confidence')::INT >= 60 THEN
        v_context_tags := v_context_tags || '["social_expansion_ok"]'::JSONB;
    END IF;

    -- Deduplicate tags
    SELECT COALESCE(jsonb_agg(DISTINCT elem), '[]'::JSONB)
    INTO v_context_tags
    FROM jsonb_array_elements_text(v_context_tags) elem;

    -- Generate bundle ID
    v_bundle_id := 'd35_' || gen_random_uuid()::TEXT;

    -- Audit
    INSERT INTO public.social_context_audit (
        tenant_id, user_id, action, target_type,
        domain, intent_type, new_value
    ) VALUES (
        v_tenant_id, v_user_id, 'context_computed', 'context_bundle',
        p_domain, p_intent_type,
        jsonb_build_object(
            'bundle_id', v_bundle_id,
            'tags_count', jsonb_array_length(v_context_tags),
            'connections_count', jsonb_array_length(v_connections)
        )
    );

    RETURN jsonb_build_object(
        'ok', true,
        'bundle', jsonb_build_object(
            'active_relationship_set', v_active_set,
            'comfort_profile', v_profile,
            'relevant_connections', v_connections,
            'context_tags', v_context_tags,
            'weighted_actions', '[]'::JSONB,  -- Actions computed by gateway
            'metadata', jsonb_build_object(
                'bundle_id', v_bundle_id,
                'computed_at', NOW(),
                'input_hash', md5(COALESCE(p_domain, '') || COALESCE(p_intent_type, '') || v_social_energy::TEXT),
                'version', '1.0.0'
            )
        )
    );
END;
$$;

-- ===========================================================================
-- E.6 social_invalidate_cache - Invalidate proximity cache for user
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.social_invalidate_cache(
    p_node_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_deleted_count INT;
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Delete cache entries
    IF p_node_id IS NOT NULL THEN
        DELETE FROM public.social_proximity_cache
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND node_id = p_node_id;
    ELSE
        DELETE FROM public.social_proximity_cache
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id;
    END IF;

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', true,
        'deleted_count', v_deleted_count,
        'node_id', p_node_id
    );
END;
$$;

-- ===========================================================================
-- F. Cleanup Job (for expired cache entries)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.social_cleanup_expired_cache()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_deleted INT;
BEGIN
    DELETE FROM public.social_proximity_cache
    WHERE expires_at < NOW();

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

-- ===========================================================================
-- G. Permissions
-- ===========================================================================

-- RPC functions: callable by authenticated users
GRANT EXECUTE ON FUNCTION public.social_get_comfort_profile() TO authenticated;
GRANT EXECUTE ON FUNCTION public.social_update_comfort_profile(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.social_compute_proximity(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.social_get_relevant_connections(TEXT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.social_compute_context(TEXT, TEXT, TEXT, BOOLEAN, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.social_invalidate_cache(UUID) TO authenticated;

-- Cleanup function: service role only
GRANT EXECUTE ON FUNCTION public.social_cleanup_expired_cache() TO service_role;

-- Tables: authenticated users with RLS
GRANT SELECT, INSERT, UPDATE, DELETE ON public.social_comfort_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.social_proximity_cache TO authenticated;
GRANT SELECT, INSERT ON public.social_context_audit TO authenticated;

-- Service role: full access
GRANT ALL ON public.social_comfort_profiles TO service_role;
GRANT ALL ON public.social_proximity_cache TO service_role;
GRANT ALL ON public.social_context_audit TO service_role;

-- ===========================================================================
-- H. Comments
-- ===========================================================================

COMMENT ON TABLE public.social_comfort_profiles IS 'VTID-01129 D35: User social comfort profiles - preferences for social interaction types';
COMMENT ON TABLE public.social_proximity_cache IS 'VTID-01129 D35: Cached social proximity scores for user connections';
COMMENT ON TABLE public.social_context_audit IS 'VTID-01129 D35: Audit trail for social context computations (D59 compliance)';

COMMENT ON FUNCTION public.social_get_comfort_profile IS 'VTID-01129 D35: Get or create user social comfort profile';
COMMENT ON FUNCTION public.social_update_comfort_profile IS 'VTID-01129 D35: Update user social comfort profile field';
COMMENT ON FUNCTION public.social_compute_proximity IS 'VTID-01129 D35: Compute social proximity score for a connection';
COMMENT ON FUNCTION public.social_get_relevant_connections IS 'VTID-01129 D35: Get top relevant connections with proximity scores';
COMMENT ON FUNCTION public.social_compute_context IS 'VTID-01129 D35: Compute full social context bundle for a request';
COMMENT ON FUNCTION public.social_invalidate_cache IS 'VTID-01129 D35: Invalidate proximity cache for user';
COMMENT ON FUNCTION public.social_cleanup_expired_cache IS 'VTID-01129 D35: Cleanup expired cache entries (service role only)';
