-- Migration: 20251231000001_vtid_01083_longevity_signal_layer.sql
-- Purpose: VTID-01083 Longevity Signal Layer (Diary -> Health Intelligence Bridge)
-- Date: 2025-12-31
--
-- Creates the deterministic Longevity Signal Layer that converts daily diary entries
-- and Memory Garden nodes into measurable health signals (sleep, stress, hydration,
-- nutrition, movement, social) for the Health brain.
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01102 (Phase B-Fix) - runtime context bridge
--   - VTID-01104 (Memory Core v1) - memory_items table
--   - VTID-01082 (Diary + Memory Garden) - creates dependency tables here if missing

-- ===========================================================================
-- 2.A: memory_diary_entries (Dependency - VTID-01082)
-- Structured diary entries with mood, energy, and tags
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.memory_diary_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    entry_date DATE NOT NULL,
    raw_text TEXT NOT NULL CHECK (raw_text != ''),
    mood TEXT NULL CHECK (mood IN ('happy', 'calm', 'neutral', 'anxious', 'sad', 'stressed', 'angry', 'tired', 'energetic')),
    energy_level INT NULL CHECK (energy_level >= 0 AND energy_level <= 100),
    tags TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT memory_diary_entries_unique UNIQUE (tenant_id, user_id, entry_date, id)
);

-- Index for efficient daily queries
CREATE INDEX IF NOT EXISTS idx_memory_diary_entries_tenant_user_date
    ON public.memory_diary_entries (tenant_id, user_id, entry_date DESC);

-- ===========================================================================
-- 2.B: memory_garden_nodes (Dependency - VTID-01082)
-- Graph-like knowledge nodes extracted from diary/memory
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.memory_garden_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    node_type TEXT NOT NULL CHECK (node_type IN ('habit', 'goal', 'person', 'place', 'event', 'preference', 'value', 'health', 'activity')),
    label TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('diary', 'orb', 'upload', 'system')),
    source_id UUID NULL, -- Reference to source record (diary entry, memory item, etc.)
    attributes JSONB DEFAULT '{}'::JSONB,
    confidence NUMERIC DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
    first_seen DATE NOT NULL DEFAULT CURRENT_DATE,
    last_seen DATE NOT NULL DEFAULT CURRENT_DATE,
    occurrence_count INT DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient node queries
CREATE INDEX IF NOT EXISTS idx_memory_garden_nodes_tenant_user_type
    ON public.memory_garden_nodes (tenant_id, user_id, node_type);

CREATE INDEX IF NOT EXISTS idx_memory_garden_nodes_source
    ON public.memory_garden_nodes (tenant_id, user_id, source, last_seen DESC);

-- ===========================================================================
-- 2.C: longevity_signals_daily (NEW - VTID-01083)
-- One row per user per day with computed health signals
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.longevity_signals_daily (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    signal_date DATE NOT NULL,
    sleep_quality INT NULL CHECK (sleep_quality >= 0 AND sleep_quality <= 100),
    stress_level INT NULL CHECK (stress_level >= 0 AND stress_level <= 100),
    hydration_score INT NULL CHECK (hydration_score >= 0 AND hydration_score <= 100),
    nutrition_score INT NULL CHECK (nutrition_score >= 0 AND nutrition_score <= 100),
    movement_score INT NULL CHECK (movement_score >= 0 AND movement_score <= 100),
    social_score INT NULL CHECK (social_score >= 0 AND social_score <= 100),
    overall_longevity_score INT NOT NULL DEFAULT 0 CHECK (overall_longevity_score >= 0 AND overall_longevity_score <= 100),
    evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
    rules_applied TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT longevity_signals_daily_unique UNIQUE (tenant_id, user_id, signal_date)
);

-- Index for efficient date range queries
CREATE INDEX IF NOT EXISTS idx_longevity_signals_daily_tenant_user_date
    ON public.longevity_signals_daily (tenant_id, user_id, signal_date DESC);

-- ===========================================================================
-- 2.D: longevity_signal_rules (NEW - VTID-01083)
-- Deterministic rule registry for signal computation
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.longevity_signal_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_key TEXT NOT NULL UNIQUE,
    rule_version INT NOT NULL DEFAULT 1,
    domain TEXT NOT NULL CHECK (domain IN ('sleep', 'stress', 'hydration', 'nutrition', 'movement', 'social')),
    logic JSONB NOT NULL,
    weight INT NOT NULL DEFAULT 50 CHECK (weight >= 0 AND weight <= 100),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for active rules lookup
CREATE INDEX IF NOT EXISTS idx_longevity_signal_rules_domain_active
    ON public.longevity_signal_rules (domain, active);

-- ===========================================================================
-- 3. Seed Default Rules (v1 baseline)
-- ===========================================================================

INSERT INTO public.longevity_signal_rules (rule_key, rule_version, domain, logic, weight, active) VALUES
    -- Sleep rules
    ('sleep.v1.tag_sleep_bad', 1, 'sleep',
     '{"type": "tag_match", "tags": ["sleep_bad", "insomnia", "poor_sleep"], "effect": "decrease", "delta": 30}'::JSONB,
     80, true),
    ('sleep.v1.keyword_negative', 1, 'sleep',
     '{"type": "keyword_match", "keywords": ["insomnia", "woke up", "tired", "exhausted", "couldn''t sleep", "restless"], "effect": "decrease", "delta": 20}'::JSONB,
     70, true),
    ('sleep.v1.keyword_positive', 1, 'sleep',
     '{"type": "keyword_match", "keywords": ["slept well", "good sleep", "restful", "8 hours", "refreshed"], "effect": "increase", "delta": 20}'::JSONB,
     70, true),
    ('sleep.v1.mood_tired', 1, 'sleep',
     '{"type": "mood_match", "moods": ["tired"], "effect": "decrease", "delta": 15}'::JSONB,
     60, true),

    -- Stress rules
    ('stress.v1.mood_anxious', 1, 'stress',
     '{"type": "mood_match", "moods": ["anxious", "stressed", "angry"], "effect": "increase", "delta": 25}'::JSONB,
     80, true),
    ('stress.v1.keyword_negative', 1, 'stress',
     '{"type": "keyword_match", "keywords": ["stress", "panic", "overwhelmed", "anxious", "worried", "pressure", "deadline"], "effect": "increase", "delta": 20}'::JSONB,
     70, true),
    ('stress.v1.keyword_positive', 1, 'stress',
     '{"type": "keyword_match", "keywords": ["relaxed", "calm", "peaceful", "meditation", "breathwork"], "effect": "decrease", "delta": 15}'::JSONB,
     60, true),
    ('stress.v1.mood_calm', 1, 'stress',
     '{"type": "mood_match", "moods": ["calm", "happy"], "effect": "decrease", "delta": 15}'::JSONB,
     60, true),

    -- Hydration rules
    ('hydration.v1.keyword_positive', 1, 'hydration',
     '{"type": "keyword_match", "keywords": ["2L water", "hydrated", "electrolytes", "drank water", "water bottle", "8 glasses"], "effect": "increase", "delta": 25}'::JSONB,
     80, true),
    ('hydration.v1.keyword_negative', 1, 'hydration',
     '{"type": "keyword_match", "keywords": ["dehydrated", "forgot to drink", "headache", "dry mouth"], "effect": "decrease", "delta": 20}'::JSONB,
     70, true),

    -- Nutrition rules
    ('nutrition.v1.keyword_negative', 1, 'nutrition',
     '{"type": "keyword_match", "keywords": ["fast food", "junk food", "sugar", "late-night snack", "skipped meal", "processed", "soda", "candy"], "effect": "decrease", "delta": 20}'::JSONB,
     70, true),
    ('nutrition.v1.keyword_positive', 1, 'nutrition',
     '{"type": "keyword_match", "keywords": ["healthy meal", "vegetables", "salad", "fruits", "protein", "balanced", "home cooked"], "effect": "increase", "delta": 20}'::JSONB,
     70, true),
    ('nutrition.v1.tag_healthy', 1, 'nutrition',
     '{"type": "tag_match", "tags": ["healthy_eating", "meal_prep", "nutrition"], "effect": "increase", "delta": 15}'::JSONB,
     60, true),

    -- Movement rules
    ('movement.v1.keyword_positive', 1, 'movement',
     '{"type": "keyword_match", "keywords": ["walk", "gym", "training", "steps", "workout", "run", "exercise", "yoga", "hike", "swim"], "effect": "increase", "delta": 25}'::JSONB,
     80, true),
    ('movement.v1.keyword_negative', 1, 'movement',
     '{"type": "keyword_match", "keywords": ["sedentary", "sitting all day", "no exercise", "lazy", "couch"], "effect": "decrease", "delta": 20}'::JSONB,
     70, true),
    ('movement.v1.tag_active', 1, 'movement',
     '{"type": "tag_match", "tags": ["exercise", "fitness", "active", "sports"], "effect": "increase", "delta": 20}'::JSONB,
     70, true),
    ('movement.v1.garden_activity', 1, 'movement',
     '{"type": "garden_node_match", "node_types": ["activity"], "labels": ["gym", "running", "yoga", "walking", "cycling"], "effect": "increase", "delta": 15}'::JSONB,
     60, true),

    -- Social rules
    ('social.v1.keyword_positive', 1, 'social',
     '{"type": "keyword_match", "keywords": ["met friends", "meetup", "community", "family", "dinner with", "call with", "video chat", "party", "gathering"], "effect": "increase", "delta": 25}'::JSONB,
     80, true),
    ('social.v1.keyword_negative', 1, 'social',
     '{"type": "keyword_match", "keywords": ["lonely", "isolated", "alone all day", "no one to talk", "missed event"], "effect": "decrease", "delta": 20}'::JSONB,
     70, true),
    ('social.v1.garden_person', 1, 'social',
     '{"type": "garden_node_match", "node_types": ["person", "event"], "effect": "increase", "delta": 10}'::JSONB,
     50, true),
    ('social.v1.mood_positive', 1, 'social',
     '{"type": "mood_match", "moods": ["happy", "energetic"], "effect": "increase", "delta": 10}'::JSONB,
     50, true)
ON CONFLICT (rule_key) DO NOTHING;

-- ===========================================================================
-- 4. Enable RLS on all tables
-- ===========================================================================

ALTER TABLE public.memory_diary_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_garden_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.longevity_signals_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.longevity_signal_rules ENABLE ROW LEVEL SECURITY;

-- memory_diary_entries RLS
DROP POLICY IF EXISTS memory_diary_entries_select ON public.memory_diary_entries;
CREATE POLICY memory_diary_entries_select ON public.memory_diary_entries
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS memory_diary_entries_insert ON public.memory_diary_entries;
CREATE POLICY memory_diary_entries_insert ON public.memory_diary_entries
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS memory_diary_entries_update ON public.memory_diary_entries;
CREATE POLICY memory_diary_entries_update ON public.memory_diary_entries
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid())
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

-- memory_garden_nodes RLS
DROP POLICY IF EXISTS memory_garden_nodes_select ON public.memory_garden_nodes;
CREATE POLICY memory_garden_nodes_select ON public.memory_garden_nodes
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS memory_garden_nodes_insert ON public.memory_garden_nodes;
CREATE POLICY memory_garden_nodes_insert ON public.memory_garden_nodes
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS memory_garden_nodes_update ON public.memory_garden_nodes;
CREATE POLICY memory_garden_nodes_update ON public.memory_garden_nodes
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid())
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

-- longevity_signals_daily RLS
DROP POLICY IF EXISTS longevity_signals_daily_select ON public.longevity_signals_daily;
CREATE POLICY longevity_signals_daily_select ON public.longevity_signals_daily
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS longevity_signals_daily_insert ON public.longevity_signals_daily;
CREATE POLICY longevity_signals_daily_insert ON public.longevity_signals_daily
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS longevity_signals_daily_update ON public.longevity_signals_daily;
CREATE POLICY longevity_signals_daily_update ON public.longevity_signals_daily
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid())
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

-- longevity_signal_rules: read-only for authenticated users
DROP POLICY IF EXISTS longevity_signal_rules_select ON public.longevity_signal_rules;
CREATE POLICY longevity_signal_rules_select ON public.longevity_signal_rules
    FOR SELECT TO authenticated
    USING (true);

-- ===========================================================================
-- 5. RPC: longevity_compute_daily(p_user_id uuid, p_date date)
-- Deterministic computation of daily longevity signals from diary + garden
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.longevity_compute_daily(
    p_user_id UUID DEFAULT NULL,
    p_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_active_role TEXT;

    -- Score accumulators (start at 50 = neutral baseline)
    v_sleep_score INT := 50;
    v_stress_score INT := 50;
    v_hydration_score INT := 50;
    v_nutrition_score INT := 50;
    v_movement_score INT := 50;
    v_social_score INT := 50;
    v_overall_score INT;

    -- Evidence accumulator
    v_evidence JSONB := '{
        "diary_entries": [],
        "garden_nodes": [],
        "tag_matches": [],
        "keyword_matches": [],
        "mood_matches": [],
        "garden_matches": []
    }'::JSONB;

    v_rules_applied TEXT[] := '{}';
    v_diary_entry RECORD;
    v_garden_node RECORD;
    v_rule RECORD;
    v_text_lower TEXT;
    v_matched BOOLEAN;
    v_delta INT;
    v_match_detail JSONB;
    v_entry_count INT := 0;
    v_node_count INT := 0;
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

    -- Gate 2: Get user_id (use parameter or derive from auth)
    v_user_id := COALESCE(p_user_id, auth.uid());
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user and no user_id provided'
        );
    END IF;

    -- Get active role for audit
    v_active_role := public.current_active_role();

    -- ===========================================================================
    -- Process diary entries for the date
    -- ===========================================================================
    FOR v_diary_entry IN
        SELECT id, raw_text, mood, energy_level, tags
        FROM public.memory_diary_entries
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND entry_date = p_date
    LOOP
        v_entry_count := v_entry_count + 1;
        v_text_lower := LOWER(v_diary_entry.raw_text);

        -- Add to evidence
        v_evidence := jsonb_set(
            v_evidence,
            '{diary_entries}',
            COALESCE(v_evidence->'diary_entries', '[]'::JSONB) || jsonb_build_object(
                'id', v_diary_entry.id,
                'mood', v_diary_entry.mood,
                'energy_level', v_diary_entry.energy_level,
                'tags', v_diary_entry.tags
            )
        );

        -- Apply rules to this diary entry
        FOR v_rule IN
            SELECT * FROM public.longevity_signal_rules
            WHERE active = true
            ORDER BY weight DESC
        LOOP
            v_matched := false;
            v_delta := COALESCE((v_rule.logic->>'delta')::INT, 10);

            -- Tag match rule
            IF (v_rule.logic->>'type') = 'tag_match' THEN
                IF v_diary_entry.tags IS NOT NULL AND
                   v_diary_entry.tags && ARRAY(SELECT jsonb_array_elements_text(v_rule.logic->'tags')) THEN
                    v_matched := true;
                    v_match_detail := jsonb_build_object(
                        'rule', v_rule.rule_key,
                        'type', 'tag_match',
                        'matched_tags', (
                            SELECT jsonb_agg(t)
                            FROM unnest(v_diary_entry.tags) t
                            WHERE t = ANY(ARRAY(SELECT jsonb_array_elements_text(v_rule.logic->'tags')))
                        ),
                        'entry_id', v_diary_entry.id
                    );
                    v_evidence := jsonb_set(
                        v_evidence,
                        '{tag_matches}',
                        COALESCE(v_evidence->'tag_matches', '[]'::JSONB) || v_match_detail
                    );
                END IF;
            END IF;

            -- Keyword match rule
            IF (v_rule.logic->>'type') = 'keyword_match' THEN
                DECLARE
                    v_keyword TEXT;
                    v_matched_keywords TEXT[] := '{}';
                BEGIN
                    FOR v_keyword IN
                        SELECT jsonb_array_elements_text(v_rule.logic->'keywords')
                    LOOP
                        IF v_text_lower LIKE '%' || LOWER(v_keyword) || '%' THEN
                            v_matched := true;
                            v_matched_keywords := array_append(v_matched_keywords, v_keyword);
                        END IF;
                    END LOOP;

                    IF v_matched THEN
                        v_match_detail := jsonb_build_object(
                            'rule', v_rule.rule_key,
                            'type', 'keyword_match',
                            'matched_keywords', to_jsonb(v_matched_keywords),
                            'entry_id', v_diary_entry.id
                        );
                        v_evidence := jsonb_set(
                            v_evidence,
                            '{keyword_matches}',
                            COALESCE(v_evidence->'keyword_matches', '[]'::JSONB) || v_match_detail
                        );
                    END IF;
                END;
            END IF;

            -- Mood match rule
            IF (v_rule.logic->>'type') = 'mood_match' AND v_diary_entry.mood IS NOT NULL THEN
                IF v_diary_entry.mood = ANY(ARRAY(SELECT jsonb_array_elements_text(v_rule.logic->'moods'))) THEN
                    v_matched := true;
                    v_match_detail := jsonb_build_object(
                        'rule', v_rule.rule_key,
                        'type', 'mood_match',
                        'matched_mood', v_diary_entry.mood,
                        'entry_id', v_diary_entry.id
                    );
                    v_evidence := jsonb_set(
                        v_evidence,
                        '{mood_matches}',
                        COALESCE(v_evidence->'mood_matches', '[]'::JSONB) || v_match_detail
                    );
                END IF;
            END IF;

            -- Apply score delta if matched
            IF v_matched THEN
                v_rules_applied := array_append(v_rules_applied, v_rule.rule_key);

                CASE v_rule.domain
                    WHEN 'sleep' THEN
                        IF (v_rule.logic->>'effect') = 'decrease' THEN
                            v_sleep_score := GREATEST(0, v_sleep_score - v_delta);
                        ELSE
                            v_sleep_score := LEAST(100, v_sleep_score + v_delta);
                        END IF;
                    WHEN 'stress' THEN
                        IF (v_rule.logic->>'effect') = 'increase' THEN
                            v_stress_score := LEAST(100, v_stress_score + v_delta);
                        ELSE
                            v_stress_score := GREATEST(0, v_stress_score - v_delta);
                        END IF;
                    WHEN 'hydration' THEN
                        IF (v_rule.logic->>'effect') = 'decrease' THEN
                            v_hydration_score := GREATEST(0, v_hydration_score - v_delta);
                        ELSE
                            v_hydration_score := LEAST(100, v_hydration_score + v_delta);
                        END IF;
                    WHEN 'nutrition' THEN
                        IF (v_rule.logic->>'effect') = 'decrease' THEN
                            v_nutrition_score := GREATEST(0, v_nutrition_score - v_delta);
                        ELSE
                            v_nutrition_score := LEAST(100, v_nutrition_score + v_delta);
                        END IF;
                    WHEN 'movement' THEN
                        IF (v_rule.logic->>'effect') = 'decrease' THEN
                            v_movement_score := GREATEST(0, v_movement_score - v_delta);
                        ELSE
                            v_movement_score := LEAST(100, v_movement_score + v_delta);
                        END IF;
                    WHEN 'social' THEN
                        IF (v_rule.logic->>'effect') = 'decrease' THEN
                            v_social_score := GREATEST(0, v_social_score - v_delta);
                        ELSE
                            v_social_score := LEAST(100, v_social_score + v_delta);
                        END IF;
                END CASE;
            END IF;
        END LOOP;
    END LOOP;

    -- ===========================================================================
    -- Process garden nodes updated on this date
    -- ===========================================================================
    FOR v_garden_node IN
        SELECT id, node_type, label, attributes
        FROM public.memory_garden_nodes
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND source = 'diary'
          AND last_seen = p_date
    LOOP
        v_node_count := v_node_count + 1;

        -- Add to evidence
        v_evidence := jsonb_set(
            v_evidence,
            '{garden_nodes}',
            COALESCE(v_evidence->'garden_nodes', '[]'::JSONB) || jsonb_build_object(
                'id', v_garden_node.id,
                'node_type', v_garden_node.node_type,
                'label', v_garden_node.label
            )
        );

        -- Apply garden node rules
        FOR v_rule IN
            SELECT * FROM public.longevity_signal_rules
            WHERE active = true
              AND (v_rule.logic->>'type') = 'garden_node_match'
            ORDER BY weight DESC
        LOOP
            v_matched := false;
            v_delta := COALESCE((v_rule.logic->>'delta')::INT, 10);

            -- Check node type match
            IF v_garden_node.node_type = ANY(ARRAY(SELECT jsonb_array_elements_text(v_rule.logic->'node_types'))) THEN
                -- If labels specified, check label match; otherwise match on type alone
                IF v_rule.logic->'labels' IS NULL OR
                   LOWER(v_garden_node.label) = ANY(ARRAY(SELECT LOWER(jsonb_array_elements_text(v_rule.logic->'labels')))) THEN
                    v_matched := true;
                    v_match_detail := jsonb_build_object(
                        'rule', v_rule.rule_key,
                        'type', 'garden_node_match',
                        'matched_node_type', v_garden_node.node_type,
                        'matched_label', v_garden_node.label,
                        'node_id', v_garden_node.id
                    );
                    v_evidence := jsonb_set(
                        v_evidence,
                        '{garden_matches}',
                        COALESCE(v_evidence->'garden_matches', '[]'::JSONB) || v_match_detail
                    );
                END IF;
            END IF;

            -- Apply score delta if matched
            IF v_matched THEN
                v_rules_applied := array_append(v_rules_applied, v_rule.rule_key);

                CASE v_rule.domain
                    WHEN 'movement' THEN
                        IF (v_rule.logic->>'effect') = 'decrease' THEN
                            v_movement_score := GREATEST(0, v_movement_score - v_delta);
                        ELSE
                            v_movement_score := LEAST(100, v_movement_score + v_delta);
                        END IF;
                    WHEN 'social' THEN
                        IF (v_rule.logic->>'effect') = 'decrease' THEN
                            v_social_score := GREATEST(0, v_social_score - v_delta);
                        ELSE
                            v_social_score := LEAST(100, v_social_score + v_delta);
                        END IF;
                    ELSE
                        -- Handle other domains if needed
                        NULL;
                END CASE;
            END IF;
        END LOOP;
    END LOOP;

    -- ===========================================================================
    -- Calculate overall longevity score (weighted average)
    -- Note: stress is inverted (lower stress = better longevity)
    -- ===========================================================================
    v_overall_score := (
        COALESCE(v_sleep_score, 50) * 20 +          -- 20% weight
        COALESCE(100 - v_stress_score, 50) * 20 +   -- 20% weight (inverted)
        COALESCE(v_hydration_score, 50) * 15 +      -- 15% weight
        COALESCE(v_nutrition_score, 50) * 15 +      -- 15% weight
        COALESCE(v_movement_score, 50) * 15 +       -- 15% weight
        COALESCE(v_social_score, 50) * 15           -- 15% weight
    ) / 100;

    -- Clamp to 0-100
    v_overall_score := GREATEST(0, LEAST(100, v_overall_score));

    -- ===========================================================================
    -- Upsert the daily signals row
    -- ===========================================================================
    INSERT INTO public.longevity_signals_daily (
        tenant_id,
        user_id,
        signal_date,
        sleep_quality,
        stress_level,
        hydration_score,
        nutrition_score,
        movement_score,
        social_score,
        overall_longevity_score,
        evidence,
        rules_applied
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_date,
        v_sleep_score,
        v_stress_score,
        v_hydration_score,
        v_nutrition_score,
        v_movement_score,
        v_social_score,
        v_overall_score,
        v_evidence,
        v_rules_applied
    )
    ON CONFLICT (tenant_id, user_id, signal_date)
    DO UPDATE SET
        sleep_quality = EXCLUDED.sleep_quality,
        stress_level = EXCLUDED.stress_level,
        hydration_score = EXCLUDED.hydration_score,
        nutrition_score = EXCLUDED.nutrition_score,
        movement_score = EXCLUDED.movement_score,
        social_score = EXCLUDED.social_score,
        overall_longevity_score = EXCLUDED.overall_longevity_score,
        evidence = EXCLUDED.evidence,
        rules_applied = EXCLUDED.rules_applied,
        updated_at = NOW();

    -- Return success with computed scores
    RETURN jsonb_build_object(
        'ok', true,
        'date', p_date,
        'scores', jsonb_build_object(
            'sleep_quality', v_sleep_score,
            'stress_level', v_stress_score,
            'hydration_score', v_hydration_score,
            'nutrition_score', v_nutrition_score,
            'movement_score', v_movement_score,
            'social_score', v_social_score,
            'overall_longevity_score', v_overall_score
        ),
        'evidence', v_evidence,
        'rules_applied', to_jsonb(v_rules_applied),
        'diary_entries_processed', v_entry_count,
        'garden_nodes_processed', v_node_count,
        'tenant_id', v_tenant_id,
        'user_id', v_user_id
    );
END;
$$;

-- ===========================================================================
-- 6. RPC: longevity_get_daily(p_from date, p_to date)
-- Retrieves daily signals for a date range
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.longevity_get_daily(
    p_from DATE,
    p_to DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_signals JSONB;
    v_to_date DATE;
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

    -- Default to_date to from_date if not provided
    v_to_date := COALESCE(p_to, p_from);

    -- Query signals
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', id,
                'signal_date', signal_date,
                'sleep_quality', sleep_quality,
                'stress_level', stress_level,
                'hydration_score', hydration_score,
                'nutrition_score', nutrition_score,
                'movement_score', movement_score,
                'social_score', social_score,
                'overall_longevity_score', overall_longevity_score,
                'rules_applied', rules_applied,
                'created_at', created_at,
                'updated_at', updated_at
            )
            ORDER BY signal_date DESC
        ),
        '[]'::JSONB
    )
    INTO v_signals
    FROM public.longevity_signals_daily
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND signal_date BETWEEN p_from AND v_to_date;

    RETURN jsonb_build_object(
        'ok', true,
        'from', p_from,
        'to', v_to_date,
        'signals', v_signals,
        'count', jsonb_array_length(v_signals)
    );
END;
$$;

-- ===========================================================================
-- 7. RPC: longevity_explain_daily(p_date date)
-- Returns detailed evidence and rules for a specific date
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.longevity_explain_daily(
    p_date DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_signal RECORD;
    v_diary_entries JSONB;
    v_garden_nodes JSONB;
    v_rules JSONB;
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

    -- Get the signal for the date
    SELECT * INTO v_signal
    FROM public.longevity_signals_daily
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND signal_date = p_date;

    IF v_signal IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'SIGNAL_NOT_FOUND',
            'message', 'No longevity signal found for this date. Run compute first.',
            'date', p_date
        );
    END IF;

    -- Get full diary entries for the date
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', id,
                'raw_text', raw_text,
                'mood', mood,
                'energy_level', energy_level,
                'tags', tags,
                'created_at', created_at
            )
        ),
        '[]'::JSONB
    )
    INTO v_diary_entries
    FROM public.memory_diary_entries
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND entry_date = p_date;

    -- Get garden nodes for the date
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', id,
                'node_type', node_type,
                'label', label,
                'attributes', attributes,
                'confidence', confidence,
                'occurrence_count', occurrence_count
            )
        ),
        '[]'::JSONB
    )
    INTO v_garden_nodes
    FROM public.memory_garden_nodes
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND source = 'diary'
      AND last_seen = p_date;

    -- Get rules that were applied
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'rule_key', rule_key,
                'rule_version', rule_version,
                'domain', domain,
                'logic', logic,
                'weight', weight
            )
        ),
        '[]'::JSONB
    )
    INTO v_rules
    FROM public.longevity_signal_rules
    WHERE rule_key = ANY(v_signal.rules_applied);

    RETURN jsonb_build_object(
        'ok', true,
        'date', p_date,
        'scores', jsonb_build_object(
            'sleep_quality', v_signal.sleep_quality,
            'stress_level', v_signal.stress_level,
            'hydration_score', v_signal.hydration_score,
            'nutrition_score', v_signal.nutrition_score,
            'movement_score', v_signal.movement_score,
            'social_score', v_signal.social_score,
            'overall_longevity_score', v_signal.overall_longevity_score
        ),
        'diary_entries', v_diary_entries,
        'garden_nodes', v_garden_nodes,
        'evidence', v_signal.evidence,
        'rules_applied', v_rules,
        'rules_applied_keys', to_jsonb(v_signal.rules_applied),
        'computed_at', v_signal.updated_at
    );
END;
$$;

-- ===========================================================================
-- 8. Permissions
-- ===========================================================================

-- Grant execute on RPCs to authenticated users
GRANT EXECUTE ON FUNCTION public.longevity_compute_daily(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.longevity_get_daily(DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.longevity_explain_daily(DATE) TO authenticated;

-- Grant table access (RLS enforces row-level security)
GRANT SELECT, INSERT, UPDATE ON public.memory_diary_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.memory_garden_nodes TO authenticated;
GRANT SELECT ON public.longevity_signals_daily TO authenticated;
GRANT SELECT ON public.longevity_signal_rules TO authenticated;

-- ===========================================================================
-- 9. Comments
-- ===========================================================================

COMMENT ON TABLE public.memory_diary_entries IS 'VTID-01082/01083: Structured diary entries with mood, energy, and tags for longevity signal extraction';
COMMENT ON TABLE public.memory_garden_nodes IS 'VTID-01082/01083: Graph-like knowledge nodes extracted from diary and memory for longevity signals';
COMMENT ON TABLE public.longevity_signals_daily IS 'VTID-01083: Daily computed longevity signals (sleep, stress, hydration, nutrition, movement, social)';
COMMENT ON TABLE public.longevity_signal_rules IS 'VTID-01083: Deterministic rule registry for longevity signal computation';

COMMENT ON FUNCTION public.longevity_compute_daily IS 'VTID-01083: Compute daily longevity signals from diary entries and garden nodes. Idempotent.';
COMMENT ON FUNCTION public.longevity_get_daily IS 'VTID-01083: Retrieve daily longevity signals for a date range.';
COMMENT ON FUNCTION public.longevity_explain_daily IS 'VTID-01083: Get detailed evidence and rules for a specific date''s longevity signals.';
