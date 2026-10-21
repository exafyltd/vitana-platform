-- VTID-03972 — widen oasis_events retention from status='info' only to all statuses.
--
-- The original migration (20260205000000_fix_oasis_events_disk_io_indexes.sql)
-- intended a blanket 14-day retention via a pg_cron job named
-- 'oasis-events-retention'. That job was never actually created on the live
-- project — instead a narrower job, 'oasis-events-info-retention' (jobid 6),
-- exists and only ever deleted `status = 'info'` rows older than 7 days.
-- Every other status (success, warning, error — the bulk of real telemetry:
-- latency beacons, health checks, wake-brief decisions) has accumulated
-- forever. Confirmed live 2026-09-16: oasis_events had grown to 933MB / ~486K
-- rows, ~16x larger than every other table combined, and was observed via
-- pg_stat_activity actively stalling on DataFileRead waits — the proximate
-- cause of the "MAXINA app slow, spinner on every step" production report.
--
-- Also found live: no plain index on (created_at) existed at all — only
-- composite indexes with topic/status leading — so any pure time-range query
-- (this cleanup included) forced a sequential scan of the whole table. Added
-- CONCURRENTLY (no lock, safe under live load).
--
-- A single unbounded DELETE against a 933MB table with hundreds of thousands
-- of qualifying rows would itself be a long-lived transaction/lock on an
-- already I/O-stressed table, so the job now calls a batched PROCEDURE
-- (5000 rows/batch, COMMIT between batches, capped at 200 batches/run) instead
-- of one raw DELETE statement — safe for both the large first catch-up run and
-- every ordinary nightly run after.
--
-- Applied directly to the live project 2026-09-16 (this file records that
-- change for the repo's migration history). cron.alter_job() does not support
-- renaming the job in this pg_cron version, so the jobname stays
-- 'oasis-events-info-retention' even though its command is now blanket
-- 14-day retention across all statuses, matching the original intent.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_oasis_events_created_at
  ON public.oasis_events (created_at);

CREATE OR REPLACE PROCEDURE public.oasis_events_cleanup_batched(
  retention_days INTEGER DEFAULT 14,
  batch_size INTEGER DEFAULT 5000,
  max_batches INTEGER DEFAULT 200
)
LANGUAGE plpgsql
AS $proc$
DECLARE
  deleted_this_batch INTEGER;
  total_deleted BIGINT := 0;
  batches INTEGER := 0;
BEGIN
  LOOP
    DELETE FROM public.oasis_events
    WHERE ctid IN (
      SELECT ctid FROM public.oasis_events
      WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL
      LIMIT batch_size
    );
    GET DIAGNOSTICS deleted_this_batch = ROW_COUNT;
    total_deleted := total_deleted + deleted_this_batch;
    batches := batches + 1;

    COMMIT;

    EXIT WHEN deleted_this_batch = 0 OR batches >= max_batches;
  END LOOP;

  INSERT INTO public.oasis_events (topic, service, role, status, message, source, kind, layer)
  VALUES ('system.maintenance.cleanup', 'oasis-events-retention', 'system', 'success',
          format('Deleted %s events older than %s days in %s batches', total_deleted, retention_days, batches),
          'pg_cron', 'maintenance', 'SYSTEM');
  COMMIT;
END;
$proc$;

GRANT EXECUTE ON PROCEDURE public.oasis_events_cleanup_batched(INTEGER, INTEGER, INTEGER) TO service_role, postgres;

select cron.alter_job(
  job_id => 6,
  command => $cmd$CALL public.oasis_events_cleanup_batched(14, 5000, 200)$cmd$
);
