-- Vitana ID — Release B · Migration B (oasis_events)
-- VTID-01967
--
-- Add denormalized vitana_id column to oasis_events so support engineers
-- can filter/group event streams by speakable ID without joining profiles
-- through metadata->>'user_id'. New writers (oasis-event-service.ts)
-- populate at insert time from req.identity.vitanaId; this migration
-- backfills historical rows.
--
-- IO discipline: oasis_events has had prior disk-IO pressure (see
-- supabase_io_playbook). We add ONE partial index, run the backfill in
-- batches of 2000, and require off-peak execution.
--
-- Re-runnable: WHERE clause filters NULL vitana_id, so an aborted run
-- resumes cleanly on the next attempt.

-- 1. Column (nullable — null-tolerant writer contract).
ALTER TABLE public.oasis_events
  ADD COLUMN IF NOT EXISTS vitana_id text;

COMMENT ON COLUMN public.oasis_events.vitana_id IS
  'Denormalized snapshot of profiles.vitana_id for the actor at emit time. NULL for events that have no user actor (system / cron / heartbeat) or where the actor predates Release A backfill. Support tooling: filter by vitana_id directly.';

-- 2. Partial index for the support-query path. WHERE vitana_id IS NOT NULL
-- keeps the index lean (no system/cron rows). Single index per the IO playbook.
CREATE INDEX IF NOT EXISTS oasis_events_vitana_id_created_at_idx
  ON public.oasis_events (vitana_id, created_at DESC)
  WHERE vitana_id IS NOT NULL;

-- 3. Backfill from profiles via metadata->>'user_id'. Most rows have
-- user_id inside the metadata JSONB; rows without it stay NULL.
-- Batched + RAISE NOTICE so an operator running RUN-MIGRATION.yml sees
-- progress and can abort if disk IO climbs.
DO $backfill$
DECLARE
  batch_size int := 2000;
  rows_done  int := 0;
  total_done bigint := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT oe.id, p.vitana_id
        FROM public.oasis_events oe
        JOIN public.profiles p
          ON p.user_id = (oe.metadata ->> 'user_id')::uuid
       WHERE oe.vitana_id IS NULL
         AND oe.metadata ? 'user_id'
         AND (oe.metadata ->> 'user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       LIMIT batch_size
    )
    UPDATE public.oasis_events oe
       SET vitana_id = batch.vitana_id
      FROM batch
     WHERE oe.id = batch.id;

    GET DIAGNOSTICS rows_done = ROW_COUNT;
    total_done := total_done + rows_done;
    EXIT WHEN rows_done = 0;
    RAISE NOTICE 'oasis_events vitana_id backfill: +% rows (running total: %)', rows_done, total_done;
  END LOOP;

  RAISE NOTICE 'oasis_events vitana_id backfill: COMPLETE — % rows tagged', total_done;
END;
$backfill$;
