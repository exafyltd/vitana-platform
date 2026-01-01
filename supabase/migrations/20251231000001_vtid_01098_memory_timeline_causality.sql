-- Migration: 20251231000001_vtid_01098_memory_timeline_causality.sql
-- Purpose: VTID-01098 Memory Timeline & Life-Change Causality
-- Date: 2025-12-31
--
-- Creates:
--   1. memory_timeline_snapshots table (cached timeline projections)
--   2. memory_build_timeline RPC (aggregates sources, computes deltas, builds entries)
--   3. memory_get_timeline RPC (returns cached or computed timeline)
--
-- Dependencies:
--   - VTID-01101 (Phase A - tenant/user/role helpers)
--   - VTID-01103 (Health compute engine - vitana_index_scores, health_features_daily)
--   - VTID-01104 (Memory Core - memory_items)
--
-- Timeline Windows (Deterministic):
--   - Pre-window: 7 days before event
--   - Post-window: 7 days after event
--   - Metric delta thresholds per metric type
--
-- Confidence Scoring:
--   - base 0.3
--   - +0.2 if >= 2 sources
--   - +0.2 if >= 2 metrics changed
--   - +0.1 if repeated occurrence
--   - cap at 0.9

-- ===========================================================================
-- 1. MEMORY TIMELINE SNAPSHOTS TABLE
-- ===========================================================================
-- Stores cached timeline projections for efficient reads

CREATE TABLE IF NOT EXISTS public.memory_timeline_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    snapshot_date DATE NOT NULL,
    window JSONB NOT NULL DEFAULT '{}'::JSONB,  -- {from: date, to: date}
    entries JSONB NOT NULL DEFAULT '[]'::JSONB, -- timeline items array
    entry_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT memory_timeline_snapshots_unique UNIQUE (tenant_id, user_id, snapshot_date)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_memory_timeline_snapshots_tenant_user_date
    ON public.memory_timeline_snapshots (tenant_id, user_id, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_memory_timeline_snapshots_window
    ON public.memory_timeline_snapshots USING GIN (window);

-- ===========================================================================
-- 2. RLS POLICIES
-- ===========================================================================

ALTER TABLE public.memory_timeline_snapshots ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS memory_timeline_snapshots_select ON public.memory_timeline_snapshots;
DROP POLICY IF EXISTS memory_timeline_snapshots_insert ON public.memory_timeline_snapshots;
DROP POLICY IF EXISTS memory_timeline_snapshots_update ON public.memory_timeline_snapshots;
DROP POLICY IF EXISTS memory_timeline_snapshots_delete ON public.memory_timeline_snapshots;

-- Users can only access their own timeline snapshots
CREATE POLICY memory_timeline_snapshots_select ON public.memory_timeline_snapshots
    FOR SELECT TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

CREATE POLICY memory_timeline_snapshots_insert ON public.memory_timeline_snapshots
    FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

CREATE POLICY memory_timeline_snapshots_update ON public.memory_timeline_snapshots
    FOR UPDATE TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    )
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

CREATE POLICY memory_timeline_snapshots_delete ON public.memory_timeline_snapshots
    FOR DELETE TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- ===========================================================================
-- 3. CONSTANTS & HELPER TYPES
-- ===========================================================================

-- Timeline window constants (in days)
-- Pre-window: 7 days before event
-- Post-window: 7 days after event

-- Metric delta thresholds (deterministic)
-- These are minimum absolute changes to be considered significant
-- sleep_quality: +/- 15 (percentage scale 0-100)
-- stress_level: +/- 12 (index scale)
-- social_score: +/- 20 (score scale)
-- movement: +/- 18 (score scale)
-- mood: qualitative change detection

-- ===========================================================================
-- 4. RPC: memory_build_timeline(p_user_id uuid, p_from date, p_to date)
-- ===========================================================================
-- Aggregates sources, computes deltas, builds entries, stores snapshot
-- Returns {ok:true, entries: n} or {ok:false, error: string}

CREATE OR REPLACE FUNCTION public.memory_build_timeline(
    p_user_id UUID,
    p_from DATE,
    p_to DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_auth_user_id UUID;
    v_entries JSONB := '[]'::JSONB;
    v_entry JSONB;
    v_memory_item RECORD;
    v_health_pre RECORD;
    v_health_post RECORD;
    v_observed_changes JSONB;
    v_evidence JSONB;
    v_confidence NUMERIC;
    v_source_count INT;
    v_metric_changes INT;
    v_entry_count INT := 0;
    v_pre_window_days INT := 7;
    v_post_window_days INT := 7;
    v_delta_score_physical INT;
    v_delta_score_mental INT;
    v_delta_score_social INT;
    v_delta_score_total INT;
    v_related_topics TEXT[];
    v_related_people INT;
    v_event_date DATE;
BEGIN
    -- Gate 1: Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Gate 2: Validate user_id
    v_auth_user_id := auth.uid();
    IF v_auth_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Gate 3: User can only build their own timeline (or service role can build any)
    IF p_user_id != v_auth_user_id THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHORIZED',
            'message', 'Cannot build timeline for another user'
        );
    END IF;

    -- Gate 4: Validate date range
    IF p_from > p_to THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_DATE_RANGE',
            'message', 'from date must be before or equal to to date'
        );
    END IF;

    -- Limit date range to prevent excessive computation (max 365 days)
    IF (p_to - p_from) > 365 THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'DATE_RANGE_TOO_LARGE',
            'message', 'Date range cannot exceed 365 days'
        );
    END IF;

    -- ===========================================================================
    -- Build timeline entries from memory_items
    -- ===========================================================================
    -- We look for significant memory items (relationships, events, health, community)
    -- and then check for health metric changes in the post-window

    FOR v_memory_item IN
        SELECT
            mi.id,
            mi.category_key,
            mi.source,
            mi.content,
            mi.content_json,
            mi.importance,
            DATE(mi.occurred_at) as event_date,
            mi.occurred_at
        FROM public.memory_items mi
        WHERE mi.tenant_id = v_tenant_id
          AND mi.user_id = p_user_id
          AND DATE(mi.occurred_at) BETWEEN p_from AND p_to
          AND mi.category_key IN ('relationships', 'events_meetups', 'community', 'health', 'goals')
          AND mi.importance >= 30  -- Only include moderately important items
        ORDER BY mi.occurred_at
    LOOP
        v_event_date := v_memory_item.event_date;
        v_observed_changes := '[]'::JSONB;
        v_metric_changes := 0;
        v_source_count := 1;  -- The memory item itself is 1 source

        -- ===========================================================================
        -- Compute health metric deltas
        -- ===========================================================================
        -- Get average vitana scores for pre-window (7 days before)
        SELECT
            COALESCE(AVG(score_physical), 0) as avg_physical,
            COALESCE(AVG(score_mental), 0) as avg_mental,
            COALESCE(AVG(score_social), 0) as avg_social,
            COALESCE(AVG(score_total), 0) as avg_total,
            COUNT(*) as data_days
        INTO v_health_pre
        FROM public.vitana_index_scores vis
        WHERE vis.tenant_id = v_tenant_id
          AND vis.user_id = p_user_id
          AND vis.date BETWEEN (v_event_date - v_pre_window_days) AND (v_event_date - 1);

        -- Get average vitana scores for post-window (7 days after)
        SELECT
            COALESCE(AVG(score_physical), 0) as avg_physical,
            COALESCE(AVG(score_mental), 0) as avg_mental,
            COALESCE(AVG(score_social), 0) as avg_social,
            COALESCE(AVG(score_total), 0) as avg_total,
            COUNT(*) as data_days
        INTO v_health_post
        FROM public.vitana_index_scores vis
        WHERE vis.tenant_id = v_tenant_id
          AND vis.user_id = p_user_id
          AND vis.date BETWEEN (v_event_date + 1) AND (v_event_date + v_post_window_days);

        -- Only compute deltas if we have data in both windows
        IF v_health_pre.data_days >= 2 AND v_health_post.data_days >= 2 THEN
            v_source_count := v_source_count + 1;  -- Health data is another source

            -- Physical score delta (threshold: +/- 18)
            v_delta_score_physical := (v_health_post.avg_physical - v_health_pre.avg_physical)::INT;
            IF ABS(v_delta_score_physical) >= 18 THEN
                v_observed_changes := v_observed_changes || jsonb_build_object(
                    'metric', 'physical',
                    'delta', CASE WHEN v_delta_score_physical > 0 THEN '+' ELSE '' END || v_delta_score_physical::TEXT,
                    'window', '+' || v_post_window_days || ' days'
                );
                v_metric_changes := v_metric_changes + 1;
            END IF;

            -- Mental score delta (threshold: +/- 15 / stress improvement)
            v_delta_score_mental := (v_health_post.avg_mental - v_health_pre.avg_mental)::INT;
            IF ABS(v_delta_score_mental) >= 15 THEN
                v_observed_changes := v_observed_changes || jsonb_build_object(
                    'metric', 'stress',
                    'delta', CASE
                        WHEN v_delta_score_mental > 0 THEN 'reduced'
                        ELSE 'increased'
                    END,
                    'window', '+' || v_post_window_days || ' days'
                );
                v_metric_changes := v_metric_changes + 1;
            END IF;

            -- Social score delta (threshold: +/- 20)
            v_delta_score_social := (v_health_post.avg_social - v_health_pre.avg_social)::INT;
            IF ABS(v_delta_score_social) >= 20 THEN
                v_observed_changes := v_observed_changes || jsonb_build_object(
                    'metric', 'social_score',
                    'delta', CASE WHEN v_delta_score_social > 0 THEN '+' ELSE '' END || v_delta_score_social::TEXT,
                    'window', '+' || v_post_window_days || ' days'
                );
                v_metric_changes := v_metric_changes + 1;
            END IF;
        END IF;

        -- ===========================================================================
        -- Build related topics from content
        -- ===========================================================================
        v_related_topics := ARRAY[]::TEXT[];

        -- Extract keywords based on category
        CASE v_memory_item.category_key
            WHEN 'relationships' THEN
                v_related_topics := ARRAY['connection', 'relationship'];
            WHEN 'events_meetups' THEN
                v_related_topics := ARRAY['community', 'social'];
            WHEN 'community' THEN
                v_related_topics := ARRAY['group', 'community'];
            WHEN 'health' THEN
                v_related_topics := ARRAY['health', 'wellness'];
            WHEN 'goals' THEN
                v_related_topics := ARRAY['goal', 'progress'];
            ELSE
                v_related_topics := ARRAY[v_memory_item.category_key];
        END CASE;

        -- Count related people (from content_json if available)
        v_related_people := COALESCE((v_memory_item.content_json->>'people_count')::INT, 0);
        IF v_memory_item.category_key = 'relationships' THEN
            v_related_people := GREATEST(v_related_people, 1);
        END IF;

        -- ===========================================================================
        -- Calculate confidence (deterministic)
        -- ===========================================================================
        -- base 0.3
        -- +0.2 if >= 2 sources
        -- +0.2 if >= 2 metrics changed
        -- +0.1 if repeated occurrence
        -- cap at 0.9
        v_confidence := 0.3;

        IF v_source_count >= 2 THEN
            v_confidence := v_confidence + 0.2;
        END IF;

        IF v_metric_changes >= 2 THEN
            v_confidence := v_confidence + 0.2;
        END IF;

        -- Check for repeated occurrence (same category in last 30 days)
        IF EXISTS (
            SELECT 1 FROM public.memory_items mi2
            WHERE mi2.tenant_id = v_tenant_id
              AND mi2.user_id = p_user_id
              AND mi2.category_key = v_memory_item.category_key
              AND mi2.id != v_memory_item.id
              AND DATE(mi2.occurred_at) BETWEEN (v_event_date - 30) AND (v_event_date - 1)
        ) THEN
            v_confidence := v_confidence + 0.1;
        END IF;

        -- Cap at 0.9
        v_confidence := LEAST(v_confidence, 0.9);

        -- ===========================================================================
        -- Build evidence object
        -- ===========================================================================
        v_evidence := jsonb_build_object(
            'sources', jsonb_build_array(v_memory_item.category_key || ':' || v_memory_item.id::TEXT),
            'related_topics', to_jsonb(v_related_topics),
            'related_people', v_related_people
        );

        -- ===========================================================================
        -- Map category to timeline type
        -- ===========================================================================
        -- Build timeline entry
        v_entry := jsonb_build_object(
            'date', v_event_date::TEXT,
            'type', CASE v_memory_item.category_key
                WHEN 'relationships' THEN 'relationship'
                WHEN 'events_meetups' THEN 'meetup'
                WHEN 'community' THEN 'live'
                WHEN 'health' THEN 'habit'
                WHEN 'goals' THEN 'habit'
                ELSE 'diary'
            END,
            'title', CASE
                WHEN LENGTH(v_memory_item.content) > 50
                THEN SUBSTRING(v_memory_item.content FROM 1 FOR 47) || '...'
                ELSE v_memory_item.content
            END,
            'evidence', v_evidence,
            'observed_changes', v_observed_changes,
            'confidence', ROUND(v_confidence::NUMERIC, 2),
            'memory_item_id', v_memory_item.id
        );

        -- Add to entries array
        v_entries := v_entries || v_entry;
        v_entry_count := v_entry_count + 1;
    END LOOP;

    -- ===========================================================================
    -- Store/Update snapshot
    -- ===========================================================================
    INSERT INTO public.memory_timeline_snapshots (
        tenant_id,
        user_id,
        snapshot_date,
        window,
        entries,
        entry_count,
        updated_at
    ) VALUES (
        v_tenant_id,
        p_user_id,
        CURRENT_DATE,
        jsonb_build_object('from', p_from, 'to', p_to),
        v_entries,
        v_entry_count,
        NOW()
    )
    ON CONFLICT (tenant_id, user_id, snapshot_date)
    DO UPDATE SET
        window = EXCLUDED.window,
        entries = EXCLUDED.entries,
        entry_count = EXCLUDED.entry_count,
        updated_at = NOW();

    -- Return success
    RETURN jsonb_build_object(
        'ok', true,
        'entries', v_entry_count,
        'window', jsonb_build_object('from', p_from, 'to', p_to),
        'snapshot_date', CURRENT_DATE,
        'tenant_id', v_tenant_id,
        'user_id', p_user_id
    );
END;
$$;

-- ===========================================================================
-- 5. RPC: memory_get_timeline(p_user_id uuid, p_from date, p_to date)
-- ===========================================================================
-- Returns cached snapshot if exists for today, else computes on the fly
-- Returns {ok:true, entries: [...]} or {ok:false, error: string}

CREATE OR REPLACE FUNCTION public.memory_get_timeline(
    p_user_id UUID,
    p_from DATE,
    p_to DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_auth_user_id UUID;
    v_snapshot RECORD;
    v_cached_window JSONB;
BEGIN
    -- Gate 1: Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Gate 2: Validate user_id
    v_auth_user_id := auth.uid();
    IF v_auth_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Gate 3: User can only get their own timeline
    IF p_user_id != v_auth_user_id THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHORIZED',
            'message', 'Cannot get timeline for another user'
        );
    END IF;

    -- Gate 4: Validate date range
    IF p_from > p_to THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_DATE_RANGE',
            'message', 'from date must be before or equal to to date'
        );
    END IF;

    -- Check for cached snapshot with matching window (from today)
    SELECT
        mts.id,
        mts.window,
        mts.entries,
        mts.entry_count,
        mts.snapshot_date,
        mts.created_at,
        mts.updated_at
    INTO v_snapshot
    FROM public.memory_timeline_snapshots mts
    WHERE mts.tenant_id = v_tenant_id
      AND mts.user_id = p_user_id
      AND mts.snapshot_date = CURRENT_DATE;

    -- If we have a cached snapshot, check if window matches
    IF v_snapshot.id IS NOT NULL THEN
        v_cached_window := v_snapshot.window;
        IF (v_cached_window->>'from')::DATE = p_from AND (v_cached_window->>'to')::DATE = p_to THEN
            -- Cache hit - return cached snapshot
            RETURN jsonb_build_object(
                'ok', true,
                'entries', v_snapshot.entries,
                'entry_count', v_snapshot.entry_count,
                'window', v_snapshot.window,
                'cached', true,
                'snapshot_date', v_snapshot.snapshot_date,
                'cached_at', v_snapshot.updated_at,
                'tenant_id', v_tenant_id,
                'user_id', p_user_id
            );
        END IF;
    END IF;

    -- Cache miss or window mismatch - compute on the fly
    RETURN public.memory_build_timeline(p_user_id, p_from, p_to);
END;
$$;

-- ===========================================================================
-- 6. PERMISSIONS
-- ===========================================================================

-- Grant execute on RPCs to authenticated users
GRANT EXECUTE ON FUNCTION public.memory_build_timeline(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.memory_get_timeline(UUID, DATE, DATE) TO authenticated;

-- Grant table access for RLS policies
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_timeline_snapshots TO authenticated;

-- ===========================================================================
-- 7. COMMENTS
-- ===========================================================================

COMMENT ON TABLE public.memory_timeline_snapshots IS 'VTID-01098: Cached timeline projections showing life events and correlated health changes';
COMMENT ON FUNCTION public.memory_build_timeline IS 'VTID-01098: Builds timeline by aggregating memory items and computing health metric deltas. Idempotent.';
COMMENT ON FUNCTION public.memory_get_timeline IS 'VTID-01098: Returns cached timeline snapshot or computes on-the-fly if not cached.';
