-- Migration: 20260116000000_vtid_01179_autopilot_event_loop.sql
-- Purpose: VTID-01179 Autopilot Event Loop - Autonomous State Machine Driver
-- Date: 2026-01-16
--
-- This migration establishes the persistence layer for the autopilot event loop:
--   - autopilot_loop_state: Loop state persistence (cursor, running status)
--   - autopilot_processed_events: Event deduplication tracking
--   - autopilot_run_state: Per-VTID run state for crash recovery
--
-- The event loop system:
--   - Polls OASIS events and maps them to autopilot state transitions
--   - Persists cursor position for crash-safe restart recovery
--   - Tracks processed events for idempotency/dedup
--   - Maintains per-VTID run state with retry counters and locks
--
-- Non-negotiables: SYS-RULE-DEPLOY-L1, ledger terminalization rule, additive-only APIs

-- ===========================================================================
-- 1. AUTOPILOT_LOOP_STATE TABLE
-- ===========================================================================
-- Single-row or keyed by environment - tracks loop cursor and running status

CREATE TABLE IF NOT EXISTS public.autopilot_loop_state (
    id TEXT PRIMARY KEY DEFAULT 'gateway',
    environment TEXT NOT NULL DEFAULT 'dev-sandbox',

    -- Cursor position: last processed OASIS event id
    last_event_cursor TEXT,
    last_event_timestamp TIMESTAMPTZ,

    -- Loop running state
    is_running BOOLEAN NOT NULL DEFAULT false,
    started_at TIMESTAMPTZ,
    stopped_at TIMESTAMPTZ,

    -- Configuration (can be updated at runtime)
    poll_interval_ms INTEGER NOT NULL DEFAULT 2000 CHECK (poll_interval_ms >= 500 AND poll_interval_ms <= 60000),
    batch_size INTEGER NOT NULL DEFAULT 100 CHECK (batch_size >= 1 AND batch_size <= 500),

    -- Statistics
    events_processed_total BIGINT NOT NULL DEFAULT 0,
    events_processed_1h INTEGER NOT NULL DEFAULT 0,
    errors_1h INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_error_at TIMESTAMPTZ,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for environment lookup
CREATE INDEX IF NOT EXISTS idx_autopilot_loop_state_env ON public.autopilot_loop_state (environment);

-- Enable RLS - service role only
ALTER TABLE public.autopilot_loop_state ENABLE ROW LEVEL SECURITY;

-- Only service role can access (Gateway backend)
DROP POLICY IF EXISTS autopilot_loop_state_service_role ON public.autopilot_loop_state;
CREATE POLICY autopilot_loop_state_service_role ON public.autopilot_loop_state
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.autopilot_loop_state IS 'VTID-01179: Autopilot event loop state persistence for crash-safe autonomy';
COMMENT ON COLUMN public.autopilot_loop_state.last_event_cursor IS 'Last processed OASIS event id for restart recovery';
COMMENT ON COLUMN public.autopilot_loop_state.is_running IS 'Whether the event loop is currently active';
COMMENT ON COLUMN public.autopilot_loop_state.poll_interval_ms IS 'Polling interval in milliseconds (500-60000)';

-- ===========================================================================
-- 2. AUTOPILOT_PROCESSED_EVENTS TABLE
-- ===========================================================================
-- Tracks processed events for idempotency and deduplication

CREATE TABLE IF NOT EXISTS public.autopilot_processed_events (
    event_id TEXT PRIMARY KEY,
    vtid TEXT,
    event_type TEXT NOT NULL,
    event_timestamp TIMESTAMPTZ,

    -- Processing outcome
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    result JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- What action was taken
    action_triggered TEXT,
    transition_from TEXT,
    transition_to TEXT,

    -- Error tracking
    error TEXT,

    -- Metadata
    raw_event JSONB
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_autopilot_processed_events_vtid ON public.autopilot_processed_events (vtid);
CREATE INDEX IF NOT EXISTS idx_autopilot_processed_events_type ON public.autopilot_processed_events (event_type);
CREATE INDEX IF NOT EXISTS idx_autopilot_processed_events_processed_at ON public.autopilot_processed_events (processed_at);
CREATE INDEX IF NOT EXISTS idx_autopilot_processed_events_timestamp ON public.autopilot_processed_events (event_timestamp);

-- Partial index for recent events (1 hour window for stats)
CREATE INDEX IF NOT EXISTS idx_autopilot_processed_events_recent
    ON public.autopilot_processed_events (processed_at)
    WHERE processed_at > NOW() - INTERVAL '1 hour';

-- Enable RLS - service role only
ALTER TABLE public.autopilot_processed_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS autopilot_processed_events_service_role ON public.autopilot_processed_events;
CREATE POLICY autopilot_processed_events_service_role ON public.autopilot_processed_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.autopilot_processed_events IS 'VTID-01179: Processed events for idempotency and audit trail';
COMMENT ON COLUMN public.autopilot_processed_events.event_id IS 'Unique OASIS event id - primary key for dedup';
COMMENT ON COLUMN public.autopilot_processed_events.result IS 'Processing outcome summary as JSON';

-- ===========================================================================
-- 3. AUTOPILOT_RUN_STATE TABLE
-- ===========================================================================
-- Per-VTID run state for crash recovery and action coordination

CREATE TABLE IF NOT EXISTS public.autopilot_run_state (
    vtid TEXT PRIMARY KEY,

    -- Current state (matches autopilot controller state machine)
    state TEXT NOT NULL DEFAULT 'allocated' CHECK (state IN (
        'allocated', 'in_progress', 'building', 'pr_created',
        'reviewing', 'validated', 'merged', 'deploying',
        'verifying', 'completed', 'failed'
    )),

    -- Run identification
    run_id TEXT,

    -- Timestamps
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_transition_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,

    -- Event tracking
    last_event_id TEXT,
    last_event_type TEXT,

    -- Pipeline artifacts
    pr_number INTEGER,
    pr_url TEXT,
    merge_sha TEXT,

    -- Retry tracking per action type
    attempts JSONB NOT NULL DEFAULT '{
        "dispatch": 0,
        "create_pr": 0,
        "validate": 0,
        "merge": 0,
        "verify": 0
    }'::jsonb,
    max_attempts INTEGER NOT NULL DEFAULT 3,

    -- Cooldown/backoff lock
    lock_until TIMESTAMPTZ,
    locked_by TEXT,

    -- Validation state
    validator_passed BOOLEAN,
    validator_result JSONB,

    -- Verification state
    verification_passed BOOLEAN,
    verification_result JSONB,

    -- Error tracking
    error TEXT,
    error_code TEXT,
    error_at TIMESTAMPTZ,

    -- Metadata
    spec_checksum TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_autopilot_run_state_state ON public.autopilot_run_state (state);
CREATE INDEX IF NOT EXISTS idx_autopilot_run_state_active ON public.autopilot_run_state (state)
    WHERE state NOT IN ('completed', 'failed');
CREATE INDEX IF NOT EXISTS idx_autopilot_run_state_lock ON public.autopilot_run_state (lock_until)
    WHERE lock_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_autopilot_run_state_updated ON public.autopilot_run_state (updated_at);

-- Enable RLS - service role only
ALTER TABLE public.autopilot_run_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS autopilot_run_state_service_role ON public.autopilot_run_state;
CREATE POLICY autopilot_run_state_service_role ON public.autopilot_run_state
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.autopilot_run_state IS 'VTID-01179: Per-VTID run state for crash recovery and action coordination';
COMMENT ON COLUMN public.autopilot_run_state.state IS 'Current autopilot state (matches controller state machine)';
COMMENT ON COLUMN public.autopilot_run_state.attempts IS 'Retry counters per action: dispatch, create_pr, validate, merge, verify';
COMMENT ON COLUMN public.autopilot_run_state.lock_until IS 'Backoff lock timestamp - actions blocked until this time';

-- ===========================================================================
-- 4. HELPER FUNCTION: get_loop_stats
-- ===========================================================================
-- Returns loop statistics for the status endpoint

CREATE OR REPLACE FUNCTION public.get_autopilot_loop_stats(
    p_loop_id TEXT DEFAULT 'gateway'
)
RETURNS TABLE (
    is_running BOOLEAN,
    poll_interval_ms INTEGER,
    last_cursor TEXT,
    last_event_timestamp TIMESTAMPTZ,
    events_processed_total BIGINT,
    processed_1h BIGINT,
    errors_1h BIGINT,
    active_runs BIGINT,
    runs_by_state JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        ls.is_running,
        ls.poll_interval_ms,
        ls.last_event_cursor,
        ls.last_event_timestamp,
        ls.events_processed_total,
        COALESCE((
            SELECT COUNT(*)
            FROM autopilot_processed_events pe
            WHERE pe.processed_at > NOW() - INTERVAL '1 hour'
        ), 0)::BIGINT as processed_1h,
        COALESCE((
            SELECT COUNT(*)
            FROM autopilot_processed_events pe
            WHERE pe.processed_at > NOW() - INTERVAL '1 hour'
            AND pe.error IS NOT NULL
        ), 0)::BIGINT as errors_1h,
        COALESCE((
            SELECT COUNT(*)
            FROM autopilot_run_state rs
            WHERE rs.state NOT IN ('completed', 'failed')
        ), 0)::BIGINT as active_runs,
        COALESCE((
            SELECT jsonb_object_agg(state, cnt)
            FROM (
                SELECT state, COUNT(*)::INTEGER as cnt
                FROM autopilot_run_state
                GROUP BY state
            ) s
        ), '{}'::jsonb) as runs_by_state
    FROM autopilot_loop_state ls
    WHERE ls.id = p_loop_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_autopilot_loop_stats(TEXT) TO service_role;

COMMENT ON FUNCTION public.get_autopilot_loop_stats IS 'VTID-01179: Get autopilot loop statistics for status endpoint';

-- ===========================================================================
-- 5. HELPER FUNCTION: acquire_run_lock
-- ===========================================================================
-- Acquires a lock on a VTID run for processing (prevents concurrent actions)

CREATE OR REPLACE FUNCTION public.acquire_autopilot_run_lock(
    p_vtid TEXT,
    p_locked_by TEXT,
    p_lock_duration_ms INTEGER DEFAULT 30000
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_updated INTEGER;
BEGIN
    UPDATE autopilot_run_state
    SET
        lock_until = NOW() + (p_lock_duration_ms || ' milliseconds')::INTERVAL,
        locked_by = p_locked_by,
        updated_at = NOW()
    WHERE vtid = p_vtid
      AND (lock_until IS NULL OR lock_until < NOW());

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.acquire_autopilot_run_lock(TEXT, TEXT, INTEGER) TO service_role;

COMMENT ON FUNCTION public.acquire_autopilot_run_lock IS 'VTID-01179: Acquire exclusive lock on VTID run for action processing';

-- ===========================================================================
-- 6. HELPER FUNCTION: release_run_lock
-- ===========================================================================
-- Releases lock on a VTID run

CREATE OR REPLACE FUNCTION public.release_autopilot_run_lock(
    p_vtid TEXT,
    p_locked_by TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_updated INTEGER;
BEGIN
    UPDATE autopilot_run_state
    SET
        lock_until = NULL,
        locked_by = NULL,
        updated_at = NOW()
    WHERE vtid = p_vtid
      AND (p_locked_by IS NULL OR locked_by = p_locked_by);

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.release_autopilot_run_lock(TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION public.release_autopilot_run_lock IS 'VTID-01179: Release lock on VTID run after action processing';

-- ===========================================================================
-- 7. HELPER FUNCTION: increment_action_attempt
-- ===========================================================================
-- Increments retry counter for a specific action type

CREATE OR REPLACE FUNCTION public.increment_autopilot_action_attempt(
    p_vtid TEXT,
    p_action_type TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_new_count INTEGER;
BEGIN
    UPDATE autopilot_run_state
    SET
        attempts = jsonb_set(
            attempts,
            ARRAY[p_action_type],
            to_jsonb(COALESCE((attempts->>p_action_type)::INTEGER, 0) + 1)
        ),
        updated_at = NOW()
    WHERE vtid = p_vtid
    RETURNING (attempts->>p_action_type)::INTEGER INTO v_new_count;

    RETURN COALESCE(v_new_count, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_autopilot_action_attempt(TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION public.increment_autopilot_action_attempt IS 'VTID-01179: Increment retry counter for action type';

-- ===========================================================================
-- 8. INSERT DEFAULT LOOP STATE
-- ===========================================================================

INSERT INTO public.autopilot_loop_state (id, environment, is_running, poll_interval_ms, batch_size)
VALUES ('gateway', 'dev-sandbox', false, 2000, 100)
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 9. VERIFICATION QUERIES
-- ===========================================================================

-- 9.1 Verify tables exist
DO $$
DECLARE
    v_loop_state_exists BOOLEAN;
    v_processed_events_exists BOOLEAN;
    v_run_state_exists BOOLEAN;
BEGIN
    SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'autopilot_loop_state') INTO v_loop_state_exists;
    SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'autopilot_processed_events') INTO v_processed_events_exists;
    SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'autopilot_run_state') INTO v_run_state_exists;

    IF v_loop_state_exists AND v_processed_events_exists AND v_run_state_exists THEN
        RAISE NOTICE 'VERIFY OK: All 3 autopilot loop tables exist';
    ELSE
        RAISE WARNING 'VERIFY FAIL: Missing tables. loop_state=%, processed_events=%, run_state=%',
            v_loop_state_exists, v_processed_events_exists, v_run_state_exists;
    END IF;
END $$;

-- 9.2 Verify functions exist
DO $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname IN ('get_autopilot_loop_stats', 'acquire_autopilot_run_lock',
                        'release_autopilot_run_lock', 'increment_autopilot_action_attempt');

    IF v_count = 4 THEN
        RAISE NOTICE 'VERIFY OK: All 4 helper functions exist';
    ELSE
        RAISE WARNING 'VERIFY FAIL: Expected 4 functions, found %', v_count;
    END IF;
END $$;

-- 9.3 Verify RLS is enabled
DO $$
DECLARE
    v_loop_rls BOOLEAN;
    v_events_rls BOOLEAN;
    v_run_rls BOOLEAN;
BEGIN
    SELECT relrowsecurity INTO v_loop_rls FROM pg_class WHERE relname = 'autopilot_loop_state';
    SELECT relrowsecurity INTO v_events_rls FROM pg_class WHERE relname = 'autopilot_processed_events';
    SELECT relrowsecurity INTO v_run_rls FROM pg_class WHERE relname = 'autopilot_run_state';

    IF v_loop_rls AND v_events_rls AND v_run_rls THEN
        RAISE NOTICE 'VERIFY OK: RLS enabled on all 3 tables';
    ELSE
        RAISE WARNING 'VERIFY FAIL: RLS not enabled. loop=%, events=%, run=%', v_loop_rls, v_events_rls, v_run_rls;
    END IF;
END $$;

-- 9.4 Verify default loop state exists
DO $$
DECLARE
    v_exists BOOLEAN;
BEGIN
    SELECT EXISTS (SELECT 1 FROM autopilot_loop_state WHERE id = 'gateway') INTO v_exists;

    IF v_exists THEN
        RAISE NOTICE 'VERIFY OK: Default gateway loop state exists';
    ELSE
        RAISE WARNING 'VERIFY FAIL: Default gateway loop state not created';
    END IF;
END $$;

-- ===========================================================================
-- Migration Complete: VTID-01179 Autopilot Event Loop
-- ===========================================================================
