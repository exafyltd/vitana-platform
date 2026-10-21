-- Migration: 20251231100000_vtid_01084_community_personalization_v1.sql
-- Purpose: VTID-01084 Community Personalization v1 - Longevity-Focused Matches + Meetups
-- Date: 2025-12-31
--
-- Creates deterministic community personalization using:
-- - memory_items (diary entries, values/goals/habits)
-- - health_features_daily (longevity signals: sleep/stress/movement/social)
-- - vitana_index_scores (sleep/nutrition/exercise/hydration/mental scores)
--
-- Tables:
--   - community_groups: Groups with topic keys for matching
--   - community_meetups: Events tied to groups
--   - community_memberships: User membership tracking
--   - community_recommendations: Computed suggestions per day
--
-- RPC Functions:
--   - community_recompute_recommendations: Idempotent daily recompute
--   - community_get_recommendations: Fetch recommendations with explanations
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01104 (Memory Core) - memory_items table
--   - VTID-01078 (Health Brain) - health_features_daily, vitana_index_scores

-- ===========================================================================
-- 1. TABLES
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1.1 community_groups - Groups with topic keys for deterministic matching
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.community_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    name TEXT NOT NULL,
    topic_key TEXT NOT NULL, -- e.g. 'sleep', 'low_sodium', 'walking', 'stress_relief'
    description TEXT,
    is_public BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.community_groups IS 'VTID-01084: Community groups with topic keys for longevity-focused matching';
COMMENT ON COLUMN public.community_groups.topic_key IS 'Topic identifier for deterministic matching: sleep, low_sodium, walking, stress_relief, heart_health, mindfulness, social, etc.';

-- Index for topic-based queries
CREATE INDEX IF NOT EXISTS idx_community_groups_tenant_topic
    ON public.community_groups (tenant_id, topic_key);
CREATE INDEX IF NOT EXISTS idx_community_groups_tenant_public
    ON public.community_groups (tenant_id, is_public, created_at DESC);

-- ---------------------------------------------------------------------------
-- 1.2 community_meetups - Events tied to groups
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.community_meetups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    group_id UUID NOT NULL REFERENCES public.community_groups(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    location_text TEXT,
    mode TEXT NOT NULL CHECK (mode IN ('online', 'in_person')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.community_meetups IS 'VTID-01084: Community meetups (events) linked to groups';
COMMENT ON COLUMN public.community_meetups.mode IS 'Meeting mode: online or in_person';

-- Index for upcoming meetups queries
CREATE INDEX IF NOT EXISTS idx_community_meetups_tenant_group
    ON public.community_meetups (tenant_id, group_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_community_meetups_tenant_starts
    ON public.community_meetups (tenant_id, starts_at);

-- ---------------------------------------------------------------------------
-- 1.3 community_memberships - User membership tracking
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.community_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    group_id UUID NOT NULL REFERENCES public.community_groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'left', 'banned')) DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_community_memberships_tenant_group_user
        UNIQUE (tenant_id, group_id, user_id)
);

COMMENT ON TABLE public.community_memberships IS 'VTID-01084: User memberships in community groups';
COMMENT ON COLUMN public.community_memberships.status IS 'Membership status: active, left, or banned';

-- Index for user membership lookups
CREATE INDEX IF NOT EXISTS idx_community_memberships_tenant_user
    ON public.community_memberships (tenant_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_community_memberships_tenant_group
    ON public.community_memberships (tenant_id, group_id, status);

-- ---------------------------------------------------------------------------
-- 1.4 community_recommendations - Computed suggestions per day (idempotent)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.community_recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    rec_date DATE NOT NULL,
    rec_type TEXT NOT NULL CHECK (rec_type IN ('group', 'meetup')),
    target_id UUID NOT NULL, -- References group_id or meetup_id based on rec_type
    score INT NOT NULL CHECK (score >= 0 AND score <= 100), -- 0-100 deterministic score
    reasons JSONB NOT NULL DEFAULT '[]'::JSONB, -- Array of reason objects with evidence
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_community_recommendations_tenant_user_date_type_target
        UNIQUE (tenant_id, user_id, rec_date, rec_type, target_id)
);

COMMENT ON TABLE public.community_recommendations IS 'VTID-01084: Daily computed community recommendations with deterministic scoring';
COMMENT ON COLUMN public.community_recommendations.score IS 'Deterministic score 0-100: base match (0-60) + urgency boost (0-25) + consistency boost (0-15)';
COMMENT ON COLUMN public.community_recommendations.reasons IS 'Array of reason objects: [{rule_key, matched_node_ids, matched_diary_ids, matched_signal_fields, signal_dates}]';

-- Index for recommendation queries
CREATE INDEX IF NOT EXISTS idx_community_recommendations_tenant_user_date
    ON public.community_recommendations (tenant_id, user_id, rec_date DESC, score DESC);
CREATE INDEX IF NOT EXISTS idx_community_recommendations_tenant_date_type
    ON public.community_recommendations (tenant_id, rec_date, rec_type);

-- ===========================================================================
-- 2. ENABLE RLS
-- ===========================================================================

ALTER TABLE public.community_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_meetups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_recommendations ENABLE ROW LEVEL SECURITY;

-- ===========================================================================
-- 3. RLS POLICIES
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 3.1 community_groups policies (public groups visible to all tenant users)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS community_groups_select ON public.community_groups;
CREATE POLICY community_groups_select ON public.community_groups
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND (is_public = true OR EXISTS (
            SELECT 1 FROM public.community_memberships cm
            WHERE cm.group_id = community_groups.id
              AND cm.user_id = auth.uid()
              AND cm.status = 'active'
        ))
    );

DROP POLICY IF EXISTS community_groups_insert ON public.community_groups;
CREATE POLICY community_groups_insert ON public.community_groups
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
    );

DROP POLICY IF EXISTS community_groups_update ON public.community_groups;
CREATE POLICY community_groups_update ON public.community_groups
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
    );

DROP POLICY IF EXISTS community_groups_delete ON public.community_groups;
CREATE POLICY community_groups_delete ON public.community_groups
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
    );

-- ---------------------------------------------------------------------------
-- 3.2 community_meetups policies (visible to group members or public groups)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS community_meetups_select ON public.community_meetups;
CREATE POLICY community_meetups_select ON public.community_meetups
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND EXISTS (
            SELECT 1 FROM public.community_groups g
            WHERE g.id = community_meetups.group_id
              AND (g.is_public = true OR EXISTS (
                  SELECT 1 FROM public.community_memberships cm
                  WHERE cm.group_id = g.id
                    AND cm.user_id = auth.uid()
                    AND cm.status = 'active'
              ))
        )
    );

DROP POLICY IF EXISTS community_meetups_insert ON public.community_meetups;
CREATE POLICY community_meetups_insert ON public.community_meetups
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
    );

DROP POLICY IF EXISTS community_meetups_update ON public.community_meetups;
CREATE POLICY community_meetups_update ON public.community_meetups
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
    );

DROP POLICY IF EXISTS community_meetups_delete ON public.community_meetups;
CREATE POLICY community_meetups_delete ON public.community_meetups
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
    );

-- ---------------------------------------------------------------------------
-- 3.3 community_memberships policies (user can see/manage own memberships)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS community_memberships_select ON public.community_memberships;
CREATE POLICY community_memberships_select ON public.community_memberships
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS community_memberships_insert ON public.community_memberships;
CREATE POLICY community_memberships_insert ON public.community_memberships
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS community_memberships_update ON public.community_memberships;
CREATE POLICY community_memberships_update ON public.community_memberships
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS community_memberships_delete ON public.community_memberships;
CREATE POLICY community_memberships_delete ON public.community_memberships
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- ---------------------------------------------------------------------------
-- 3.4 community_recommendations policies (user can see own recommendations)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS community_recommendations_select ON public.community_recommendations;
CREATE POLICY community_recommendations_select ON public.community_recommendations
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS community_recommendations_insert ON public.community_recommendations;
CREATE POLICY community_recommendations_insert ON public.community_recommendations
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS community_recommendations_update ON public.community_recommendations;
CREATE POLICY community_recommendations_update ON public.community_recommendations
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS community_recommendations_delete ON public.community_recommendations;
CREATE POLICY community_recommendations_delete ON public.community_recommendations
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- ===========================================================================
-- 4. RULE REGISTRY (Deterministic Matching Rules)
-- ===========================================================================

-- The rule registry is defined as a function that returns the matching rules
-- This allows for traceable, deterministic matching without magic

CREATE OR REPLACE FUNCTION public.community_get_matching_rules()
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_array(
        -- Rule 1: Low movement score → walking group
        jsonb_build_object(
            'rule_key', 'low_movement_walking',
            'topic_keys', jsonb_build_array('walking', 'exercise', 'movement'),
            'conditions', jsonb_build_object(
                'type', 'health_score',
                'field', 'score_exercise',
                'operator', '<',
                'value', 40
            ),
            'base_score', 50,
            'urgency_boost_max', 25,
            'description', 'Low exercise score suggests walking/movement group'
        ),
        -- Rule 2: Low sleep quality → sleep group
        jsonb_build_object(
            'rule_key', 'low_sleep_quality',
            'topic_keys', jsonb_build_array('sleep', 'sleep_hygiene', 'rest'),
            'conditions', jsonb_build_object(
                'type', 'health_score',
                'field', 'score_sleep',
                'operator', '<',
                'value', 40
            ),
            'base_score', 55,
            'urgency_boost_max', 25,
            'description', 'Low sleep score suggests sleep improvement group'
        ),
        -- Rule 3: Diary mentions sleep issues → sleep group
        jsonb_build_object(
            'rule_key', 'diary_sleep_issues',
            'topic_keys', jsonb_build_array('sleep', 'sleep_hygiene'),
            'conditions', jsonb_build_object(
                'type', 'diary_keywords',
                'keywords', jsonb_build_array('sleep', 'insomnia', 'tired', 'fatigue', 'restless', 'cant sleep', 'trouble sleeping', 'sleep issues')
            ),
            'base_score', 45,
            'urgency_boost_max', 20,
            'description', 'Diary mentions sleep issues'
        ),
        -- Rule 4: High stress / low mental score → stress relief
        jsonb_build_object(
            'rule_key', 'high_stress',
            'topic_keys', jsonb_build_array('stress_relief', 'mindfulness', 'meditation', 'relaxation'),
            'conditions', jsonb_build_object(
                'type', 'health_score',
                'field', 'score_mental',
                'operator', '<',
                'value', 40
            ),
            'base_score', 50,
            'urgency_boost_max', 25,
            'description', 'Low mental score suggests stress relief group'
        ),
        -- Rule 5: Diary mentions stress → stress relief
        jsonb_build_object(
            'rule_key', 'diary_stress',
            'topic_keys', jsonb_build_array('stress_relief', 'mindfulness', 'meditation'),
            'conditions', jsonb_build_object(
                'type', 'diary_keywords',
                'keywords', jsonb_build_array('stress', 'stressed', 'anxious', 'anxiety', 'overwhelmed', 'burnout', 'tension')
            ),
            'base_score', 45,
            'urgency_boost_max', 20,
            'description', 'Diary mentions stress or anxiety'
        ),
        -- Rule 6: Low nutrition score → heart health / nutrition
        jsonb_build_object(
            'rule_key', 'low_nutrition',
            'topic_keys', jsonb_build_array('heart_health', 'low_sodium', 'nutrition', 'healthy_eating'),
            'conditions', jsonb_build_object(
                'type', 'health_score',
                'field', 'score_nutrition',
                'operator', '<',
                'value', 40
            ),
            'base_score', 45,
            'urgency_boost_max', 20,
            'description', 'Low nutrition score suggests nutrition group'
        ),
        -- Rule 7: Diary mentions diet/nutrition → nutrition groups
        jsonb_build_object(
            'rule_key', 'diary_nutrition',
            'topic_keys', jsonb_build_array('nutrition', 'healthy_eating', 'low_sodium', 'heart_health'),
            'conditions', jsonb_build_object(
                'type', 'diary_keywords',
                'keywords', jsonb_build_array('diet', 'sodium', 'salt', 'cholesterol', 'healthy eating', 'nutrition', 'weight', 'calories')
            ),
            'base_score', 40,
            'urgency_boost_max', 15,
            'description', 'Diary mentions nutrition or diet concerns'
        ),
        -- Rule 8: Goal mentions for specific topics
        jsonb_build_object(
            'rule_key', 'goal_fitness',
            'topic_keys', jsonb_build_array('walking', 'exercise', 'fitness', 'movement'),
            'conditions', jsonb_build_object(
                'type', 'memory_category',
                'category_key', 'goals',
                'keywords', jsonb_build_array('exercise', 'workout', 'walk', 'run', 'fitness', 'active', 'gym', 'steps')
            ),
            'base_score', 50,
            'urgency_boost_max', 15,
            'description', 'User has fitness/exercise goals'
        ),
        -- Rule 9: Social engagement (low social from diary or low community mentions)
        jsonb_build_object(
            'rule_key', 'low_social',
            'topic_keys', jsonb_build_array('social', 'community', 'networking'),
            'conditions', jsonb_build_object(
                'type', 'diary_keywords',
                'keywords', jsonb_build_array('lonely', 'alone', 'isolated', 'miss friends', 'social', 'connect', 'meet people')
            ),
            'base_score', 45,
            'urgency_boost_max', 25,
            'description', 'User expresses desire for social connection'
        ),
        -- Rule 10: Low hydration → hydration group
        jsonb_build_object(
            'rule_key', 'low_hydration',
            'topic_keys', jsonb_build_array('hydration', 'water', 'wellness'),
            'conditions', jsonb_build_object(
                'type', 'health_score',
                'field', 'score_hydration',
                'operator', '<',
                'value', 40
            ),
            'base_score', 35,
            'urgency_boost_max', 15,
            'description', 'Low hydration score suggests hydration awareness group'
        )
    );
$$;

COMMENT ON FUNCTION public.community_get_matching_rules IS 'VTID-01084: Returns deterministic matching rules for community recommendations';

-- ===========================================================================
-- 5. RPC: community_recompute_recommendations
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.community_recompute_recommendations(
    p_user_id UUID DEFAULT NULL,
    p_date DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_date DATE;
    v_rules JSONB;
    v_rule JSONB;
    v_group RECORD;
    v_meetup RECORD;
    v_latest_score RECORD;
    v_diary_items JSONB;
    v_goal_items JSONB;
    v_matched BOOLEAN;
    v_score INT;
    v_urgency_boost INT;
    v_consistency_boost INT;
    v_reasons JSONB;
    v_matched_keywords JSONB;
    v_matched_diary_ids JSONB;
    v_groups_count INT := 0;
    v_meetups_count INT := 0;
    v_health_field_value INT;
    v_keyword TEXT;
    v_diary_item JSONB;
    v_signal_dates JSONB;
    v_days_lookback INT := 7;
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
            'message', 'No authenticated user and no p_user_id provided'
        );
    END IF;

    -- Use provided date or today
    v_date := COALESCE(p_date, CURRENT_DATE);

    -- Get matching rules
    v_rules := public.community_get_matching_rules();

    -- Get latest vitana index score (last 7 days)
    SELECT
        score_sleep,
        score_nutrition,
        score_exercise,
        score_hydration,
        score_mental,
        date
    INTO v_latest_score
    FROM public.vitana_index_scores
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND date >= (v_date - INTERVAL '7 days')::DATE
    ORDER BY date DESC
    LIMIT 1;

    -- Get recent diary entries (last 7 days)
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', id,
        'content', content,
        'occurred_at', occurred_at
    )), '[]'::JSONB)
    INTO v_diary_items
    FROM public.memory_items
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND source IN ('diary', 'orb_text', 'orb_voice')
      AND occurred_at >= (v_date - INTERVAL '7 days')::TIMESTAMPTZ;

    -- Get goal-related memory items
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', id,
        'content', content,
        'occurred_at', occurred_at
    )), '[]'::JSONB)
    INTO v_goal_items
    FROM public.memory_items
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND category_key = 'goals'
      AND occurred_at >= (v_date - INTERVAL '30 days')::TIMESTAMPTZ;

    -- Delete existing recommendations for this date (idempotent)
    DELETE FROM public.community_recommendations
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND rec_date = v_date;

    -- Process each rule
    FOR v_rule IN SELECT * FROM jsonb_array_elements(v_rules)
    LOOP
        v_matched := false;
        v_score := 0;
        v_urgency_boost := 0;
        v_consistency_boost := 0;
        v_reasons := '[]'::JSONB;
        v_matched_keywords := '[]'::JSONB;
        v_matched_diary_ids := '[]'::JSONB;
        v_signal_dates := '[]'::JSONB;

        -- Check rule conditions
        IF (v_rule->'conditions'->>'type') = 'health_score' THEN
            -- Health score based rule
            CASE (v_rule->'conditions'->>'field')
                WHEN 'score_sleep' THEN v_health_field_value := v_latest_score.score_sleep;
                WHEN 'score_nutrition' THEN v_health_field_value := v_latest_score.score_nutrition;
                WHEN 'score_exercise' THEN v_health_field_value := v_latest_score.score_exercise;
                WHEN 'score_hydration' THEN v_health_field_value := v_latest_score.score_hydration;
                WHEN 'score_mental' THEN v_health_field_value := v_latest_score.score_mental;
                ELSE v_health_field_value := NULL;
            END CASE;

            IF v_health_field_value IS NOT NULL THEN
                IF (v_rule->'conditions'->>'operator') = '<' AND
                   v_health_field_value < (v_rule->'conditions'->>'value')::INT THEN
                    v_matched := true;
                    v_score := (v_rule->>'base_score')::INT;
                    -- Calculate urgency boost (lower score = higher urgency)
                    v_urgency_boost := LEAST(
                        (v_rule->>'urgency_boost_max')::INT,
                        ((v_rule->'conditions'->>'value')::INT - v_health_field_value)
                    );
                    v_signal_dates := jsonb_build_array(v_latest_score.date);
                END IF;
            END IF;

        ELSIF (v_rule->'conditions'->>'type') = 'diary_keywords' THEN
            -- Diary keyword based rule
            FOR v_keyword IN SELECT * FROM jsonb_array_elements_text(v_rule->'conditions'->'keywords')
            LOOP
                FOR v_diary_item IN SELECT * FROM jsonb_array_elements(v_diary_items)
                LOOP
                    IF lower(v_diary_item->>'content') LIKE '%' || lower(v_keyword) || '%' THEN
                        v_matched := true;
                        v_matched_keywords := v_matched_keywords || jsonb_build_array(v_keyword);
                        v_matched_diary_ids := v_matched_diary_ids || jsonb_build_array(v_diary_item->>'id');
                    END IF;
                END LOOP;
            END LOOP;

            IF v_matched THEN
                v_score := (v_rule->>'base_score')::INT;
                -- Consistency boost based on number of matches
                v_consistency_boost := LEAST(15, jsonb_array_length(v_matched_diary_ids) * 3);
            END IF;

        ELSIF (v_rule->'conditions'->>'type') = 'memory_category' THEN
            -- Memory category (goals) based rule
            FOR v_keyword IN SELECT * FROM jsonb_array_elements_text(v_rule->'conditions'->'keywords')
            LOOP
                FOR v_diary_item IN SELECT * FROM jsonb_array_elements(v_goal_items)
                LOOP
                    IF lower(v_diary_item->>'content') LIKE '%' || lower(v_keyword) || '%' THEN
                        v_matched := true;
                        v_matched_keywords := v_matched_keywords || jsonb_build_array(v_keyword);
                        v_matched_diary_ids := v_matched_diary_ids || jsonb_build_array(v_diary_item->>'id');
                    END IF;
                END LOOP;
            END LOOP;

            IF v_matched THEN
                v_score := (v_rule->>'base_score')::INT;
                v_consistency_boost := LEAST(15, jsonb_array_length(v_matched_diary_ids) * 3);
            END IF;
        END IF;

        -- If matched, find matching groups and create recommendations
        IF v_matched THEN
            -- Build reason object
            v_reasons := jsonb_build_array(jsonb_build_object(
                'rule_key', v_rule->>'rule_key',
                'description', v_rule->>'description',
                'matched_keywords', v_matched_keywords,
                'matched_diary_ids', v_matched_diary_ids,
                'matched_signal_fields', CASE
                    WHEN (v_rule->'conditions'->>'type') = 'health_score'
                    THEN jsonb_build_array(v_rule->'conditions'->>'field')
                    ELSE '[]'::JSONB
                END,
                'signal_dates', v_signal_dates,
                'urgency_boost', v_urgency_boost,
                'consistency_boost', v_consistency_boost
            ));

            -- Calculate final score
            v_score := v_score + v_urgency_boost + v_consistency_boost;

            -- Find matching groups by topic_key
            FOR v_group IN
                SELECT g.id, g.name, g.topic_key
                FROM public.community_groups g
                WHERE g.tenant_id = v_tenant_id
                  AND g.is_public = true
                  AND g.topic_key = ANY(
                      SELECT jsonb_array_elements_text(v_rule->'topic_keys')
                  )
                  -- Exclude groups user is already a member of
                  AND NOT EXISTS (
                      SELECT 1 FROM public.community_memberships cm
                      WHERE cm.group_id = g.id
                        AND cm.user_id = v_user_id
                        AND cm.status = 'active'
                  )
            LOOP
                INSERT INTO public.community_recommendations (
                    tenant_id, user_id, rec_date, rec_type, target_id, score, reasons
                ) VALUES (
                    v_tenant_id, v_user_id, v_date, 'group', v_group.id,
                    LEAST(100, v_score), v_reasons
                )
                ON CONFLICT (tenant_id, user_id, rec_date, rec_type, target_id)
                DO UPDATE SET
                    score = GREATEST(community_recommendations.score, EXCLUDED.score),
                    reasons = CASE
                        WHEN EXCLUDED.score > community_recommendations.score
                        THEN EXCLUDED.reasons
                        ELSE community_recommendations.reasons
                    END;

                v_groups_count := v_groups_count + 1;
            END LOOP;

            -- Find upcoming meetups for matching groups
            FOR v_meetup IN
                SELECT m.id, m.title, m.group_id
                FROM public.community_meetups m
                JOIN public.community_groups g ON g.id = m.group_id
                WHERE m.tenant_id = v_tenant_id
                  AND g.is_public = true
                  AND m.starts_at > NOW()
                  AND m.starts_at <= (NOW() + INTERVAL '14 days')
                  AND g.topic_key = ANY(
                      SELECT jsonb_array_elements_text(v_rule->'topic_keys')
                  )
            LOOP
                INSERT INTO public.community_recommendations (
                    tenant_id, user_id, rec_date, rec_type, target_id, score, reasons
                ) VALUES (
                    v_tenant_id, v_user_id, v_date, 'meetup', v_meetup.id,
                    LEAST(100, v_score), v_reasons
                )
                ON CONFLICT (tenant_id, user_id, rec_date, rec_type, target_id)
                DO UPDATE SET
                    score = GREATEST(community_recommendations.score, EXCLUDED.score),
                    reasons = CASE
                        WHEN EXCLUDED.score > community_recommendations.score
                        THEN EXCLUDED.reasons
                        ELSE community_recommendations.reasons
                    END;

                v_meetups_count := v_meetups_count + 1;
            END LOOP;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'groups', v_groups_count,
        'meetups', v_meetups_count,
        'rec_date', v_date,
        'recomputed_at', NOW()
    );
END;
$$;

COMMENT ON FUNCTION public.community_recompute_recommendations IS 'VTID-01084: Recompute community recommendations for a user. Idempotent per day.';

-- ===========================================================================
-- 6. RPC: community_get_recommendations
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.community_get_recommendations(
    p_user_id UUID DEFAULT NULL,
    p_date DATE DEFAULT NULL,
    p_type TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_date DATE;
    v_recommendations JSONB;
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
            'message', 'No authenticated user and no p_user_id provided'
        );
    END IF;

    -- Use provided date or today
    v_date := COALESCE(p_date, CURRENT_DATE);

    -- Get recommendations with target details
    SELECT COALESCE(jsonb_agg(rec_row ORDER BY rec_row->>'score' DESC), '[]'::JSONB)
    INTO v_recommendations
    FROM (
        SELECT jsonb_build_object(
            'id', r.id,
            'rec_type', r.rec_type,
            'target_id', r.target_id,
            'score', r.score,
            'reasons', r.reasons,
            'target', CASE r.rec_type
                WHEN 'group' THEN (
                    SELECT jsonb_build_object(
                        'id', g.id,
                        'name', g.name,
                        'topic_key', g.topic_key,
                        'description', g.description
                    )
                    FROM public.community_groups g
                    WHERE g.id = r.target_id
                )
                WHEN 'meetup' THEN (
                    SELECT jsonb_build_object(
                        'id', m.id,
                        'title', m.title,
                        'group_id', m.group_id,
                        'group_name', g.name,
                        'starts_at', m.starts_at,
                        'ends_at', m.ends_at,
                        'location_text', m.location_text,
                        'mode', m.mode
                    )
                    FROM public.community_meetups m
                    JOIN public.community_groups g ON g.id = m.group_id
                    WHERE m.id = r.target_id
                )
            END,
            'created_at', r.created_at
        ) AS rec_row
        FROM public.community_recommendations r
        WHERE r.tenant_id = v_tenant_id
          AND r.user_id = v_user_id
          AND r.rec_date = v_date
          AND (p_type IS NULL OR r.rec_type = p_type)
    ) sub
    WHERE (sub.rec_row->'target') IS NOT NULL;

    RETURN jsonb_build_object(
        'ok', true,
        'recommendations', v_recommendations,
        'rec_date', v_date,
        'count', jsonb_array_length(v_recommendations)
    );
END;
$$;

COMMENT ON FUNCTION public.community_get_recommendations IS 'VTID-01084: Get community recommendations for a user with explanations';

-- ===========================================================================
-- 7. RPC: community_get_recommendation_explain
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.community_get_recommendation_explain(
    p_recommendation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_rec RECORD;
    v_target_info JSONB;
    v_evidence JSONB;
    v_diary_entries JSONB;
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

    -- Get the recommendation
    SELECT * INTO v_rec
    FROM public.community_recommendations
    WHERE id = p_recommendation_id
      AND tenant_id = v_tenant_id
      AND user_id = v_user_id;

    IF v_rec IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'NOT_FOUND',
            'message', 'Recommendation not found or access denied'
        );
    END IF;

    -- Get target info
    IF v_rec.rec_type = 'group' THEN
        SELECT jsonb_build_object(
            'type', 'group',
            'id', g.id,
            'name', g.name,
            'topic_key', g.topic_key,
            'description', g.description
        ) INTO v_target_info
        FROM public.community_groups g
        WHERE g.id = v_rec.target_id;
    ELSE
        SELECT jsonb_build_object(
            'type', 'meetup',
            'id', m.id,
            'title', m.title,
            'group_id', m.group_id,
            'group_name', g.name,
            'starts_at', m.starts_at,
            'ends_at', m.ends_at,
            'location_text', m.location_text,
            'mode', m.mode
        ) INTO v_target_info
        FROM public.community_meetups m
        JOIN public.community_groups g ON g.id = m.group_id
        WHERE m.id = v_rec.target_id;
    END IF;

    -- Get diary entries referenced in reasons (if any)
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', mi.id,
        'content', LEFT(mi.content, 200), -- Truncate for privacy
        'occurred_at', mi.occurred_at
    )), '[]'::JSONB)
    INTO v_diary_entries
    FROM public.memory_items mi
    WHERE mi.tenant_id = v_tenant_id
      AND mi.user_id = v_user_id
      AND mi.id::TEXT = ANY(
          SELECT jsonb_array_elements_text(
              (SELECT jsonb_path_query_array(v_rec.reasons, '$[*].matched_diary_ids[*]'))
          )
      );

    RETURN jsonb_build_object(
        'ok', true,
        'recommendation', jsonb_build_object(
            'id', v_rec.id,
            'rec_type', v_rec.rec_type,
            'rec_date', v_rec.rec_date,
            'score', v_rec.score,
            'created_at', v_rec.created_at
        ),
        'target', v_target_info,
        'reasons', v_rec.reasons,
        'evidence', jsonb_build_object(
            'diary_entries', v_diary_entries,
            'matched_rules', (SELECT jsonb_agg(r->>'rule_key') FROM jsonb_array_elements(v_rec.reasons) r)
        )
    );
END;
$$;

COMMENT ON FUNCTION public.community_get_recommendation_explain IS 'VTID-01084: Get detailed explanation for a specific recommendation';

-- ===========================================================================
-- 8. RPC: community_create_group
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.community_create_group(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_name TEXT;
    v_topic_key TEXT;
    v_description TEXT;
    v_is_public BOOLEAN;
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

    -- Extract payload
    v_name := p_payload->>'name';
    v_topic_key := p_payload->>'topic_key';
    v_description := p_payload->>'description';
    v_is_public := COALESCE((p_payload->>'is_public')::BOOLEAN, true);

    -- Validate required fields
    IF v_name IS NULL OR v_name = '' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_NAME',
            'message', 'name is required'
        );
    END IF;

    IF v_topic_key IS NULL OR v_topic_key = '' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_TOPIC_KEY',
            'message', 'topic_key is required'
        );
    END IF;

    -- Insert the group
    INSERT INTO public.community_groups (
        tenant_id, name, topic_key, description, is_public
    ) VALUES (
        v_tenant_id, v_name, v_topic_key, v_description, v_is_public
    )
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_new_id,
        'name', v_name,
        'topic_key', v_topic_key
    );
END;
$$;

COMMENT ON FUNCTION public.community_create_group IS 'VTID-01084: Create a new community group';

-- ===========================================================================
-- 9. RPC: community_create_meetup
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.community_create_meetup(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_group_id UUID;
    v_title TEXT;
    v_starts_at TIMESTAMPTZ;
    v_ends_at TIMESTAMPTZ;
    v_location_text TEXT;
    v_mode TEXT;
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

    -- Extract payload
    v_group_id := (p_payload->>'group_id')::UUID;
    v_title := p_payload->>'title';
    v_starts_at := (p_payload->>'starts_at')::TIMESTAMPTZ;
    v_ends_at := (p_payload->>'ends_at')::TIMESTAMPTZ;
    v_location_text := p_payload->>'location_text';
    v_mode := COALESCE(p_payload->>'mode', 'online');

    -- Validate required fields
    IF v_group_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_GROUP_ID',
            'message', 'group_id is required'
        );
    END IF;

    IF v_title IS NULL OR v_title = '' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_TITLE',
            'message', 'title is required'
        );
    END IF;

    IF v_starts_at IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_STARTS_AT',
            'message', 'starts_at is required'
        );
    END IF;

    IF v_ends_at IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_ENDS_AT',
            'message', 'ends_at is required'
        );
    END IF;

    IF v_mode NOT IN ('online', 'in_person') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_MODE',
            'message', 'mode must be online or in_person'
        );
    END IF;

    -- Verify group exists and belongs to tenant
    IF NOT EXISTS (
        SELECT 1 FROM public.community_groups
        WHERE id = v_group_id AND tenant_id = v_tenant_id
    ) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'GROUP_NOT_FOUND',
            'message', 'Group not found or access denied'
        );
    END IF;

    -- Insert the meetup
    INSERT INTO public.community_meetups (
        tenant_id, group_id, title, starts_at, ends_at, location_text, mode
    ) VALUES (
        v_tenant_id, v_group_id, v_title, v_starts_at, v_ends_at, v_location_text, v_mode
    )
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_new_id,
        'title', v_title,
        'group_id', v_group_id
    );
END;
$$;

COMMENT ON FUNCTION public.community_create_meetup IS 'VTID-01084: Create a new community meetup';

-- ===========================================================================
-- 10. RPC: community_join_group
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.community_join_group(p_group_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_existing_status TEXT;
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

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Verify group exists and is accessible
    IF NOT EXISTS (
        SELECT 1 FROM public.community_groups
        WHERE id = p_group_id
          AND tenant_id = v_tenant_id
          AND is_public = true
    ) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'GROUP_NOT_FOUND',
            'message', 'Group not found or not public'
        );
    END IF;

    -- Check existing membership
    SELECT status INTO v_existing_status
    FROM public.community_memberships
    WHERE tenant_id = v_tenant_id
      AND group_id = p_group_id
      AND user_id = v_user_id;

    IF v_existing_status = 'active' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'ALREADY_MEMBER',
            'message', 'You are already a member of this group'
        );
    END IF;

    IF v_existing_status = 'banned' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'BANNED',
            'message', 'You are banned from this group'
        );
    END IF;

    -- Insert or update membership
    INSERT INTO public.community_memberships (
        tenant_id, group_id, user_id, status
    ) VALUES (
        v_tenant_id, p_group_id, v_user_id, 'active'
    )
    ON CONFLICT (tenant_id, group_id, user_id)
    DO UPDATE SET status = 'active'
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object(
        'ok', true,
        'membership_id', v_new_id,
        'group_id', p_group_id,
        'status', 'active'
    );
END;
$$;

COMMENT ON FUNCTION public.community_join_group IS 'VTID-01084: Join a community group';

-- ===========================================================================
-- 11. PERMISSIONS
-- ===========================================================================

-- RPC functions: callable by authenticated users
GRANT EXECUTE ON FUNCTION public.community_get_matching_rules() TO authenticated;
GRANT EXECUTE ON FUNCTION public.community_recompute_recommendations(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.community_get_recommendations(UUID, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.community_get_recommendation_explain(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.community_create_group(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.community_create_meetup(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.community_join_group(UUID) TO authenticated;

-- Tables: allow authenticated users to interact (RLS will enforce row-level access)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.community_groups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.community_meetups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.community_memberships TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.community_recommendations TO authenticated;

-- ===========================================================================
-- 12. SEED DATA: Common topic groups (optional, tenant-specific seeding recommended)
-- ===========================================================================

-- Note: These are example groups. In production, groups would be created per-tenant.
-- This creates groups for the default Vitana tenant (00000000-0000-0000-0000-000000000001)

DO $$
DECLARE
    v_vitana_tenant UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
    -- Only seed if no groups exist for Vitana tenant
    IF NOT EXISTS (SELECT 1 FROM public.community_groups WHERE tenant_id = v_vitana_tenant) THEN
        INSERT INTO public.community_groups (tenant_id, name, topic_key, description, is_public) VALUES
            (v_vitana_tenant, 'Morning Walkers', 'walking', 'Daily morning walking group for fitness and social connection', true),
            (v_vitana_tenant, 'Sleep Better Together', 'sleep', 'Support group for improving sleep quality and habits', true),
            (v_vitana_tenant, 'Stress Relief Circle', 'stress_relief', 'Mindfulness and stress management community', true),
            (v_vitana_tenant, 'Mindful Meditation', 'mindfulness', 'Daily meditation practice and mindfulness tips', true),
            (v_vitana_tenant, 'Heart Health Heroes', 'heart_health', 'Community focused on cardiovascular health', true),
            (v_vitana_tenant, 'Low Sodium Living', 'low_sodium', 'Tips and recipes for low-sodium diet', true),
            (v_vitana_tenant, 'Active Movers', 'exercise', 'General fitness and exercise motivation group', true),
            (v_vitana_tenant, 'Healthy Eaters', 'nutrition', 'Nutrition tips, recipes, and meal planning', true),
            (v_vitana_tenant, 'Hydration Station', 'hydration', 'Reminders and tips for staying hydrated', true),
            (v_vitana_tenant, 'Social Connectors', 'social', 'Community for building friendships and social support', true);
    END IF;
END;
$$;

-- ===========================================================================
-- END OF MIGRATION: VTID-01084 Community Personalization v1
-- ===========================================================================
