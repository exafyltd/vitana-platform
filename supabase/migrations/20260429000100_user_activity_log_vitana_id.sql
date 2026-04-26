-- Vitana ID — Release C · 2/3
-- VTID-01969
--
-- Denormalize profiles.vitana_id onto user_activity_log. The activity log
-- is the most-queried table for "what was @alex3700 doing right before
-- the bug?" support investigations. Quoting vitana_id directly in
-- support tooling avoids per-row profile joins.
--
-- LARGE table — daily archival rotates after 180 days into
-- user_activity_log_archive. We add vitana_id to BOTH so support queries
-- against the archive also resolve speakable IDs.
--
-- Backfill is the heavy operation here; run off-peak. Re-runnable.
-- IO discipline: NO new index — reads filter by user_id (already indexed)
-- and project vitana_id.

ALTER TABLE public.user_activity_log
  ADD COLUMN IF NOT EXISTS actor_vitana_id text;

ALTER TABLE public.user_activity_log_archive
  ADD COLUMN IF NOT EXISTS actor_vitana_id text;

COMMENT ON COLUMN public.user_activity_log.actor_vitana_id IS
  'Snapshot of profiles.vitana_id for the actor (user_id) at insert time. Permanent. Used for support root-cause analysis and per-user activity timelines without join.';
COMMENT ON COLUMN public.user_activity_log_archive.actor_vitana_id IS
  'Mirror of user_activity_log.actor_vitana_id for archived rows older than 180d. Same semantics.';

-- Backfill live table (small batches because this table can be very large).
DO $backfill_live$
DECLARE
  batch_size int := 2000;
  rows_done  int := 0;
  total_done bigint := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id
        FROM public.user_activity_log
       WHERE actor_vitana_id IS NULL
       LIMIT batch_size
    )
    UPDATE public.user_activity_log l
       SET actor_vitana_id = (
         SELECT p.vitana_id FROM public.profiles p WHERE p.user_id = l.user_id
       )
      FROM batch
     WHERE l.id = batch.id;

    GET DIAGNOSTICS rows_done = ROW_COUNT;
    total_done := total_done + rows_done;
    EXIT WHEN rows_done = 0;
    RAISE NOTICE 'user_activity_log vitana_id backfill: +% rows (running total: %)', rows_done, total_done;
  END LOOP;

  RAISE NOTICE 'user_activity_log vitana_id backfill: COMPLETE — % rows tagged', total_done;
END;
$backfill_live$;

-- Backfill archive (also batched).
DO $backfill_archive$
DECLARE
  batch_size int := 2000;
  rows_done  int := 0;
  total_done bigint := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id
        FROM public.user_activity_log_archive
       WHERE actor_vitana_id IS NULL
       LIMIT batch_size
    )
    UPDATE public.user_activity_log_archive l
       SET actor_vitana_id = (
         SELECT p.vitana_id FROM public.profiles p WHERE p.user_id = l.user_id
       )
      FROM batch
     WHERE l.id = batch.id;

    GET DIAGNOSTICS rows_done = ROW_COUNT;
    total_done := total_done + rows_done;
    EXIT WHEN rows_done = 0;
    RAISE NOTICE 'user_activity_log_archive vitana_id backfill: +% rows (running total: %)', rows_done, total_done;
  END LOOP;

  RAISE NOTICE 'user_activity_log_archive vitana_id backfill: COMPLETE — % rows tagged', total_done;
END;
$backfill_archive$;
