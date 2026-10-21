-- Migration: 20251231000001_vtid_01094_match_feedback_loop.sql
-- Purpose: VTID-01094 Match Quality Feedback Loop
-- Date: 2025-12-31
--
-- Creates tables and RPC functions for the match quality feedback loop system:
--   - matches_daily: Daily match recommendations (dependency for VTID-01088)
--   - user_topic_profile: User topic affinity scores (dependency for VTID-01093)
--   - relationship_edges: User relationship graph edges (dependency for VTID-01087)
--   - match_feedback: User feedback on matches
--   - personalization_change_log: "Why improved?" history trail
--   - user_blocklist: Blocked users with expiry
--   - user_dampening: Temporary dampening flags
--
-- Deterministic Update Rules (v1):
--   - like: +8 to matched topics, +10 to relationship edge
--   - dislike: -6 to matched topics (floor 0), 7-day dampening
--   - block: -10 to matched topics, 90-day blocklist entry
--   - wrong_topic: -6 to detected topics, +10 to provided topic
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01088 (matches_daily) - created here
--   - VTID-01093 (user_topic_profile) - created here
--   - VTID-01087 (relationship_edges) - created here

-- ===========================================================================
-- 1. MATCHES_DAILY TABLE (VTID-01088 dependency)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.matches_daily (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    target_user_id UUID NOT NULL,
    match_date DATE NOT NULL DEFAULT CURRENT_DATE,
    score NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (score >= 0 AND score <= 100),
    topics TEXT[] NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'dismissed', 'expired')),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id, target_user_id, match_date)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_matches_daily_tenant_user_date
    ON public.matches_daily (tenant_id, user_id, match_date DESC);
CREATE INDEX IF NOT EXISTS idx_matches_daily_tenant_user_state
    ON public.matches_daily (tenant_id, user_id, state);
CREATE INDEX IF NOT EXISTS idx_matches_daily_target
    ON public.matches_daily (tenant_id, target_user_id);

-- Enable RLS
ALTER TABLE public.matches_daily ENABLE ROW LEVEL SECURITY;

-- RLS policies
DROP POLICY IF EXISTS matches_daily_select ON public.matches_daily;
CREATE POLICY matches_daily_select ON public.matches_daily
    FOR SELECT TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS matches_daily_update ON public.matches_daily;
CREATE POLICY matches_daily_update ON public.matches_daily
    FOR UPDATE TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    )
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS matches_daily_all_service_role ON public.matches_daily;
CREATE POLICY matches_daily_all_service_role ON public.matches_daily
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.matches_daily IS 'VTID-01088/01094: Daily match recommendations with state tracking';

-- ===========================================================================
-- 2. USER_TOPIC_PROFILE TABLE (VTID-01093 dependency)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.user_topic_profile (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    topic_key TEXT NOT NULL,
    score INT NOT NULL DEFAULT 50 CHECK (score >= 0 AND score <= 100),
    source TEXT NOT NULL DEFAULT 'system' CHECK (source IN ('system', 'explicit', 'feedback', 'inferred')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id, topic_key)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_user_topic_profile_tenant_user
    ON public.user_topic_profile (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_user_topic_profile_tenant_user_score
    ON public.user_topic_profile (tenant_id, user_id, score DESC);

-- Enable RLS
ALTER TABLE public.user_topic_profile ENABLE ROW LEVEL SECURITY;

-- RLS policies
DROP POLICY IF EXISTS user_topic_profile_select ON public.user_topic_profile;
CREATE POLICY user_topic_profile_select ON public.user_topic_profile
    FOR SELECT TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS user_topic_profile_insert ON public.user_topic_profile;
CREATE POLICY user_topic_profile_insert ON public.user_topic_profile
    FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS user_topic_profile_update ON public.user_topic_profile;
CREATE POLICY user_topic_profile_update ON public.user_topic_profile
    FOR UPDATE TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    )
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS user_topic_profile_all_service_role ON public.user_topic_profile;
CREATE POLICY user_topic_profile_all_service_role ON public.user_topic_profile
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.user_topic_profile IS 'VTID-01093/01094: User topic affinity scores for personalization';

-- ===========================================================================
-- 3. RELATIONSHIP_EDGES TABLE (VTID-01087 dependency)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.relationship_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    source_user_id UUID NOT NULL,
    target_user_id UUID NOT NULL,
    edge_type TEXT NOT NULL DEFAULT 'connection' CHECK (edge_type IN ('connection', 'follow', 'match', 'friend')),
    strength INT NOT NULL DEFAULT 0 CHECK (strength >= -100 AND strength <= 100),
    context JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, source_user_id, target_user_id, edge_type)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_relationship_edges_tenant_source
    ON public.relationship_edges (tenant_id, source_user_id);
CREATE INDEX IF NOT EXISTS idx_relationship_edges_tenant_target
    ON public.relationship_edges (tenant_id, target_user_id);
CREATE INDEX IF NOT EXISTS idx_relationship_edges_strength
    ON public.relationship_edges (tenant_id, source_user_id, strength DESC);

-- Enable RLS
ALTER TABLE public.relationship_edges ENABLE ROW LEVEL SECURITY;

-- RLS policies (user can see edges they are part of)
DROP POLICY IF EXISTS relationship_edges_select ON public.relationship_edges;
CREATE POLICY relationship_edges_select ON public.relationship_edges
    FOR SELECT TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND (
            source_user_id = public.current_user_id()
            OR target_user_id = public.current_user_id()
        )
    );

DROP POLICY IF EXISTS relationship_edges_insert ON public.relationship_edges;
CREATE POLICY relationship_edges_insert ON public.relationship_edges
    FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND source_user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS relationship_edges_update ON public.relationship_edges;
CREATE POLICY relationship_edges_update ON public.relationship_edges
    FOR UPDATE TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND source_user_id = public.current_user_id()
    )
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND source_user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS relationship_edges_all_service_role ON public.relationship_edges;
CREATE POLICY relationship_edges_all_service_role ON public.relationship_edges
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.relationship_edges IS 'VTID-01087/01094: User relationship graph edges with strength scores';

-- ===========================================================================
-- 4. MATCH_FEEDBACK TABLE (VTID-01094 core)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.match_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    match_id UUID NOT NULL REFERENCES public.matches_daily(id) ON DELETE CASCADE,
    feedback_type TEXT NOT NULL CHECK (feedback_type IN ('like', 'dislike', 'block', 'wrong_topic')),
    topic_key TEXT NULL, -- for wrong_topic feedback
    note TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id, match_id, feedback_type)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_match_feedback_tenant_user
    ON public.match_feedback (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_match_feedback_match_id
    ON public.match_feedback (match_id);
CREATE INDEX IF NOT EXISTS idx_match_feedback_type
    ON public.match_feedback (tenant_id, user_id, feedback_type);

-- Enable RLS
ALTER TABLE public.match_feedback ENABLE ROW LEVEL SECURITY;

-- RLS policies
DROP POLICY IF EXISTS match_feedback_select ON public.match_feedback;
CREATE POLICY match_feedback_select ON public.match_feedback
    FOR SELECT TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS match_feedback_insert ON public.match_feedback;
CREATE POLICY match_feedback_insert ON public.match_feedback
    FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS match_feedback_all_service_role ON public.match_feedback;
CREATE POLICY match_feedback_all_service_role ON public.match_feedback
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.match_feedback IS 'VTID-01094: User feedback on match recommendations';

-- ===========================================================================
-- 5. PERSONALIZATION_CHANGE_LOG TABLE (VTID-01094 "Why improved?")
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.personalization_change_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    change_date DATE NOT NULL DEFAULT CURRENT_DATE,
    source TEXT NOT NULL DEFAULT 'match_feedback' CHECK (source IN ('match_feedback', 'explicit', 'system')),
    changes JSONB NOT NULL, -- {topic_key, delta, reason, match_id}
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_personalization_change_log_tenant_user_date
    ON public.personalization_change_log (tenant_id, user_id, change_date DESC);
CREATE INDEX IF NOT EXISTS idx_personalization_change_log_created
    ON public.personalization_change_log (tenant_id, user_id, created_at DESC);

-- Enable RLS
ALTER TABLE public.personalization_change_log ENABLE ROW LEVEL SECURITY;

-- RLS policies
DROP POLICY IF EXISTS personalization_change_log_select ON public.personalization_change_log;
CREATE POLICY personalization_change_log_select ON public.personalization_change_log
    FOR SELECT TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS personalization_change_log_insert ON public.personalization_change_log;
CREATE POLICY personalization_change_log_insert ON public.personalization_change_log
    FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS personalization_change_log_all_service_role ON public.personalization_change_log;
CREATE POLICY personalization_change_log_all_service_role ON public.personalization_change_log
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.personalization_change_log IS 'VTID-01094: "Why improved?" history trail for personalization changes';

-- ===========================================================================
-- 6. USER_BLOCKLIST TABLE (VTID-01094 block functionality)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.user_blocklist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    blocked_user_id UUID NOT NULL,
    reason TEXT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id, blocked_user_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_user_blocklist_tenant_user
    ON public.user_blocklist (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_user_blocklist_expires
    ON public.user_blocklist (tenant_id, user_id, expires_at);

-- Enable RLS
ALTER TABLE public.user_blocklist ENABLE ROW LEVEL SECURITY;

-- RLS policies
DROP POLICY IF EXISTS user_blocklist_select ON public.user_blocklist;
CREATE POLICY user_blocklist_select ON public.user_blocklist
    FOR SELECT TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS user_blocklist_insert ON public.user_blocklist;
CREATE POLICY user_blocklist_insert ON public.user_blocklist
    FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS user_blocklist_delete ON public.user_blocklist;
CREATE POLICY user_blocklist_delete ON public.user_blocklist
    FOR DELETE TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS user_blocklist_all_service_role ON public.user_blocklist;
CREATE POLICY user_blocklist_all_service_role ON public.user_blocklist
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.user_blocklist IS 'VTID-01094: Blocked users with expiry (90-day window)';

-- ===========================================================================
-- 7. USER_DAMPENING TABLE (VTID-01094 dislike dampening)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.user_dampening (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    dampened_user_id UUID NOT NULL,
    reason TEXT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id, dampened_user_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_user_dampening_tenant_user
    ON public.user_dampening (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_user_dampening_expires
    ON public.user_dampening (tenant_id, user_id, expires_at);

-- Enable RLS
ALTER TABLE public.user_dampening ENABLE ROW LEVEL SECURITY;

-- RLS policies
DROP POLICY IF EXISTS user_dampening_select ON public.user_dampening;
CREATE POLICY user_dampening_select ON public.user_dampening
    FOR SELECT TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS user_dampening_insert ON public.user_dampening;
CREATE POLICY user_dampening_insert ON public.user_dampening
    FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS user_dampening_delete ON public.user_dampening;
CREATE POLICY user_dampening_delete ON public.user_dampening
    FOR DELETE TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS user_dampening_all_service_role ON public.user_dampening;
CREATE POLICY user_dampening_all_service_role ON public.user_dampening
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.user_dampening IS 'VTID-01094: Dampened users with expiry (7-day window for dislike)';

-- ===========================================================================
-- 8. RPC: record_match_feedback
-- ===========================================================================
-- Main entry point for feedback. Handles all feedback types with deterministic rules.

CREATE OR REPLACE FUNCTION public.record_match_feedback(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_match_id UUID;
    v_feedback_type TEXT;
    v_topic_key TEXT;
    v_note TEXT;
    v_feedback_id UUID;
    v_match_record RECORD;
    v_target_user_id UUID;
    v_matched_topics TEXT[];
    v_changes JSONB := '[]'::JSONB;
    v_topic TEXT;
    v_delta INT;
    v_current_score INT;
    v_new_score INT;

    -- Deterministic constants (v1)
    c_like_topic_delta INT := 8;
    c_like_edge_delta INT := 10;
    c_dislike_topic_delta INT := -6;
    c_dislike_dampening_days INT := 7;
    c_block_topic_delta INT := -10;
    c_block_days INT := 90;
    c_wrong_topic_decrease INT := -6;
    c_wrong_topic_increase INT := 10;
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
    v_match_id := (p_payload->>'match_id')::UUID;
    v_feedback_type := p_payload->>'feedback_type';
    v_topic_key := p_payload->>'topic_key';
    v_note := p_payload->>'note';

    -- 3. Validate required fields
    IF v_match_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'MATCH_ID_REQUIRED');
    END IF;

    IF v_feedback_type IS NULL OR v_feedback_type NOT IN ('like', 'dislike', 'block', 'wrong_topic') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_FEEDBACK_TYPE');
    END IF;

    IF v_feedback_type = 'wrong_topic' AND (v_topic_key IS NULL OR v_topic_key = '') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TOPIC_KEY_REQUIRED_FOR_WRONG_TOPIC');
    END IF;

    -- 4. Get the match record
    SELECT id, tenant_id, user_id, target_user_id, topics, state
    INTO v_match_record
    FROM public.matches_daily
    WHERE id = v_match_id
      AND tenant_id = v_tenant_id
      AND user_id = v_user_id;

    IF v_match_record.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'MATCH_NOT_FOUND');
    END IF;

    v_target_user_id := v_match_record.target_user_id;
    v_matched_topics := v_match_record.topics;

    -- 5. Insert feedback record
    INSERT INTO public.match_feedback (tenant_id, user_id, match_id, feedback_type, topic_key, note)
    VALUES (v_tenant_id, v_user_id, v_match_id, v_feedback_type, v_topic_key, v_note)
    ON CONFLICT (tenant_id, user_id, match_id, feedback_type)
    DO UPDATE SET note = EXCLUDED.note, topic_key = EXCLUDED.topic_key
    RETURNING id INTO v_feedback_id;

    -- 6. Apply deterministic rules based on feedback type
    CASE v_feedback_type

    -- ======= LIKE =======
    WHEN 'like' THEN
        -- Update match state to accepted
        UPDATE public.matches_daily
        SET state = 'accepted', updated_at = NOW()
        WHERE id = v_match_id;

        -- Update topic scores: +8 for each matched topic
        FOREACH v_topic IN ARRAY v_matched_topics
        LOOP
            v_delta := c_like_topic_delta;

            -- Get current score or default to 50
            SELECT score INTO v_current_score
            FROM public.user_topic_profile
            WHERE tenant_id = v_tenant_id AND user_id = v_user_id AND topic_key = v_topic;

            IF v_current_score IS NULL THEN
                v_current_score := 50;
            END IF;

            v_new_score := LEAST(100, v_current_score + v_delta);

            -- Upsert topic profile
            INSERT INTO public.user_topic_profile (tenant_id, user_id, topic_key, score, source)
            VALUES (v_tenant_id, v_user_id, v_topic, v_new_score, 'feedback')
            ON CONFLICT (tenant_id, user_id, topic_key)
            DO UPDATE SET score = EXCLUDED.score, source = 'feedback', updated_at = NOW();

            -- Log change
            v_changes := v_changes || jsonb_build_object(
                'topic_key', v_topic,
                'delta', v_delta,
                'old_score', v_current_score,
                'new_score', v_new_score,
                'reason', 'liked match'
            );
        END LOOP;

        -- Create/strengthen relationship edge: +10
        INSERT INTO public.relationship_edges (tenant_id, source_user_id, target_user_id, edge_type, strength, context)
        VALUES (v_tenant_id, v_user_id, v_target_user_id, 'match', c_like_edge_delta, jsonb_build_object('source', 'feedback', 'match_id', v_match_id))
        ON CONFLICT (tenant_id, source_user_id, target_user_id, edge_type)
        DO UPDATE SET
            strength = LEAST(100, relationship_edges.strength + c_like_edge_delta),
            updated_at = NOW(),
            context = relationship_edges.context || jsonb_build_object('last_like', NOW());

    -- ======= DISLIKE =======
    WHEN 'dislike' THEN
        -- Update match state to dismissed
        UPDATE public.matches_daily
        SET state = 'dismissed', updated_at = NOW()
        WHERE id = v_match_id;

        -- Update topic scores: -6 for each matched topic (floor 0)
        FOREACH v_topic IN ARRAY v_matched_topics
        LOOP
            v_delta := c_dislike_topic_delta;

            SELECT score INTO v_current_score
            FROM public.user_topic_profile
            WHERE tenant_id = v_tenant_id AND user_id = v_user_id AND topic_key = v_topic;

            IF v_current_score IS NULL THEN
                v_current_score := 50;
            END IF;

            v_new_score := GREATEST(0, v_current_score + v_delta);

            INSERT INTO public.user_topic_profile (tenant_id, user_id, topic_key, score, source)
            VALUES (v_tenant_id, v_user_id, v_topic, v_new_score, 'feedback')
            ON CONFLICT (tenant_id, user_id, topic_key)
            DO UPDATE SET score = EXCLUDED.score, source = 'feedback', updated_at = NOW();

            v_changes := v_changes || jsonb_build_object(
                'topic_key', v_topic,
                'delta', v_delta,
                'old_score', v_current_score,
                'new_score', v_new_score,
                'reason', 'disliked match'
            );
        END LOOP;

        -- Add 7-day dampening flag
        INSERT INTO public.user_dampening (tenant_id, user_id, dampened_user_id, reason, expires_at)
        VALUES (v_tenant_id, v_user_id, v_target_user_id, 'disliked', NOW() + INTERVAL '7 days')
        ON CONFLICT (tenant_id, user_id, dampened_user_id)
        DO UPDATE SET expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason;

    -- ======= BLOCK =======
    WHEN 'block' THEN
        -- Update match state to dismissed
        UPDATE public.matches_daily
        SET state = 'dismissed', updated_at = NOW()
        WHERE id = v_match_id;

        -- Update topic scores: -10 for each matched topic
        FOREACH v_topic IN ARRAY v_matched_topics
        LOOP
            v_delta := c_block_topic_delta;

            SELECT score INTO v_current_score
            FROM public.user_topic_profile
            WHERE tenant_id = v_tenant_id AND user_id = v_user_id AND topic_key = v_topic;

            IF v_current_score IS NULL THEN
                v_current_score := 50;
            END IF;

            v_new_score := GREATEST(0, v_current_score + v_delta);

            INSERT INTO public.user_topic_profile (tenant_id, user_id, topic_key, score, source)
            VALUES (v_tenant_id, v_user_id, v_topic, v_new_score, 'feedback')
            ON CONFLICT (tenant_id, user_id, topic_key)
            DO UPDATE SET score = EXCLUDED.score, source = 'feedback', updated_at = NOW();

            v_changes := v_changes || jsonb_build_object(
                'topic_key', v_topic,
                'delta', v_delta,
                'old_score', v_current_score,
                'new_score', v_new_score,
                'reason', 'blocked match'
            );
        END LOOP;

        -- Add 90-day blocklist entry
        INSERT INTO public.user_blocklist (tenant_id, user_id, blocked_user_id, reason, expires_at)
        VALUES (v_tenant_id, v_user_id, v_target_user_id, v_note, NOW() + INTERVAL '90 days')
        ON CONFLICT (tenant_id, user_id, blocked_user_id)
        DO UPDATE SET expires_at = EXCLUDED.expires_at, reason = COALESCE(EXCLUDED.reason, user_blocklist.reason);

    -- ======= WRONG_TOPIC =======
    WHEN 'wrong_topic' THEN
        -- Update match state to dismissed
        UPDATE public.matches_daily
        SET state = 'dismissed', updated_at = NOW()
        WHERE id = v_match_id;

        -- Decrease detected topics: -6
        FOREACH v_topic IN ARRAY v_matched_topics
        LOOP
            v_delta := c_wrong_topic_decrease;

            SELECT score INTO v_current_score
            FROM public.user_topic_profile
            WHERE tenant_id = v_tenant_id AND user_id = v_user_id AND topic_key = v_topic;

            IF v_current_score IS NULL THEN
                v_current_score := 50;
            END IF;

            v_new_score := GREATEST(0, v_current_score + v_delta);

            INSERT INTO public.user_topic_profile (tenant_id, user_id, topic_key, score, source)
            VALUES (v_tenant_id, v_user_id, v_topic, v_new_score, 'feedback')
            ON CONFLICT (tenant_id, user_id, topic_key)
            DO UPDATE SET score = EXCLUDED.score, source = 'feedback', updated_at = NOW();

            v_changes := v_changes || jsonb_build_object(
                'topic_key', v_topic,
                'delta', v_delta,
                'old_score', v_current_score,
                'new_score', v_new_score,
                'reason', 'wrong topic detected'
            );
        END LOOP;

        -- Increase provided topic: +10
        v_delta := c_wrong_topic_increase;

        SELECT score INTO v_current_score
        FROM public.user_topic_profile
        WHERE tenant_id = v_tenant_id AND user_id = v_user_id AND topic_key = v_topic_key;

        IF v_current_score IS NULL THEN
            v_current_score := 50;
        END IF;

        v_new_score := LEAST(100, v_current_score + v_delta);

        INSERT INTO public.user_topic_profile (tenant_id, user_id, topic_key, score, source)
        VALUES (v_tenant_id, v_user_id, v_topic_key, v_new_score, 'feedback')
        ON CONFLICT (tenant_id, user_id, topic_key)
        DO UPDATE SET score = EXCLUDED.score, source = 'feedback', updated_at = NOW();

        v_changes := v_changes || jsonb_build_object(
            'topic_key', v_topic_key,
            'delta', v_delta,
            'old_score', v_current_score,
            'new_score', v_new_score,
            'reason', 'user provided correct topic'
        );

    END CASE;

    -- 7. Log personalization change
    INSERT INTO public.personalization_change_log (tenant_id, user_id, change_date, source, changes)
    VALUES (
        v_tenant_id,
        v_user_id,
        CURRENT_DATE,
        'match_feedback',
        jsonb_build_object(
            'feedback_id', v_feedback_id,
            'feedback_type', v_feedback_type,
            'match_id', v_match_id,
            'target_user_id', v_target_user_id,
            'topic_changes', v_changes
        )
    );

    -- 8. Return success
    RETURN jsonb_build_object(
        'ok', true,
        'feedback_id', v_feedback_id,
        'feedback_type', v_feedback_type,
        'match_id', v_match_id,
        'changes', v_changes
    );
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.record_match_feedback(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_match_feedback(JSONB) TO service_role;

COMMENT ON FUNCTION public.record_match_feedback IS 'VTID-01094: Record match feedback with deterministic personalization updates';

-- ===========================================================================
-- 9. RPC: get_personalization_changes
-- ===========================================================================
-- Retrieves the "Why improved?" history for a user

CREATE OR REPLACE FUNCTION public.get_personalization_changes(
    p_from DATE DEFAULT NULL,
    p_to DATE DEFAULT NULL,
    p_limit INT DEFAULT 50
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_changes JSONB;
BEGIN
    -- Get context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    v_user_id := public.current_user_id();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Cap limit
    IF p_limit IS NULL OR p_limit < 1 THEN
        p_limit := 50;
    ELSIF p_limit > 200 THEN
        p_limit := 200;
    END IF;

    -- Query changes
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', cl.id,
                'change_date', cl.change_date,
                'source', cl.source,
                'changes', cl.changes,
                'created_at', cl.created_at
            )
            ORDER BY cl.created_at DESC
        ),
        '[]'::JSONB
    )
    INTO v_changes
    FROM public.personalization_change_log cl
    WHERE cl.tenant_id = v_tenant_id
      AND cl.user_id = v_user_id
      AND (p_from IS NULL OR cl.change_date >= p_from)
      AND (p_to IS NULL OR cl.change_date <= p_to)
    LIMIT p_limit;

    RETURN jsonb_build_object(
        'ok', true,
        'changes', v_changes,
        'query', jsonb_build_object(
            'from', p_from,
            'to', p_to,
            'limit', p_limit
        )
    );
END;
$$;

-- Grant execute
GRANT EXECUTE ON FUNCTION public.get_personalization_changes(DATE, DATE, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_personalization_changes(DATE, DATE, INT) TO service_role;

COMMENT ON FUNCTION public.get_personalization_changes IS 'VTID-01094: Get "Why improved?" personalization change history';

-- ===========================================================================
-- 10. RPC: is_user_blocked (helper for match generation)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.is_user_blocked(p_target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_blocked BOOLEAN;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := public.current_user_id();

    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.user_blocklist
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND blocked_user_id = p_target_user_id
          AND expires_at > NOW()
    ) INTO v_blocked;

    RETURN COALESCE(v_blocked, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_user_blocked(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_user_blocked(UUID) TO service_role;

COMMENT ON FUNCTION public.is_user_blocked IS 'VTID-01094: Check if a user is blocked (within block window)';

-- ===========================================================================
-- 11. RPC: is_user_dampened (helper for match generation)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.is_user_dampened(p_target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_dampened BOOLEAN;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := public.current_user_id();

    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.user_dampening
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND dampened_user_id = p_target_user_id
          AND expires_at > NOW()
    ) INTO v_dampened;

    RETURN COALESCE(v_dampened, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_user_dampened(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_user_dampened(UUID) TO service_role;

COMMENT ON FUNCTION public.is_user_dampened IS 'VTID-01094: Check if a user is dampened (within dampening window)';

-- ===========================================================================
-- 12. Permissions
-- ===========================================================================

-- Grant table permissions to authenticated
GRANT SELECT ON public.matches_daily TO authenticated;
GRANT UPDATE ON public.matches_daily TO authenticated;

GRANT SELECT, INSERT, UPDATE ON public.user_topic_profile TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.relationship_edges TO authenticated;
GRANT SELECT, INSERT ON public.match_feedback TO authenticated;
GRANT SELECT, INSERT ON public.personalization_change_log TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.user_blocklist TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.user_dampening TO authenticated;

-- Service role gets all
GRANT ALL ON public.matches_daily TO service_role;
GRANT ALL ON public.user_topic_profile TO service_role;
GRANT ALL ON public.relationship_edges TO service_role;
GRANT ALL ON public.match_feedback TO service_role;
GRANT ALL ON public.personalization_change_log TO service_role;
GRANT ALL ON public.user_blocklist TO service_role;
GRANT ALL ON public.user_dampening TO service_role;

-- ===========================================================================
-- Migration Complete
-- ===========================================================================

-- Note: OASIS events are emitted from the Gateway layer, not from the database.
-- The Gateway endpoints (POST /api/v1/match/:id/feedback, GET /api/v1/personalization/changes)
-- will emit the following events:
--   - match.feedback.recorded
--   - topics.profile.updated.from_feedback
--   - personalization.change_log.written
