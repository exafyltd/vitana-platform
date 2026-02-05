-- Migration: Fix oasis_events Disk IO - Add Missing Composite Indexes + Data Retention
-- IDEMPOTENT: Safe to run multiple times
-- Purpose: Resolve excessive sequential scans (55k+ seq scans, 7.97B rows read)
--          by adding composite indexes that match actual query patterns.
--
-- Root cause: Single-column indexes on (created_at), (vtid), (topic) etc. exist
-- but the dominant queries filter on COMBINATIONS (e.g., vtid + ORDER BY created_at)
-- which forces PostgreSQL into full table scans.
--
-- Affected queries:
--   - SSE polling (every 3s): vtid=eq.X, ORDER BY created_at DESC
--   - Events list: topic=eq.X, ORDER BY created_at DESC
--   - Execution status: vtid=eq.X, ORDER BY created_at ASC
--   - Telemetry snapshot: task_stage IS NOT NULL, created_at >= X
--   - Operator history: status=eq.X, ORDER BY created_at DESC

-- ============================================================
-- PART 1: Add composite indexes for dominant query patterns
-- ============================================================

-- Priority 1: vtid + created_at DESC
-- Covers: SSE polling (3s interval), execution status, gemini-operator queries,
--         lifecycle checks, task event timeline
-- This is the single most impactful index for reducing sequential scans.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_oasis_events_vtid_created_desc
  ON public.oasis_events (vtid, created_at DESC);

-- Priority 2: topic + created_at DESC
-- Covers: Events list endpoint, governance history, operator history,
--         lifecycle terminal event lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_oasis_events_topic_created_desc
  ON public.oasis_events (topic, created_at DESC);

-- Priority 3: status + created_at DESC
-- Covers: API events filtering by status, terminal event detection
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_oasis_events_status_created_desc
  ON public.oasis_events (status, created_at DESC);

-- Priority 4: created_at + task_stage (for time-windowed stage queries)
-- Covers: Telemetry stage counting with time filter (created_at >= X AND task_stage IS NOT NULL)
-- The existing (task_stage, created_at DESC) partial index only helps when task_stage is the
-- leading filter; this covers the reverse access pattern.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_oasis_events_created_task_stage
  ON public.oasis_events (created_at, task_stage)
  WHERE task_stage IS NOT NULL;

-- ============================================================
-- PART 2: Drop redundant single-column indexes
-- ============================================================
-- These single-column indexes are now fully covered by the composite
-- indexes above (a composite index on (A, B) serves queries on A alone).
-- Keeping them wastes write IO on every INSERT and disk space.

-- idx_oasis_events_vtid is covered by idx_oasis_events_vtid_created_desc
DROP INDEX IF EXISTS idx_oasis_events_vtid;

-- oasis_events_vtid_idx is a duplicate of idx_oasis_events_vtid
DROP INDEX IF EXISTS oasis_events_vtid_idx;

-- idx_oasis_events_topic is covered by idx_oasis_events_topic_created_desc
DROP INDEX IF EXISTS idx_oasis_events_topic;

-- idx_oasis_events_status is covered by idx_oasis_events_status_created_desc
DROP INDEX IF EXISTS idx_oasis_events_status;

-- oasis_events_status_idx is a duplicate
DROP INDEX IF EXISTS oasis_events_status_idx;

-- oasis_events_ts_desc_idx duplicates idx_oasis_events_created_at
DROP INDEX IF EXISTS oasis_events_ts_desc_idx;

-- ============================================================
-- PART 3: Data retention function
-- ============================================================
-- oasis_events is an operational telemetry table, not archival storage.
-- 305k+ rows with no cleanup causes unbounded growth and IO pressure.

CREATE OR REPLACE FUNCTION public.oasis_events_cleanup(
  retention_days INTEGER DEFAULT 14
)
RETURNS BIGINT AS $$
DECLARE
  deleted_count BIGINT;
BEGIN
  DELETE FROM public.oasis_events
  WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  -- Log cleanup to oasis_events itself
  INSERT INTO public.oasis_events (
    topic, service, role, status, message, source, kind, layer
  ) VALUES (
    'system.maintenance.cleanup',
    'oasis-events-retention',
    'system',
    'success',
    format('Deleted %s events older than %s days', deleted_count, retention_days),
    'migration',
    'maintenance',
    'SYSTEM'
  );

  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute to service_role (for edge function / cron invocation)
GRANT EXECUTE ON FUNCTION public.oasis_events_cleanup(INTEGER) TO service_role;

-- ============================================================
-- PART 4: Schedule automatic cleanup via pg_cron (if available)
-- ============================================================
-- pg_cron is available on Supabase Pro plans. This schedules daily
-- cleanup at 03:00 UTC. If pg_cron is not available, the function
-- can be called manually or via an edge function on a schedule.

DO $$
BEGIN
  -- Check if pg_cron extension is available
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Remove existing job if any
    PERFORM cron.unschedule('oasis-events-retention')
    WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'oasis-events-retention'
    );

    -- Schedule daily cleanup at 03:00 UTC, retain 14 days
    PERFORM cron.schedule(
      'oasis-events-retention',
      '0 3 * * *',
      $$SELECT public.oasis_events_cleanup(14)$$
    );

    RAISE NOTICE 'pg_cron: Scheduled oasis-events-retention (daily at 03:00 UTC, 14-day retention)';
  ELSE
    RAISE NOTICE 'pg_cron not available - call oasis_events_cleanup() manually or via edge function';
  END IF;
END$$;

-- ============================================================
-- PART 5: Run ANALYZE to update query planner statistics
-- ============================================================
ANALYZE public.oasis_events;
