-- VTID-01991: Enable scheduled archival of terminal-state intent_matches
--
-- The SQL fn public.archive_old_intent_matches(p_older_than_days, p_batch_size)
-- and the destination table public.intent_matches_archive were created by
-- the P2-A/P2-C migrations (vitana-v1 / 20260501000800_intent_archive.sql,
-- 20260502000000_intent_disputes.sql). The TS worker
-- services/gateway/src/services/intent-archival-worker.ts and the manual
-- POST /api/v1/admin/intent-engine/archive endpoint are already shipped.
--
-- This migration wires up the daily pg_cron schedule that drains terminal-
-- state matches > 90 days old. Drains in 500-row batches per run; multiple
-- runs over the day catch up any backlog.
--
-- Schedule: daily at 04:30 UTC (after vitana-id mirror reconcile at 04:00,
-- before the busy 06:00–08:00 EU morning).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Drop any prior schedule with the same name before re-creating.
    PERFORM cron.unschedule(jobid)
       FROM cron.job
      WHERE jobname = 'intent-matches-archival';

    PERFORM cron.schedule(
      'intent-matches-archival',
      '30 4 * * *',
      $cron$SELECT public.archive_old_intent_matches(90, 500)$cron$
    );

    RAISE NOTICE 'pg_cron: scheduled intent-matches-archival (daily 04:30 UTC, 90d retention, 500 row batches)';
  ELSE
    RAISE NOTICE 'pg_cron not available — call public.archive_old_intent_matches() manually or via /api/v1/admin/intent-engine/archive';
  END IF;
END$$;

-- Note: the SQL fn already emits its own counts via RETURNS TABLE.
-- The TS worker (intent-archival-worker.ts) is what writes the OASIS
-- event when called via the admin endpoint. The cron path runs the SQL
-- fn directly without an OASIS event — by design, since the cron runs
-- daily and an event per noop run would be noisy. Operators get the
-- numbers via /api/v1/admin/intent-engine/kpi or by reading
-- intent_matches_archive directly.
