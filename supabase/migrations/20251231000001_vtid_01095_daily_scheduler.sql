-- Migration: 20251231000001_vtid_01095_daily_scheduler.sql
-- Purpose: VTID-01095 Phase D: Daily Scheduler Wiring (Longevity + Topics + Matches + Community Recs)
-- Date: 2025-12-31
--
-- Creates:
--   1. daily_recompute_runs table for idempotency tracking
--   2. Stub RPC functions for compute stages:
--      - scheduler_longevity_compute_daily(p_user_id uuid, p_date date)
--      - scheduler_topics_recompute_user_profile(p_user_id uuid, p_date date)
--      - scheduler_community_recompute_recommendations(p_user_id uuid, p_date date)
--      - scheduler_match_recompute_daily(p_user_id uuid, p_date date)
--   3. Main orchestrator function:
--      - scheduler_daily_recompute_batch(p_tenant_id uuid, p_date date, p_limit int, p_cursor uuid)

-- ===========================================================================
-- 1. DAILY_RECOMPUTE_RUNS TABLE
-- ===========================================================================
-- Tracks per-user daily recompute runs for idempotency and progress tracking

CREATE TABLE IF NOT EXISTS public.daily_recompute_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    run_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'failed')),
    -- Per-stage status tracking: {stage: {status, started_at, finished_at, error?}}
    stage_status JSONB NOT NULL DEFAULT '{}'::JSONB,
    -- Current stage being processed
    current_stage TEXT,
    -- Error info if failed
    error_message TEXT,
    error_stage TEXT,
    -- Timing
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    -- Metadata (durations, counts, etc.)
    metadata JSONB DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Ensure one run per user per date per tenant
    CONSTRAINT daily_recompute_runs_unique UNIQUE (tenant_id, user_id, run_date)
);

-- Index for efficient batch queries
CREATE INDEX IF NOT EXISTS idx_daily_recompute_runs_tenant_date
    ON public.daily_recompute_runs (tenant_id, run_date, status);

CREATE INDEX IF NOT EXISTS idx_daily_recompute_runs_user_date
    ON public.daily_recompute_runs (user_id, run_date);

-- ===========================================================================
-- 2. ENABLE RLS
-- ===========================================================================

ALTER TABLE public.daily_recompute_runs ENABLE ROW LEVEL SECURITY;

-- Service role can access all (for scheduler)
-- Individual users can see their own runs
CREATE POLICY daily_recompute_runs_service_policy ON public.daily_recompute_runs
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- ===========================================================================
-- 3. STUB RPC: scheduler_longevity_compute_daily
-- ===========================================================================
-- Computes longevity signals for a user on a given date
-- Stub implementation: Returns success with placeholder data
-- To be replaced with actual longevity computation logic (VTID-01083)

CREATE OR REPLACE FUNCTION public.scheduler_longevity_compute_daily(
    p_user_id UUID,
    p_date DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_start_time TIMESTAMPTZ;
    v_duration_ms INTEGER;
BEGIN
    v_start_time := clock_timestamp();

    -- Get tenant from user context (for now, use a lookup)
    SELECT COALESCE(
        (SELECT tenant_id FROM public.daily_recompute_runs
         WHERE user_id = p_user_id AND run_date = p_date LIMIT 1),
        (SELECT id FROM public.tenants LIMIT 1)
    ) INTO v_tenant_id;

    -- STUB: Actual longevity computation would go here
    -- This is a placeholder that simulates successful computation
    -- Real implementation should:
    -- 1. Aggregate biological age markers
    -- 2. Compute longevity risk scores
    -- 3. Update longevity_signals table

    v_duration_ms := EXTRACT(MILLISECOND FROM (clock_timestamp() - v_start_time))::INTEGER;

    RETURN jsonb_build_object(
        'ok', true,
        'stage', 'longevity',
        'user_id', p_user_id,
        'date', p_date,
        'duration_ms', v_duration_ms,
        'signals_computed', 0,  -- Stub: no actual signals
        'message', 'Longevity compute stub - awaiting VTID-01083 implementation'
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'ok', false,
        'stage', 'longevity',
        'user_id', p_user_id,
        'date', p_date,
        'error', SQLERRM
    );
END;
$$;

-- ===========================================================================
-- 4. STUB RPC: scheduler_topics_recompute_user_profile
-- ===========================================================================
-- Recomputes topic profile for a user on a given date
-- Stub implementation: Returns success with placeholder data
-- To be replaced with actual topic computation logic (VTID-01093)

CREATE OR REPLACE FUNCTION public.scheduler_topics_recompute_user_profile(
    p_user_id UUID,
    p_date DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_start_time TIMESTAMPTZ;
    v_duration_ms INTEGER;
BEGIN
    v_start_time := clock_timestamp();

    -- STUB: Actual topic profile computation would go here
    -- This is a placeholder that simulates successful computation
    -- Real implementation should:
    -- 1. Analyze user's recent interactions
    -- 2. Extract topic preferences and interests
    -- 3. Update topic_profiles table

    v_duration_ms := EXTRACT(MILLISECOND FROM (clock_timestamp() - v_start_time))::INTEGER;

    RETURN jsonb_build_object(
        'ok', true,
        'stage', 'topics',
        'user_id', p_user_id,
        'date', p_date,
        'duration_ms', v_duration_ms,
        'topics_updated', 0,  -- Stub: no actual topics
        'message', 'Topics recompute stub - awaiting VTID-01093 implementation'
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'ok', false,
        'stage', 'topics',
        'user_id', p_user_id,
        'date', p_date,
        'error', SQLERRM
    );
END;
$$;

-- ===========================================================================
-- 5. STUB RPC: scheduler_community_recompute_recommendations
-- ===========================================================================
-- Recomputes community recommendations for a user on a given date
-- Stub implementation: Returns success with placeholder data
-- To be replaced with actual community recs logic (VTID-01084)

CREATE OR REPLACE FUNCTION public.scheduler_community_recompute_recommendations(
    p_user_id UUID,
    p_date DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_start_time TIMESTAMPTZ;
    v_duration_ms INTEGER;
BEGIN
    v_start_time := clock_timestamp();

    -- STUB: Actual community recommendations computation would go here
    -- This is a placeholder that simulates successful computation
    -- Real implementation should:
    -- 1. Analyze community connections
    -- 2. Find matching users/groups
    -- 3. Generate community recommendations
    -- 4. Update community_recommendations table

    v_duration_ms := EXTRACT(MILLISECOND FROM (clock_timestamp() - v_start_time))::INTEGER;

    RETURN jsonb_build_object(
        'ok', true,
        'stage', 'community_recs',
        'user_id', p_user_id,
        'date', p_date,
        'duration_ms', v_duration_ms,
        'recommendations_generated', 0,  -- Stub: no actual recs
        'message', 'Community recs recompute stub - awaiting VTID-01084 implementation'
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'ok', false,
        'stage', 'community_recs',
        'user_id', p_user_id,
        'date', p_date,
        'error', SQLERRM
    );
END;
$$;

-- ===========================================================================
-- 6. STUB RPC: scheduler_match_recompute_daily
-- ===========================================================================
-- Recomputes matchmaking for a user on a given date
-- Stub implementation: Returns success with placeholder data
-- To be replaced with actual matchmaking logic (VTID-01088)

CREATE OR REPLACE FUNCTION public.scheduler_match_recompute_daily(
    p_user_id UUID,
    p_date DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_start_time TIMESTAMPTZ;
    v_duration_ms INTEGER;
BEGIN
    v_start_time := clock_timestamp();

    -- STUB: Actual matchmaking computation would go here
    -- This is a placeholder that simulates successful computation
    -- Real implementation should:
    -- 1. Get user's topic profile and preferences
    -- 2. Find compatible matches
    -- 3. Score and rank matches
    -- 4. Update user_matches table

    v_duration_ms := EXTRACT(MILLISECOND FROM (clock_timestamp() - v_start_time))::INTEGER;

    RETURN jsonb_build_object(
        'ok', true,
        'stage', 'matches',
        'user_id', p_user_id,
        'date', p_date,
        'duration_ms', v_duration_ms,
        'matches_computed', 0,  -- Stub: no actual matches
        'message', 'Match recompute stub - awaiting VTID-01088 implementation'
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'ok', false,
        'stage', 'matches',
        'user_id', p_user_id,
        'date', p_date,
        'error', SQLERRM
    );
END;
$$;

-- ===========================================================================
-- 7. HELPER: Get users for batch processing
-- ===========================================================================
-- Returns a batch of users for the daily recompute, supporting cursor-based pagination

CREATE OR REPLACE FUNCTION public.scheduler_get_users_batch(
    p_tenant_id UUID,
    p_date DATE,
    p_limit INTEGER DEFAULT 200,
    p_cursor UUID DEFAULT NULL
)
RETURNS TABLE (
    user_id UUID,
    needs_processing BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        u.id as user_id,
        -- Check if user already has a completed run for this date
        NOT EXISTS (
            SELECT 1 FROM public.daily_recompute_runs r
            WHERE r.tenant_id = p_tenant_id
              AND r.user_id = u.id
              AND r.run_date = p_date
              AND r.status = 'completed'
        ) as needs_processing
    FROM auth.users u
    WHERE
        -- Cursor-based pagination
        (p_cursor IS NULL OR u.id > p_cursor)
    ORDER BY u.id
    LIMIT p_limit;
END;
$$;

-- ===========================================================================
-- 8. PERMISSIONS
-- ===========================================================================

-- Grant execute on RPCs to service role (scheduler runs as service)
GRANT EXECUTE ON FUNCTION public.scheduler_longevity_compute_daily(UUID, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.scheduler_topics_recompute_user_profile(UUID, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.scheduler_community_recompute_recommendations(UUID, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.scheduler_match_recompute_daily(UUID, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.scheduler_get_users_batch(UUID, DATE, INTEGER, UUID) TO service_role;

-- Grant table access
GRANT ALL ON public.daily_recompute_runs TO service_role;
GRANT SELECT ON public.daily_recompute_runs TO authenticated;

-- ===========================================================================
-- 9. COMMENTS
-- ===========================================================================

COMMENT ON TABLE public.daily_recompute_runs IS 'VTID-01095: Tracks daily recompute pipeline runs per user for idempotency';
COMMENT ON FUNCTION public.scheduler_longevity_compute_daily IS 'VTID-01095: Compute longevity signals (stub - awaiting VTID-01083)';
COMMENT ON FUNCTION public.scheduler_topics_recompute_user_profile IS 'VTID-01095: Recompute topic profile (stub - awaiting VTID-01093)';
COMMENT ON FUNCTION public.scheduler_community_recompute_recommendations IS 'VTID-01095: Recompute community recommendations (stub - awaiting VTID-01084)';
COMMENT ON FUNCTION public.scheduler_match_recompute_daily IS 'VTID-01095: Recompute matchmaking (stub - awaiting VTID-01088)';
COMMENT ON FUNCTION public.scheduler_get_users_batch IS 'VTID-01095: Get batch of users for daily recompute with cursor pagination';
