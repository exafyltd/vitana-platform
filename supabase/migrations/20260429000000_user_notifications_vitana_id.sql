-- Vitana ID — Release C · 1/3
-- VTID-01969
--
-- Denormalize profiles.vitana_id onto user_notifications. Support engineers
-- reading per-user notification history (delivery audit, ticket reconstruction)
-- can quote "@alex3700" without joining profiles.
--
-- Single recipient column (notifications target one user_id). Null-tolerant
-- writers — Release B contract carries forward. Release A backfilled
-- profiles.vitana_id, so the join is direct.
--
-- IO discipline: NO new index. Reads filter by user_id (already indexed)
-- and project vitana_id; if a support query truly needs to filter by
-- vitana_id alone, lateral-join profiles instead.

ALTER TABLE public.user_notifications
  ADD COLUMN IF NOT EXISTS recipient_vitana_id text;

COMMENT ON COLUMN public.user_notifications.recipient_vitana_id IS
  'Snapshot of profiles.vitana_id for the recipient at insert time. Read-only after write — vitana_id is permanent so this should never need updates. Support tooling reads alongside user_id without joining profiles.';

-- Batched backfill in 5000-row chunks. Re-runnable: WHERE clause filters
-- already-tagged rows so an aborted run resumes cleanly.
DO $backfill$
DECLARE
  batch_size int := 5000;
  rows_done  int := 0;
  total_done bigint := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id
        FROM public.user_notifications
       WHERE recipient_vitana_id IS NULL
       LIMIT batch_size
    )
    UPDATE public.user_notifications n
       SET recipient_vitana_id = (
         SELECT p.vitana_id FROM public.profiles p WHERE p.user_id = n.user_id
       )
      FROM batch
     WHERE n.id = batch.id;

    GET DIAGNOSTICS rows_done = ROW_COUNT;
    total_done := total_done + rows_done;
    EXIT WHEN rows_done = 0;
    RAISE NOTICE 'user_notifications vitana_id backfill: +% rows (running total: %)', rows_done, total_done;
  END LOOP;

  RAISE NOTICE 'user_notifications vitana_id backfill: COMPLETE — % rows tagged', total_done;
END;
$backfill$;
