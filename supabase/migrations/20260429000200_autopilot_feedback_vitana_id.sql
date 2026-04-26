-- Vitana ID — Release C · 3/3
-- VTID-01969
--
-- Denormalize profiles.vitana_id onto autopilot_feedback. AI / autopilot
-- complaints are a primary support channel; tagging by vitana_id lets
-- support queries cross-reference voice complaints, recommendations, and
-- the user's broader activity timeline without joining profiles.
--
-- Smaller table than user_notifications / user_activity_log; backfill is
-- quick. Single 5000-row batch usually suffices.

ALTER TABLE public.autopilot_feedback
  ADD COLUMN IF NOT EXISTS user_vitana_id text;

COMMENT ON COLUMN public.autopilot_feedback.user_vitana_id IS
  'Snapshot of profiles.vitana_id for the feedback author at insert time. Permanent. Used for cross-referencing voice / autopilot complaints with broader user activity.';

DO $backfill$
DECLARE
  batch_size int := 5000;
  rows_done  int := 0;
  total_done bigint := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id
        FROM public.autopilot_feedback
       WHERE user_vitana_id IS NULL
       LIMIT batch_size
    )
    UPDATE public.autopilot_feedback f
       SET user_vitana_id = (
         SELECT p.vitana_id FROM public.profiles p WHERE p.user_id = f.user_id
       )
      FROM batch
     WHERE f.id = batch.id;

    GET DIAGNOSTICS rows_done = ROW_COUNT;
    total_done := total_done + rows_done;
    EXIT WHEN rows_done = 0;
    RAISE NOTICE 'autopilot_feedback vitana_id backfill: +% rows (running total: %)', rows_done, total_done;
  END LOOP;

  RAISE NOTICE 'autopilot_feedback vitana_id backfill: COMPLETE — % rows tagged', total_done;
END;
$backfill$;
