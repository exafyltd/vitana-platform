-- =============================================================================
-- VTID-01088: Matchmaking Engine v1
-- =============================================================================
-- Phase D: Longevity Community Core
--
-- Purpose: Deterministic matchmaking engine that generates matches across:
--   - People <-> People
--   - People <-> Groups
--   - People <-> Events/Meetups
--   - People <-> Services
--   - People <-> Products
--   - People <-> Locations
--   - People <-> Live Rooms
--
-- Dependencies:
--   - VTID-01101 (Phase A Bootstrap - tenants, app_users, user_tenants)
--   - VTID-01104 (Memory Core - memory_items)
--   - VTID-01103 (Health Compute - vitana_index_scores, health_features_daily)
--
-- Key Principles:
--   - All matches are DETERMINISTIC (no AI inference)
--   - All matches are EXPLAINABLE ("Why this match?")
--   - All matches are LONGEVITY-FOCUSED
--   - All matches are CONSENT-SAFE (no exposing identity-sensitive data)
--   - All matches are ROLE-AWARE + TENANT-SCOPED
--   - Recompute is IDEMPOTENT per day
-- =============================================================================

-- ===========================================================================
-- 1. ENUM TYPES
-- ===========================================================================

-- Target types for matchable items
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'match_target_type') THEN
        CREATE TYPE match_target_type AS ENUM (
            'person',
            'group',
            'event',
            'service',
            'product',
            'location',
            'live_room'
        );
    END IF;
END$$;

-- Match state for tracking acceptance
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'match_state') THEN
        CREATE TYPE match_state AS ENUM (
            'suggested',
            'accepted',
            'dismissed'
        );
    END IF;
END$$;

-- Relationship edge types (minimal for VTID-01087 dependency)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'relationship_edge_type') THEN
        CREATE TYPE relationship_edge_type AS ENUM (
            'friend',
            'member',
            'follower',
            'connection',
            'match_accepted'
        );
    END IF;
END$$;

-- Relationship origin (how the relationship was created)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'relationship_origin') THEN
        CREATE TYPE relationship_origin AS ENUM (
            'explicit',
            'autopilot',
            'system',
            'import'
        );
    END IF;
END$$;

-- ===========================================================================
-- 2. TABLE DEFINITIONS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A. match_targets: Normalized pool of matchable items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.match_targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    target_type match_target_type NOT NULL,
    ref_id UUID NOT NULL,
    -- Topic keys for matching (e.g., ["walking", "sleep", "low_sodium"])
    topic_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- Additional tags for filtering
    tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- Flexible metadata (e.g., location, availability, capacity)
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    -- For person targets: display info (privacy-safe)
    display_name TEXT,
    -- Active flag for soft-delete
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Unique constraint: one target per tenant/type/ref combination
    CONSTRAINT match_targets_unique UNIQUE (tenant_id, target_type, ref_id)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_match_targets_tenant_type
    ON public.match_targets (tenant_id, target_type) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_match_targets_tenant_topics
    ON public.match_targets USING gin (topic_keys) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_match_targets_tenant_tags
    ON public.match_targets USING gin (tags) WHERE is_active = true;

-- ---------------------------------------------------------------------------
-- B. matches_daily: Computed match output per user per day
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.matches_daily (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    match_date DATE NOT NULL,
    match_type match_target_type NOT NULL,
    target_id UUID NOT NULL REFERENCES public.match_targets(id) ON DELETE CASCADE,
    -- Score (0-100)
    score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
    -- Deterministic rule trace explaining the match
    reasons JSONB NOT NULL DEFAULT '{}'::JSONB,
    -- Match state
    state match_state NOT NULL DEFAULT 'suggested',
    -- When state was last changed
    state_changed_at TIMESTAMPTZ,
    -- Computation metadata
    rule_version TEXT NOT NULL DEFAULT 'v1',
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Unique constraint: one match per user/date/type/target
    CONSTRAINT matches_daily_unique UNIQUE (tenant_id, user_id, match_date, match_type, target_id)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_matches_daily_tenant_user_date
    ON public.matches_daily (tenant_id, user_id, match_date DESC);
CREATE INDEX IF NOT EXISTS idx_matches_daily_tenant_user_date_type
    ON public.matches_daily (tenant_id, user_id, match_date, match_type);
CREATE INDEX IF NOT EXISTS idx_matches_daily_state
    ON public.matches_daily (tenant_id, state, match_date DESC);

-- ---------------------------------------------------------------------------
-- C. relationship_edges: Graph of user relationships (VTID-01087 minimal)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.relationship_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    -- Source user
    source_user_id UUID NOT NULL,
    -- Target can be user or other entity
    target_user_id UUID,
    target_entity_type match_target_type,
    target_entity_id UUID,
    -- Relationship type and strength
    edge_type relationship_edge_type NOT NULL,
    strength INTEGER NOT NULL DEFAULT 50 CHECK (strength >= 0 AND strength <= 100),
    -- How this relationship was created
    origin relationship_origin NOT NULL DEFAULT 'explicit',
    -- If created from a match, reference the match
    origin_match_id UUID REFERENCES public.matches_daily(id) ON DELETE SET NULL,
    -- Bidirectional flag
    is_bidirectional BOOLEAN NOT NULL DEFAULT false,
    -- Active flag for soft-delete
    is_active BOOLEAN NOT NULL DEFAULT true,
    -- Metadata for additional context
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Ensure either target_user_id OR target_entity is set (not both)
    CONSTRAINT relationship_edges_target_check CHECK (
        (target_user_id IS NOT NULL AND target_entity_type IS NULL AND target_entity_id IS NULL)
        OR (target_user_id IS NULL AND target_entity_type IS NOT NULL AND target_entity_id IS NOT NULL)
    )
);

-- Indexes for graph traversal
CREATE INDEX IF NOT EXISTS idx_relationship_edges_source
    ON public.relationship_edges (tenant_id, source_user_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_relationship_edges_target_user
    ON public.relationship_edges (tenant_id, target_user_id) WHERE is_active = true AND target_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_relationship_edges_target_entity
    ON public.relationship_edges (tenant_id, target_entity_type, target_entity_id) WHERE is_active = true;

-- ---------------------------------------------------------------------------
-- D. user_match_preferences: User preferences for matching
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_match_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    -- Topic preferences (boost or suppress)
    preferred_topics TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    avoided_topics TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- Match type preferences (which types to include)
    enabled_match_types match_target_type[] NOT NULL DEFAULT ARRAY['person', 'group', 'event', 'service']::match_target_type[],
    -- Social preferences
    max_group_size INTEGER DEFAULT 50,
    prefer_smaller_groups BOOLEAN DEFAULT true,
    -- Consent settings
    allow_person_matching BOOLEAN NOT NULL DEFAULT true,
    reveal_identity_mode TEXT NOT NULL DEFAULT 'anonymous' CHECK (reveal_identity_mode IN ('anonymous', 'first_name', 'full')),
    -- Metadata
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT user_match_preferences_unique UNIQUE (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_match_preferences_tenant_user
    ON public.user_match_preferences (tenant_id, user_id);

-- ===========================================================================
-- 3. ROW LEVEL SECURITY
-- ===========================================================================

ALTER TABLE public.match_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relationship_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_match_preferences ENABLE ROW LEVEL SECURITY;

-- RLS Policies for match_targets (read-only for authenticated users in tenant)
CREATE POLICY match_targets_select_policy ON public.match_targets
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id());

CREATE POLICY match_targets_insert_policy ON public.match_targets
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY match_targets_update_policy ON public.match_targets
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id());

-- RLS Policies for matches_daily (users see only their own matches)
CREATE POLICY matches_daily_user_policy ON public.matches_daily
    FOR ALL TO authenticated
    USING (user_id = auth.uid() AND tenant_id = public.current_tenant_id());

-- RLS Policies for relationship_edges (users see their own edges)
CREATE POLICY relationship_edges_source_policy ON public.relationship_edges
    FOR ALL TO authenticated
    USING (source_user_id = auth.uid() AND tenant_id = public.current_tenant_id());

CREATE POLICY relationship_edges_target_policy ON public.relationship_edges
    FOR SELECT TO authenticated
    USING (target_user_id = auth.uid() AND tenant_id = public.current_tenant_id());

-- RLS Policies for user_match_preferences (users see only their own preferences)
CREATE POLICY user_match_preferences_user_policy ON public.user_match_preferences
    FOR ALL TO authenticated
    USING (user_id = auth.uid() AND tenant_id = public.current_tenant_id());

-- ===========================================================================
-- 4. HELPER FUNCTIONS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Get user topic keys from memory items (longevity-focused categories)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_get_user_topics(p_user_id UUID, p_tenant_id UUID)
RETURNS TEXT[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_topics TEXT[] := ARRAY[]::TEXT[];
    v_item RECORD;
BEGIN
    -- Extract topics from memory items in relevant categories
    FOR v_item IN
        SELECT content, content_json, category_key
        FROM public.memory_items
        WHERE user_id = p_user_id
          AND tenant_id = p_tenant_id
          AND category_key IN ('health', 'community', 'goals', 'preferences')
          AND occurred_at >= NOW() - INTERVAL '30 days'
        ORDER BY occurred_at DESC
        LIMIT 100
    LOOP
        -- Extract topic keys from content_json if present
        IF v_item.content_json ? 'topic_keys' THEN
            v_topics := v_topics || ARRAY(SELECT jsonb_array_elements_text(v_item.content_json->'topic_keys'));
        END IF;

        -- Extract from tags if present
        IF v_item.content_json ? 'tags' THEN
            v_topics := v_topics || ARRAY(SELECT jsonb_array_elements_text(v_item.content_json->'tags'));
        END IF;
    END LOOP;

    -- Deduplicate
    SELECT ARRAY(SELECT DISTINCT unnest(v_topics)) INTO v_topics;

    RETURN v_topics;
END;
$$;

-- ---------------------------------------------------------------------------
-- Get longevity signal deltas for scoring
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_get_longevity_deltas(p_user_id UUID, p_tenant_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_deltas JSONB := '{}'::JSONB;
    v_recent RECORD;
    v_previous RECORD;
    v_feature_key TEXT;
    v_recent_val NUMERIC;
    v_previous_val NUMERIC;
    v_delta NUMERIC;
BEGIN
    -- Get most recent 7-day features
    FOR v_recent IN
        SELECT feature_key, AVG(feature_value) as avg_value
        FROM public.health_features_daily
        WHERE user_id = p_user_id
          AND tenant_id = p_tenant_id
          AND date >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY feature_key
    LOOP
        v_feature_key := v_recent.feature_key;
        v_recent_val := v_recent.avg_value;

        -- Get previous 7-day average for comparison
        SELECT AVG(feature_value) INTO v_previous_val
        FROM public.health_features_daily
        WHERE user_id = p_user_id
          AND tenant_id = p_tenant_id
          AND feature_key = v_feature_key
          AND date >= CURRENT_DATE - INTERVAL '14 days'
          AND date < CURRENT_DATE - INTERVAL '7 days';

        IF v_previous_val IS NOT NULL AND v_previous_val != 0 THEN
            v_delta := ((v_recent_val - v_previous_val) / v_previous_val) * 100;
            v_deltas := v_deltas || jsonb_build_object(
                v_feature_key, jsonb_build_object(
                    'recent', v_recent_val,
                    'previous', v_previous_val,
                    'delta_pct', ROUND(v_delta, 2),
                    'trend', CASE
                        WHEN v_delta > 5 THEN 'improving'
                        WHEN v_delta < -5 THEN 'declining'
                        ELSE 'stable'
                    END
                )
            );
        END IF;
    END LOOP;

    RETURN v_deltas;
END;
$$;

-- ---------------------------------------------------------------------------
-- Get relationship proximity score for a target
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_get_relationship_proximity(
    p_user_id UUID,
    p_tenant_id UUID,
    p_target_user_id UUID DEFAULT NULL,
    p_target_entity_type match_target_type DEFAULT NULL,
    p_target_entity_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_result JSONB := jsonb_build_object('score', 0, 'edges', '[]'::JSONB);
    v_edge RECORD;
    v_score INTEGER := 0;
    v_edges JSONB := '[]'::JSONB;
BEGIN
    -- Direct connection check
    IF p_target_user_id IS NOT NULL THEN
        SELECT id, edge_type, strength INTO v_edge
        FROM public.relationship_edges
        WHERE tenant_id = p_tenant_id
          AND source_user_id = p_user_id
          AND target_user_id = p_target_user_id
          AND is_active = true
        LIMIT 1;

        IF v_edge.id IS NOT NULL THEN
            v_score := LEAST(15, v_edge.strength / 7); -- Scale to 0-15
            v_edges := v_edges || jsonb_build_object(
                'edge_id', v_edge.id,
                'type', v_edge.edge_type,
                'direct', true
            );
        END IF;
    ELSIF p_target_entity_type IS NOT NULL AND p_target_entity_id IS NOT NULL THEN
        -- Check for entity relationship
        SELECT id, edge_type, strength INTO v_edge
        FROM public.relationship_edges
        WHERE tenant_id = p_tenant_id
          AND source_user_id = p_user_id
          AND target_entity_type = p_target_entity_type
          AND target_entity_id = p_target_entity_id
          AND is_active = true
        LIMIT 1;

        IF v_edge.id IS NOT NULL THEN
            v_score := LEAST(15, v_edge.strength / 7);
            v_edges := v_edges || jsonb_build_object(
                'edge_id', v_edge.id,
                'type', v_edge.edge_type,
                'direct', true
            );
        END IF;
    END IF;

    RETURN jsonb_build_object('score', v_score, 'edges', v_edges);
END;
$$;

-- ===========================================================================
-- 5. SCORING FUNCTION (v1 Deterministic Rules)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.match_compute_score(
    p_user_id UUID,
    p_tenant_id UUID,
    p_target_id UUID,
    p_user_topics TEXT[],
    p_longevity_deltas JSONB,
    p_user_prefs JSONB,
    p_recent_match_types match_target_type[]
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_target RECORD;
    v_score INTEGER := 0;
    v_reasons JSONB := '{"components": []}'::JSONB;
    v_component JSONB;

    -- Score components (v1 rules)
    v_topic_score INTEGER := 0;
    v_longevity_score INTEGER := 0;
    v_relationship_score INTEGER := 0;
    v_diversity_score INTEGER := 0;
    v_social_score INTEGER := 0;

    -- Intermediates
    v_topic_overlap TEXT[];
    v_proximity JSONB;
    v_social_score_val INTEGER;
BEGIN
    -- Fetch target
    SELECT * INTO v_target
    FROM public.match_targets
    WHERE id = p_target_id AND tenant_id = p_tenant_id AND is_active = true;

    IF v_target.id IS NULL THEN
        RETURN jsonb_build_object('score', 0, 'reasons', jsonb_build_object('error', 'TARGET_NOT_FOUND'));
    END IF;

    -- ---------------------------------------------------------------------------
    -- 1. TOPIC OVERLAP (0-50 points)
    -- ---------------------------------------------------------------------------
    SELECT ARRAY(
        SELECT unnest(p_user_topics)
        INTERSECT
        SELECT unnest(v_target.topic_keys)
    ) INTO v_topic_overlap;

    v_topic_score := LEAST(50, ARRAY_LENGTH(v_topic_overlap, 1) * 10);
    IF v_topic_score IS NULL THEN v_topic_score := 0; END IF;

    v_component := jsonb_build_object(
        'component', 'topic_overlap',
        'score', v_topic_score,
        'max', 50,
        'matched_topics', v_topic_overlap,
        'rule', 'v1: 10 points per matched topic, max 50'
    );
    v_reasons := jsonb_set(v_reasons, '{components}', (v_reasons->'components') || v_component);

    -- ---------------------------------------------------------------------------
    -- 2. LONGEVITY RELEVANCE (0-20 points)
    -- ---------------------------------------------------------------------------
    -- Check if user has declining signals that match target topics
    IF p_longevity_deltas IS NOT NULL AND p_longevity_deltas != '{}'::JSONB THEN
        -- Sleep-related boost
        IF (p_longevity_deltas->'sleep_hours'->>'trend' = 'declining'
            OR p_longevity_deltas->'sleep_quality'->>'trend' = 'declining')
           AND ('sleep' = ANY(v_target.topic_keys) OR 'rest' = ANY(v_target.topic_keys)) THEN
            v_longevity_score := v_longevity_score + 10;
        END IF;

        -- Activity-related boost
        IF (p_longevity_deltas->'total_steps'->>'trend' = 'declining'
            OR p_longevity_deltas->'activity_minutes'->>'trend' = 'declining')
           AND ('walking' = ANY(v_target.topic_keys) OR 'exercise' = ANY(v_target.topic_keys) OR 'fitness' = ANY(v_target.topic_keys)) THEN
            v_longevity_score := v_longevity_score + 10;
        END IF;

        -- Stress-related boost
        IF (p_longevity_deltas->'stress_score'->>'trend' = 'declining' -- higher stress
            OR p_longevity_deltas->'hrv_rmssd'->>'trend' = 'declining')
           AND ('meditation' = ANY(v_target.topic_keys) OR 'relaxation' = ANY(v_target.topic_keys) OR 'mindfulness' = ANY(v_target.topic_keys)) THEN
            v_longevity_score := v_longevity_score + 10;
        END IF;
    END IF;

    v_longevity_score := LEAST(20, v_longevity_score);

    v_component := jsonb_build_object(
        'component', 'longevity_relevance',
        'score', v_longevity_score,
        'max', 20,
        'deltas_used', p_longevity_deltas,
        'rule', 'v1: +10 per declining signal matching target topics, max 20'
    );
    v_reasons := jsonb_set(v_reasons, '{components}', (v_reasons->'components') || v_component);

    -- ---------------------------------------------------------------------------
    -- 3. RELATIONSHIP PROXIMITY (0-15 points)
    -- ---------------------------------------------------------------------------
    IF v_target.target_type = 'person' THEN
        v_proximity := public.match_get_relationship_proximity(
            p_user_id, p_tenant_id, v_target.ref_id, NULL, NULL
        );
    ELSE
        v_proximity := public.match_get_relationship_proximity(
            p_user_id, p_tenant_id, NULL, v_target.target_type, v_target.ref_id
        );
    END IF;

    v_relationship_score := COALESCE((v_proximity->>'score')::INTEGER, 0);

    v_component := jsonb_build_object(
        'component', 'relationship_proximity',
        'score', v_relationship_score,
        'max', 15,
        'edges', v_proximity->'edges',
        'rule', 'v1: scaled from edge strength, max 15'
    );
    v_reasons := jsonb_set(v_reasons, '{components}', (v_reasons->'components') || v_component);

    -- ---------------------------------------------------------------------------
    -- 4. DIVERSITY CONTROL (0-10 points)
    -- ---------------------------------------------------------------------------
    -- Boost targets of types not recently matched
    IF NOT (v_target.target_type = ANY(p_recent_match_types)) THEN
        v_diversity_score := 10;
    ELSIF ARRAY_LENGTH(p_recent_match_types, 1) IS NULL THEN
        v_diversity_score := 5; -- First time matching
    ELSE
        v_diversity_score := 0;
    END IF;

    v_component := jsonb_build_object(
        'component', 'diversity_control',
        'score', v_diversity_score,
        'max', 10,
        'recent_types', p_recent_match_types,
        'target_type', v_target.target_type,
        'rule', 'v1: +10 if type not in recent matches'
    );
    v_reasons := jsonb_set(v_reasons, '{components}', (v_reasons->'components') || v_component);

    -- ---------------------------------------------------------------------------
    -- 5. SOCIAL FIT (0-5 points)
    -- ---------------------------------------------------------------------------
    -- Check user's social score from Vitana Index
    SELECT score_social INTO v_social_score_val
    FROM public.vitana_index_scores
    WHERE user_id = p_user_id AND tenant_id = p_tenant_id
    ORDER BY date DESC
    LIMIT 1;

    -- If low social score, prefer smaller groups/events
    IF v_social_score_val IS NOT NULL AND v_social_score_val < 100 THEN
        -- Check target metadata for group size
        IF (v_target.metadata->>'max_participants')::INTEGER <= 10
           OR v_target.target_type = 'person' THEN
            v_social_score := 5;
        ELSIF (v_target.metadata->>'max_participants')::INTEGER <= 20 THEN
            v_social_score := 3;
        ELSE
            v_social_score := 0;
        END IF;
    ELSE
        v_social_score := 3; -- Neutral for users with higher social scores
    END IF;

    v_component := jsonb_build_object(
        'component', 'social_fit',
        'score', v_social_score,
        'max', 5,
        'user_social_score', v_social_score_val,
        'target_size', v_target.metadata->>'max_participants',
        'rule', 'v1: prefer smaller groups for low social scores'
    );
    v_reasons := jsonb_set(v_reasons, '{components}', (v_reasons->'components') || v_component);

    -- ---------------------------------------------------------------------------
    -- TOTAL SCORE
    -- ---------------------------------------------------------------------------
    v_score := LEAST(100, v_topic_score + v_longevity_score + v_relationship_score + v_diversity_score + v_social_score);

    v_reasons := v_reasons || jsonb_build_object(
        'total_score', v_score,
        'target_type', v_target.target_type,
        'target_ref_id', v_target.ref_id,
        'rule_version', 'v1'
    );

    RETURN jsonb_build_object('score', v_score, 'reasons', v_reasons);
END;
$$;

-- ===========================================================================
-- 6. MAIN RPC FUNCTIONS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- match_recompute_daily: Generate daily matches for a user
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_recompute_daily(
    p_user_id UUID DEFAULT NULL,
    p_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_user_topics TEXT[];
    v_longevity_deltas JSONB;
    v_user_prefs JSONB;
    v_recent_types match_target_type[];
    v_target RECORD;
    v_score_result JSONB;
    v_counts JSONB := '{}'::JSONB;
    v_type_counts RECORD;
    v_inserted_count INTEGER := 0;
    v_top_n INTEGER := 10; -- Max matches per type
    v_enabled_types match_target_type[];
BEGIN
    -- Derive user_id from auth if not provided
    v_user_id := COALESCE(p_user_id, auth.uid());
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    -- Get user preferences
    SELECT jsonb_build_object(
        'preferred_topics', preferred_topics,
        'avoided_topics', avoided_topics,
        'enabled_match_types', enabled_match_types,
        'max_group_size', max_group_size,
        'prefer_smaller_groups', prefer_smaller_groups,
        'allow_person_matching', allow_person_matching
    ) INTO v_user_prefs
    FROM public.user_match_preferences
    WHERE user_id = v_user_id AND tenant_id = v_tenant_id;

    -- Default preferences if none set
    IF v_user_prefs IS NULL THEN
        v_user_prefs := jsonb_build_object(
            'preferred_topics', ARRAY[]::TEXT[],
            'avoided_topics', ARRAY[]::TEXT[],
            'enabled_match_types', ARRAY['person', 'group', 'event', 'service']::match_target_type[],
            'max_group_size', 50,
            'prefer_smaller_groups', true,
            'allow_person_matching', true
        );
    END IF;

    v_enabled_types := ARRAY(SELECT jsonb_array_elements_text(v_user_prefs->'enabled_match_types'))::match_target_type[];

    -- Get user's topics
    v_user_topics := public.match_get_user_topics(v_user_id, v_tenant_id);

    -- Add preferred topics
    IF v_user_prefs->'preferred_topics' IS NOT NULL THEN
        v_user_topics := v_user_topics || ARRAY(SELECT jsonb_array_elements_text(v_user_prefs->'preferred_topics'));
    END IF;

    -- Deduplicate topics
    SELECT ARRAY(SELECT DISTINCT unnest(v_user_topics)) INTO v_user_topics;

    -- Get longevity deltas
    v_longevity_deltas := public.match_get_longevity_deltas(v_user_id, v_tenant_id);

    -- Get recently matched types (last 3 days) for diversity
    SELECT ARRAY_AGG(DISTINCT match_type) INTO v_recent_types
    FROM public.matches_daily
    WHERE user_id = v_user_id
      AND tenant_id = v_tenant_id
      AND match_date >= p_date - INTERVAL '3 days'
      AND state = 'accepted';

    -- Delete existing suggested matches for this date (idempotency)
    DELETE FROM public.matches_daily
    WHERE user_id = v_user_id
      AND tenant_id = v_tenant_id
      AND match_date = p_date
      AND state = 'suggested';

    -- Process each enabled match type
    FOR v_target IN
        SELECT mt.*
        FROM public.match_targets mt
        WHERE mt.tenant_id = v_tenant_id
          AND mt.is_active = true
          AND mt.target_type = ANY(v_enabled_types)
          -- Exclude self for person matching
          AND (mt.target_type != 'person' OR mt.ref_id != v_user_id)
          -- Check person matching consent
          AND (
              mt.target_type != 'person'
              OR (v_user_prefs->>'allow_person_matching')::BOOLEAN = true
          )
          -- Exclude already dismissed today
          AND NOT EXISTS (
              SELECT 1 FROM public.matches_daily md
              WHERE md.user_id = v_user_id
                AND md.tenant_id = v_tenant_id
                AND md.match_date = p_date
                AND md.target_id = mt.id
                AND md.state = 'dismissed'
          )
        ORDER BY mt.target_type, mt.created_at
    LOOP
        -- Compute score for this target
        v_score_result := public.match_compute_score(
            v_user_id,
            v_tenant_id,
            v_target.id,
            v_user_topics,
            v_longevity_deltas,
            v_user_prefs,
            COALESCE(v_recent_types, ARRAY[]::match_target_type[])
        );

        -- Only include matches with score >= 20
        IF (v_score_result->>'score')::INTEGER >= 20 THEN
            -- Insert match (will respect top N per type in final cleanup)
            INSERT INTO public.matches_daily (
                tenant_id,
                user_id,
                match_date,
                match_type,
                target_id,
                score,
                reasons,
                state,
                rule_version,
                computed_at
            ) VALUES (
                v_tenant_id,
                v_user_id,
                p_date,
                v_target.target_type,
                v_target.id,
                (v_score_result->>'score')::INTEGER,
                v_score_result->'reasons',
                'suggested',
                'v1',
                NOW()
            )
            ON CONFLICT (tenant_id, user_id, match_date, match_type, target_id)
            DO UPDATE SET
                score = EXCLUDED.score,
                reasons = EXCLUDED.reasons,
                rule_version = EXCLUDED.rule_version,
                computed_at = EXCLUDED.computed_at;

            v_inserted_count := v_inserted_count + 1;
        END IF;
    END LOOP;

    -- Keep only top N per type (delete lower-scored matches)
    WITH ranked_matches AS (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY match_type ORDER BY score DESC) as rn
        FROM public.matches_daily
        WHERE user_id = v_user_id
          AND tenant_id = v_tenant_id
          AND match_date = p_date
          AND state = 'suggested'
    )
    DELETE FROM public.matches_daily
    WHERE id IN (SELECT id FROM ranked_matches WHERE rn > v_top_n);

    -- Get counts per type
    SELECT jsonb_object_agg(match_type::TEXT, cnt) INTO v_counts
    FROM (
        SELECT match_type, COUNT(*) as cnt
        FROM public.matches_daily
        WHERE user_id = v_user_id
          AND tenant_id = v_tenant_id
          AND match_date = p_date
        GROUP BY match_type
    ) t;

    RETURN jsonb_build_object(
        'ok', true,
        'user_id', v_user_id,
        'tenant_id', v_tenant_id,
        'date', p_date,
        'counts', COALESCE(v_counts, '{}'::JSONB),
        'user_topics', v_user_topics,
        'rule_version', 'v1'
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- match_get_daily: Retrieve daily matches for a user
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_get_daily(
    p_user_id UUID DEFAULT NULL,
    p_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_matches JSONB;
    v_prefs RECORD;
BEGIN
    -- Derive user_id from auth if not provided
    v_user_id := COALESCE(p_user_id, auth.uid());
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    -- Get user's reveal identity mode
    SELECT reveal_identity_mode INTO v_prefs
    FROM public.user_match_preferences
    WHERE user_id = v_user_id AND tenant_id = v_tenant_id;

    -- Build matches response with privacy-safe previews
    SELECT jsonb_object_agg(
        match_type::TEXT,
        matches
    ) INTO v_matches
    FROM (
        SELECT
            match_type,
            jsonb_agg(
                jsonb_build_object(
                    'id', md.id,
                    'target_id', md.target_id,
                    'score', md.score,
                    'state', md.state,
                    'reasons', md.reasons,
                    'computed_at', md.computed_at,
                    'preview', CASE
                        WHEN mt.target_type = 'person' THEN
                            jsonb_build_object(
                                'type', 'person',
                                'display_name', CASE
                                    WHEN COALESCE(v_prefs.reveal_identity_mode, 'anonymous') = 'anonymous'
                                    THEN 'Member #' || SUBSTRING(mt.ref_id::TEXT, 1, 8)
                                    WHEN COALESCE(v_prefs.reveal_identity_mode, 'anonymous') = 'first_name'
                                    THEN COALESCE(mt.display_name, 'Member')
                                    ELSE COALESCE(mt.display_name, 'Member')
                                END,
                                'shared_topics', (
                                    SELECT jsonb_agg(t)
                                    FROM (
                                        SELECT unnest(mt.topic_keys) as t
                                        LIMIT 5
                                    ) topics
                                ),
                                'tags', mt.tags
                            )
                        ELSE
                            jsonb_build_object(
                                'type', mt.target_type,
                                'display_name', COALESCE(mt.display_name, mt.target_type::TEXT),
                                'topic_keys', mt.topic_keys,
                                'tags', mt.tags,
                                'metadata', mt.metadata - 'internal' -- Remove internal metadata
                            )
                    END
                )
                ORDER BY md.score DESC
            ) as matches
        FROM public.matches_daily md
        JOIN public.match_targets mt ON mt.id = md.target_id
        WHERE md.user_id = v_user_id
          AND md.tenant_id = v_tenant_id
          AND md.match_date = p_date
        GROUP BY md.match_type
    ) grouped;

    RETURN jsonb_build_object(
        'ok', true,
        'user_id', v_user_id,
        'date', p_date,
        'matches', COALESCE(v_matches, '{}'::JSONB)
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- match_set_state: Update match state (accept/dismiss)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_set_state(
    p_match_id UUID,
    p_state TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_match RECORD;
    v_target RECORD;
    v_edge_id UUID;
BEGIN
    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    -- Validate state
    IF p_state NOT IN ('suggested', 'accepted', 'dismissed') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATE');
    END IF;

    -- Fetch match (verify ownership)
    SELECT * INTO v_match
    FROM public.matches_daily
    WHERE id = p_match_id
      AND user_id = v_user_id
      AND tenant_id = v_tenant_id;

    IF v_match.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'MATCH_NOT_FOUND');
    END IF;

    -- Update state
    UPDATE public.matches_daily
    SET state = p_state::match_state,
        state_changed_at = NOW()
    WHERE id = p_match_id;

    -- If accepted, create relationship edge
    IF p_state = 'accepted' THEN
        -- Fetch target details
        SELECT * INTO v_target
        FROM public.match_targets
        WHERE id = v_match.target_id;

        IF v_target.target_type = 'person' THEN
            -- Create person-to-person edge
            INSERT INTO public.relationship_edges (
                tenant_id,
                source_user_id,
                target_user_id,
                edge_type,
                strength,
                origin,
                origin_match_id,
                metadata
            ) VALUES (
                v_tenant_id,
                v_user_id,
                v_target.ref_id,
                'match_accepted',
                50,
                'autopilot',
                v_match.id,
                jsonb_build_object(
                    'match_score', v_match.score,
                    'match_date', v_match.match_date
                )
            )
            ON CONFLICT DO NOTHING
            RETURNING id INTO v_edge_id;
        ELSE
            -- Create person-to-entity edge
            INSERT INTO public.relationship_edges (
                tenant_id,
                source_user_id,
                target_entity_type,
                target_entity_id,
                edge_type,
                strength,
                origin,
                origin_match_id,
                metadata
            ) VALUES (
                v_tenant_id,
                v_user_id,
                v_target.target_type,
                v_target.ref_id,
                'match_accepted',
                50,
                'autopilot',
                v_match.id,
                jsonb_build_object(
                    'match_score', v_match.score,
                    'match_date', v_match.match_date
                )
            )
            ON CONFLICT DO NOTHING
            RETURNING id INTO v_edge_id;
        END IF;

        RETURN jsonb_build_object(
            'ok', true,
            'match_id', p_match_id,
            'state', p_state,
            'edge_created', v_edge_id IS NOT NULL,
            'edge_id', v_edge_id
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'match_id', p_match_id,
        'state', p_state
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- match_register_target: Register a new matchable target
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_register_target(
    p_target_type match_target_type,
    p_ref_id UUID,
    p_topic_keys TEXT[] DEFAULT ARRAY[]::TEXT[],
    p_tags TEXT[] DEFAULT ARRAY[]::TEXT[],
    p_metadata JSONB DEFAULT '{}'::JSONB,
    p_display_name TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_target_id UUID;
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    -- Upsert target
    INSERT INTO public.match_targets (
        tenant_id,
        target_type,
        ref_id,
        topic_keys,
        tags,
        metadata,
        display_name,
        is_active
    ) VALUES (
        v_tenant_id,
        p_target_type,
        p_ref_id,
        p_topic_keys,
        p_tags,
        p_metadata,
        p_display_name,
        true
    )
    ON CONFLICT (tenant_id, target_type, ref_id) DO UPDATE SET
        topic_keys = EXCLUDED.topic_keys,
        tags = EXCLUDED.tags,
        metadata = EXCLUDED.metadata,
        display_name = EXCLUDED.display_name,
        is_active = true,
        updated_at = NOW()
    RETURNING id INTO v_target_id;

    RETURN jsonb_build_object(
        'ok', true,
        'target_id', v_target_id,
        'target_type', p_target_type,
        'ref_id', p_ref_id
    );
END;
$$;

-- ===========================================================================
-- 7. GRANTS
-- ===========================================================================

-- Table grants
GRANT SELECT ON public.match_targets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.matches_daily TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.relationship_edges TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_match_preferences TO authenticated;

-- Function grants
GRANT EXECUTE ON FUNCTION public.match_get_user_topics(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_get_longevity_deltas(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_get_relationship_proximity(UUID, UUID, UUID, match_target_type, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_compute_score(UUID, UUID, UUID, TEXT[], JSONB, JSONB, match_target_type[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_recompute_daily(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_get_daily(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_set_state(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_register_target(match_target_type, UUID, TEXT[], TEXT[], JSONB, TEXT) TO authenticated;

-- ===========================================================================
-- 8. COMMENTS
-- ===========================================================================

COMMENT ON TABLE public.match_targets IS 'VTID-01088: Normalized pool of matchable items (people, groups, events, services, products, locations, live_rooms)';
COMMENT ON TABLE public.matches_daily IS 'VTID-01088: Computed daily match suggestions per user';
COMMENT ON TABLE public.relationship_edges IS 'VTID-01087/01088: Graph of user relationships for proximity scoring';
COMMENT ON TABLE public.user_match_preferences IS 'VTID-01088: User preferences for matchmaking';
COMMENT ON FUNCTION public.match_recompute_daily IS 'VTID-01088: Recompute daily matches for a user (idempotent)';
COMMENT ON FUNCTION public.match_get_daily IS 'VTID-01088: Get daily matches with privacy-safe previews';
COMMENT ON FUNCTION public.match_set_state IS 'VTID-01088: Accept or dismiss a match (creates relationship edge on accept)';
