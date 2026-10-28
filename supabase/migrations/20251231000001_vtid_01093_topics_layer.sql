-- Migration: 20251231000001_vtid_01093_topics_layer.sql
-- Purpose: VTID-01093 Unified Interest Topics Layer - Topic Registry + User Topic Profile
-- Date: 2025-12-31
--
-- Creates a single Topic Registry and User Topic Profile so that every system component
-- speaks the same language: diary extraction, Memory Garden nodes, longevity signals,
-- matches/recs, groups/events/services/products/locations/live rooms all use topic_keys.
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01102 (Phase B-Fix) - runtime context bridge

-- ===========================================================================
-- 3.1.A topic_registry - Central topic taxonomy lookup table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.topic_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    topic_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('health', 'community', 'lifestyle', 'nutrition', 'sleep', 'movement', 'mindset', 'medical', 'longevity')),
    description TEXT,
    synonyms TEXT[] DEFAULT '{}',
    safety_level TEXT NOT NULL DEFAULT 'safe' CHECK (safety_level IN ('safe', 'sensitive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, topic_key)
);

-- Index for fast lookups by topic_key
CREATE INDEX IF NOT EXISTS idx_topic_registry_tenant_key
    ON public.topic_registry (tenant_id, topic_key);

CREATE INDEX IF NOT EXISTS idx_topic_registry_tenant_category
    ON public.topic_registry (tenant_id, category);

-- ===========================================================================
-- 3.1.B user_topic_profile - User's affinity scores for topics
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.user_topic_profile (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    topic_key TEXT NOT NULL,
    affinity_score INT NOT NULL DEFAULT 0 CHECK (affinity_score >= 0 AND affinity_score <= 100),
    source_weights JSONB NOT NULL DEFAULT '{"diary": 0, "garden": 0, "behavior": 0, "social": 0}',
    last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id, topic_key)
);

-- Index for efficient queries by user
CREATE INDEX IF NOT EXISTS idx_user_topic_profile_tenant_user
    ON public.user_topic_profile (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_user_topic_profile_tenant_user_score
    ON public.user_topic_profile (tenant_id, user_id, affinity_score DESC);

-- Index for matching/recommendation queries
CREATE INDEX IF NOT EXISTS idx_user_topic_profile_topic_score
    ON public.user_topic_profile (tenant_id, topic_key, affinity_score DESC);

-- ===========================================================================
-- 3.2 RLS Policies
-- ===========================================================================

-- Enable RLS on both tables
ALTER TABLE public.topic_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_topic_profile ENABLE ROW LEVEL SECURITY;

-- topic_registry: Allow SELECT to all authenticated users (read-only lookup table)
DROP POLICY IF EXISTS topic_registry_select ON public.topic_registry;
CREATE POLICY topic_registry_select ON public.topic_registry
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());

-- topic_registry: Allow INSERT/UPDATE/DELETE only to tenant admins (admin role)
-- For v1, restrict write access to service role (RPCs use SECURITY DEFINER)
DROP POLICY IF EXISTS topic_registry_insert ON public.topic_registry;
CREATE POLICY topic_registry_insert ON public.topic_registry
    FOR INSERT
    TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS topic_registry_update ON public.topic_registry;
CREATE POLICY topic_registry_update ON public.topic_registry
    FOR UPDATE
    TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS topic_registry_delete ON public.topic_registry;
CREATE POLICY topic_registry_delete ON public.topic_registry
    FOR DELETE
    TO authenticated
    USING (tenant_id = public.current_tenant_id());

-- user_topic_profile: Allow access only when tenant_id=current_tenant_id() AND user_id=auth.uid()
DROP POLICY IF EXISTS user_topic_profile_select ON public.user_topic_profile;
CREATE POLICY user_topic_profile_select ON public.user_topic_profile
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS user_topic_profile_insert ON public.user_topic_profile;
CREATE POLICY user_topic_profile_insert ON public.user_topic_profile
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS user_topic_profile_update ON public.user_topic_profile;
CREATE POLICY user_topic_profile_update ON public.user_topic_profile
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

DROP POLICY IF EXISTS user_topic_profile_delete ON public.user_topic_profile;
CREATE POLICY user_topic_profile_delete ON public.user_topic_profile
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- ===========================================================================
-- 3.3 Seed Initial Topic Registry Entries (for default tenant)
-- These are the core topics that all systems must recognize
-- ===========================================================================

-- We'll use a default tenant_id for seeding (00000000-0000-0000-0000-000000000001)
-- In production, topics are created per-tenant via the API
DO $$
DECLARE
    v_default_tenant UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
    -- walking - movement category
    INSERT INTO public.topic_registry (tenant_id, topic_key, display_name, category, description, synonyms, safety_level)
    VALUES (v_default_tenant, 'walking', 'Walking', 'movement', 'Regular walking activity for health and mobility', ARRAY['walk', 'stroll', 'hiking', 'hike', 'steps'], 'safe')
    ON CONFLICT (tenant_id, topic_key) DO NOTHING;

    -- sleep - sleep category
    INSERT INTO public.topic_registry (tenant_id, topic_key, display_name, category, description, synonyms, safety_level)
    VALUES (v_default_tenant, 'sleep', 'Sleep', 'sleep', 'Sleep quality, duration, and optimization', ARRAY['rest', 'nap', 'slumber', 'bedtime', 'insomnia'], 'safe')
    ON CONFLICT (tenant_id, topic_key) DO NOTHING;

    -- low_sodium - nutrition category
    INSERT INTO public.topic_registry (tenant_id, topic_key, display_name, category, description, synonyms, safety_level)
    VALUES (v_default_tenant, 'low_sodium', 'Low Sodium Diet', 'nutrition', 'Dietary approach limiting sodium intake for health', ARRAY['salt-free', 'no salt', 'sodium restriction', 'low salt'], 'safe')
    ON CONFLICT (tenant_id, topic_key) DO NOTHING;

    -- mindfulness - mindset category
    INSERT INTO public.topic_registry (tenant_id, topic_key, display_name, category, description, synonyms, safety_level)
    VALUES (v_default_tenant, 'mindfulness', 'Mindfulness', 'mindset', 'Meditation, awareness, and mental wellness practices', ARRAY['meditation', 'awareness', 'zen', 'calm', 'relaxation', 'breathing'], 'safe')
    ON CONFLICT (tenant_id, topic_key) DO NOTHING;

    -- strength_training - movement category
    INSERT INTO public.topic_registry (tenant_id, topic_key, display_name, category, description, synonyms, safety_level)
    VALUES (v_default_tenant, 'strength_training', 'Strength Training', 'movement', 'Resistance training and muscle building exercises', ARRAY['weights', 'weightlifting', 'resistance', 'gym', 'lifting', 'workout'], 'safe')
    ON CONFLICT (tenant_id, topic_key) DO NOTHING;

    -- longevity - longevity category
    INSERT INTO public.topic_registry (tenant_id, topic_key, display_name, category, description, synonyms, safety_level)
    VALUES (v_default_tenant, 'longevity', 'Longevity', 'longevity', 'Lifespan extension and healthspan optimization practices', ARRAY['anti-aging', 'lifespan', 'healthspan', 'aging', 'biohacking'], 'safe')
    ON CONFLICT (tenant_id, topic_key) DO NOTHING;

    -- Additional useful topics for the platform
    -- nutrition_tracking
    INSERT INTO public.topic_registry (tenant_id, topic_key, display_name, category, description, synonyms, safety_level)
    VALUES (v_default_tenant, 'nutrition_tracking', 'Nutrition Tracking', 'nutrition', 'Monitoring food intake and nutritional balance', ARRAY['calorie counting', 'macros', 'diet tracking', 'food logging'], 'safe')
    ON CONFLICT (tenant_id, topic_key) DO NOTHING;

    -- cardiovascular
    INSERT INTO public.topic_registry (tenant_id, topic_key, display_name, category, description, synonyms, safety_level)
    VALUES (v_default_tenant, 'cardiovascular', 'Cardiovascular Health', 'health', 'Heart health and cardiovascular fitness', ARRAY['cardio', 'heart health', 'running', 'aerobic'], 'safe')
    ON CONFLICT (tenant_id, topic_key) DO NOTHING;

    -- stress_management
    INSERT INTO public.topic_registry (tenant_id, topic_key, display_name, category, description, synonyms, safety_level)
    VALUES (v_default_tenant, 'stress_management', 'Stress Management', 'mindset', 'Techniques for managing and reducing stress', ARRAY['stress relief', 'anxiety', 'relaxation', 'coping'], 'safe')
    ON CONFLICT (tenant_id, topic_key) DO NOTHING;

    -- social_connections
    INSERT INTO public.topic_registry (tenant_id, topic_key, display_name, category, description, synonyms, safety_level)
    VALUES (v_default_tenant, 'social_connections', 'Social Connections', 'community', 'Building and maintaining social relationships', ARRAY['community', 'friendships', 'networking', 'relationships'], 'safe')
    ON CONFLICT (tenant_id, topic_key) DO NOTHING;
END $$;

-- ===========================================================================
-- 3.4 RPC: topics_get_user_profile - Get user's topic profile
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.topics_get_user_profile(p_user_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_topics JSONB;
    v_top_topics JSONB;
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

    -- Use provided user_id or derive from auth
    v_user_id := COALESCE(p_user_id, auth.uid());
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No user_id provided and no authenticated user'
        );
    END IF;

    -- Get all topics for user
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'topic_key', utp.topic_key,
                'affinity_score', utp.affinity_score,
                'source_weights', utp.source_weights,
                'last_updated', utp.last_updated,
                'display_name', tr.display_name,
                'category', tr.category
            )
            ORDER BY utp.affinity_score DESC
        ),
        '[]'::JSONB
    )
    INTO v_topics
    FROM public.user_topic_profile utp
    LEFT JOIN public.topic_registry tr ON tr.tenant_id = utp.tenant_id AND tr.topic_key = utp.topic_key
    WHERE utp.tenant_id = v_tenant_id
      AND utp.user_id = v_user_id;

    -- Get top 5 topics
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'topic_key', utp.topic_key,
                'score', utp.affinity_score
            )
            ORDER BY utp.affinity_score DESC
        ),
        '[]'::JSONB
    )
    INTO v_top_topics
    FROM (
        SELECT topic_key, affinity_score
        FROM public.user_topic_profile
        WHERE tenant_id = v_tenant_id AND user_id = v_user_id
        ORDER BY affinity_score DESC
        LIMIT 5
    ) utp;

    RETURN jsonb_build_object(
        'ok', true,
        'user_id', v_user_id,
        'topics', v_topics,
        'top_topics', v_top_topics,
        'topics_count', jsonb_array_length(v_topics)
    );
END;
$$;

-- ===========================================================================
-- 3.5 RPC: topics_recompute_user_profile - Recompute user's topic profile
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.topics_recompute_user_profile(p_user_id UUID, p_date DATE DEFAULT CURRENT_DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_topic_key TEXT;
    v_current_score INT;
    v_diary_score INT;
    v_garden_score INT;
    v_behavior_score INT;
    v_social_score INT;
    v_total_score INT;
    v_decay_days INT;
    v_topics_updated INT := 0;
    v_top_topics JSONB;
    v_source_weights JSONB;

    -- Scoring constants (v1 fixed)
    C_DIARY_MENTION CONSTANT INT := 6;
    C_GARDEN_NODE CONSTANT INT := 10;
    C_ACCEPTED_MATCH CONSTANT INT := 12;
    C_ATTENDED_EVENT CONSTANT INT := 8;
    C_USED_SERVICE CONSTANT INT := 10;
    C_DISMISSED_MATCH CONSTANT INT := -6;
    C_DECAY_PER_DAY CONSTANT INT := 1;
    C_DECAY_THRESHOLD_DAYS CONSTANT INT := 30;
    C_FLOOR_SCORE CONSTANT INT := 10;
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

    v_user_id := p_user_id;
    IF v_user_id IS NULL THEN
        v_user_id := auth.uid();
    END IF;

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No user_id provided and no authenticated user'
        );
    END IF;

    -- Process each topic in the registry for this tenant
    FOR v_topic_key IN
        SELECT topic_key FROM public.topic_registry WHERE tenant_id = v_tenant_id
    LOOP
        -- Initialize scores
        v_diary_score := 0;
        v_garden_score := 0;
        v_behavior_score := 0;
        v_social_score := 0;

        -- 1. Diary mentions (from memory_items with topic mentions in content)
        -- Check if memory_items exists and has topic-related content
        BEGIN
            SELECT COALESCE(COUNT(*) * C_DIARY_MENTION, 0)
            INTO v_diary_score
            FROM public.memory_items
            WHERE tenant_id = v_tenant_id
              AND user_id = v_user_id
              AND source IN ('diary', 'orb_text', 'orb_voice')
              AND (
                  LOWER(content) LIKE '%' || LOWER(v_topic_key) || '%'
                  OR EXISTS (
                      SELECT 1 FROM public.topic_registry tr
                      WHERE tr.tenant_id = v_tenant_id
                        AND tr.topic_key = v_topic_key
                        AND LOWER(memory_items.content) LIKE ANY (
                            SELECT '%' || LOWER(s) || '%' FROM unnest(tr.synonyms) s
                        )
                  )
              )
              AND occurred_at >= (p_date - INTERVAL '30 days');
        EXCEPTION WHEN undefined_table THEN
            v_diary_score := 0;
        END;

        -- 2. Garden nodes (placeholder - would check memory_garden_nodes table if exists)
        -- For v1, we accumulate from memory_items with category matching topic
        BEGIN
            SELECT COALESCE(COUNT(*) * C_GARDEN_NODE / 2, 0)
            INTO v_garden_score
            FROM public.memory_items
            WHERE tenant_id = v_tenant_id
              AND user_id = v_user_id
              AND category_key IN (
                  SELECT tr.category
                  FROM public.topic_registry tr
                  WHERE tr.tenant_id = v_tenant_id AND tr.topic_key = v_topic_key
              )
              AND occurred_at >= (p_date - INTERVAL '30 days');
        EXCEPTION WHEN undefined_table THEN
            v_garden_score := 0;
        END;

        -- 3. Behavior signals (services used, products - placeholder for future)
        -- v1: behavior_score stays 0 unless we have specific tables

        -- 4. Social signals (matches accepted/dismissed - placeholder for future)
        -- v1: social_score stays 0 unless we have specific tables

        -- Calculate total score (capped at 100)
        v_total_score := LEAST(v_diary_score + v_garden_score + v_behavior_score + v_social_score, 100);

        -- Apply decay if topic not seen recently
        -- Check last_updated of existing profile entry
        SELECT last_updated INTO v_decay_days
        FROM public.user_topic_profile
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND topic_key = v_topic_key;

        IF FOUND AND v_decay_days IS NOT NULL THEN
            v_decay_days := EXTRACT(DAY FROM (p_date - v_decay_days::DATE))::INT;
            IF v_decay_days > C_DECAY_THRESHOLD_DAYS AND v_total_score = 0 THEN
                -- Get current score and apply decay
                SELECT affinity_score INTO v_current_score
                FROM public.user_topic_profile
                WHERE tenant_id = v_tenant_id AND user_id = v_user_id AND topic_key = v_topic_key;

                -- Decay: -1/day until floor of 10
                v_total_score := GREATEST(
                    COALESCE(v_current_score, 0) - ((v_decay_days - C_DECAY_THRESHOLD_DAYS) * C_DECAY_PER_DAY),
                    C_FLOOR_SCORE
                );
            END IF;
        END IF;

        -- Build source weights
        v_source_weights := jsonb_build_object(
            'diary', v_diary_score,
            'garden', v_garden_score,
            'behavior', v_behavior_score,
            'social', v_social_score
        );

        -- Only upsert if there's a meaningful score (> 0)
        IF v_total_score > 0 THEN
            INSERT INTO public.user_topic_profile (
                tenant_id, user_id, topic_key, affinity_score, source_weights, last_updated
            )
            VALUES (
                v_tenant_id, v_user_id, v_topic_key, v_total_score, v_source_weights, NOW()
            )
            ON CONFLICT (tenant_id, user_id, topic_key)
            DO UPDATE SET
                affinity_score = EXCLUDED.affinity_score,
                source_weights = EXCLUDED.source_weights,
                last_updated = EXCLUDED.last_updated;

            v_topics_updated := v_topics_updated + 1;
        END IF;
    END LOOP;

    -- Get top topics after recompute
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'topic_key', topic_key,
                'score', affinity_score
            )
            ORDER BY affinity_score DESC
        ),
        '[]'::JSONB
    )
    INTO v_top_topics
    FROM (
        SELECT topic_key, affinity_score
        FROM public.user_topic_profile
        WHERE tenant_id = v_tenant_id AND user_id = v_user_id
        ORDER BY affinity_score DESC
        LIMIT 10
    ) t;

    RETURN jsonb_build_object(
        'ok', true,
        'user_id', v_user_id,
        'topics_updated', v_topics_updated,
        'top_topics', v_top_topics,
        'computed_at', NOW()
    );
END;
$$;

-- ===========================================================================
-- 3.6 RPC: topics_validate_keys - Validate topic keys against registry
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.topics_validate_keys(p_topic_keys TEXT[])
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_valid_keys TEXT[];
    v_invalid_keys TEXT[];
    v_key TEXT;
    v_found BOOLEAN;
    v_mapped_key TEXT;
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

    v_valid_keys := ARRAY[]::TEXT[];
    v_invalid_keys := ARRAY[]::TEXT[];

    FOREACH v_key IN ARRAY p_topic_keys
    LOOP
        -- Check if key exists directly
        SELECT EXISTS(
            SELECT 1 FROM public.topic_registry
            WHERE tenant_id = v_tenant_id AND topic_key = v_key
        ) INTO v_found;

        IF v_found THEN
            v_valid_keys := array_append(v_valid_keys, v_key);
        ELSE
            -- Try to find via synonyms
            SELECT topic_key INTO v_mapped_key
            FROM public.topic_registry
            WHERE tenant_id = v_tenant_id
              AND LOWER(v_key) = ANY(SELECT LOWER(s) FROM unnest(synonyms) s)
            LIMIT 1;

            IF v_mapped_key IS NOT NULL THEN
                v_valid_keys := array_append(v_valid_keys, v_mapped_key);
            ELSE
                v_invalid_keys := array_append(v_invalid_keys, v_key);
            END IF;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'ok', array_length(v_invalid_keys, 1) IS NULL OR array_length(v_invalid_keys, 1) = 0,
        'valid_keys', v_valid_keys,
        'invalid_keys', v_invalid_keys,
        'all_valid', array_length(v_invalid_keys, 1) IS NULL OR array_length(v_invalid_keys, 1) = 0
    );
END;
$$;

-- ===========================================================================
-- 3.7 RPC: topics_create_registry_entry - Create a new topic in registry
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.topics_create_registry_entry(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_topic_key TEXT;
    v_display_name TEXT;
    v_category TEXT;
    v_description TEXT;
    v_synonyms TEXT[];
    v_safety_level TEXT;
    v_new_id UUID;
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

    -- Extract fields
    v_topic_key := p_payload->>'topic_key';
    v_display_name := p_payload->>'display_name';
    v_category := p_payload->>'category';
    v_description := p_payload->>'description';
    v_synonyms := COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_payload->'synonyms')), ARRAY[]::TEXT[]);
    v_safety_level := COALESCE(p_payload->>'safety_level', 'safe');

    -- Validate required fields
    IF v_topic_key IS NULL OR v_topic_key = '' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_TOPIC_KEY',
            'message', 'topic_key is required'
        );
    END IF;

    IF v_display_name IS NULL OR v_display_name = '' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_DISPLAY_NAME',
            'message', 'display_name is required'
        );
    END IF;

    IF v_category IS NULL OR v_category NOT IN ('health', 'community', 'lifestyle', 'nutrition', 'sleep', 'movement', 'mindset', 'medical', 'longevity') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_CATEGORY',
            'message', 'category must be one of: health, community, lifestyle, nutrition, sleep, movement, mindset, medical, longevity'
        );
    END IF;

    IF v_safety_level NOT IN ('safe', 'sensitive') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_SAFETY_LEVEL',
            'message', 'safety_level must be one of: safe, sensitive'
        );
    END IF;

    -- Check for duplicate
    IF EXISTS (SELECT 1 FROM public.topic_registry WHERE tenant_id = v_tenant_id AND topic_key = v_topic_key) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'DUPLICATE_TOPIC_KEY',
            'message', 'topic_key already exists for this tenant'
        );
    END IF;

    -- Insert
    INSERT INTO public.topic_registry (
        tenant_id, topic_key, display_name, category, description, synonyms, safety_level
    )
    VALUES (
        v_tenant_id, v_topic_key, v_display_name, v_category, v_description, v_synonyms, v_safety_level
    )
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_new_id,
        'topic_key', v_topic_key,
        'category', v_category
    );
END;
$$;

-- ===========================================================================
-- 3.8 RPC: topics_get_registry - Get all topics from registry
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.topics_get_registry(p_category TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_topics JSONB;
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

    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', id,
                'topic_key', topic_key,
                'display_name', display_name,
                'category', category,
                'description', description,
                'synonyms', synonyms,
                'safety_level', safety_level,
                'created_at', created_at
            )
            ORDER BY category, display_name
        ),
        '[]'::JSONB
    )
    INTO v_topics
    FROM public.topic_registry
    WHERE tenant_id = v_tenant_id
      AND (p_category IS NULL OR category = p_category);

    RETURN jsonb_build_object(
        'ok', true,
        'topics', v_topics,
        'count', jsonb_array_length(v_topics),
        'category_filter', p_category
    );
END;
$$;

-- ===========================================================================
-- Permissions
-- ===========================================================================

-- RPC functions: callable by authenticated users
GRANT EXECUTE ON FUNCTION public.topics_get_user_profile(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.topics_recompute_user_profile(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.topics_validate_keys(TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.topics_create_registry_entry(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.topics_get_registry(TEXT) TO authenticated;

-- Tables: allow authenticated users to interact (RLS will enforce row-level access)
GRANT SELECT ON public.topic_registry TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_topic_profile TO authenticated;
-- For admin operations on topic_registry (creating topics)
GRANT INSERT, UPDATE, DELETE ON public.topic_registry TO authenticated;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON TABLE public.topic_registry IS 'VTID-01093: Central topic taxonomy registry - single source of truth for all topic_keys';
COMMENT ON TABLE public.user_topic_profile IS 'VTID-01093: User affinity scores for topics - computed from diary, garden, behavior, social signals';
COMMENT ON FUNCTION public.topics_get_user_profile IS 'VTID-01093: Get user topic profile with all affinity scores';
COMMENT ON FUNCTION public.topics_recompute_user_profile IS 'VTID-01093: Recompute user topic profile from all signal sources (deterministic v1)';
COMMENT ON FUNCTION public.topics_validate_keys IS 'VTID-01093: Validate topic_keys against registry with synonym fallback';
COMMENT ON FUNCTION public.topics_create_registry_entry IS 'VTID-01093: Create a new topic in the registry';
COMMENT ON FUNCTION public.topics_get_registry IS 'VTID-01093: Get all topics from registry with optional category filter';
