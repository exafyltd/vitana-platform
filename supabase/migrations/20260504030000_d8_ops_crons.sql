-- Dance specialized market — D8 ops crons (VTID-DANCE-D8)
-- Three cheap insurance jobs:
--   1. vitana_id_mirror_reconcile_daily — assert app_users.vitana_id =
--      profiles.vitana_id every night; emit OASIS event if any drift.
--   2. intent_matches_archive_daily — TTL closed/fulfilled/declined matches
--      older than 90 days. Scaffolding from P2-C; this enables it.
--   3. intent_open_asks is just a view (no cron needed).

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 1. Mirror reconcile.
CREATE OR REPLACE FUNCTION public.vitana_id_mirror_reconcile()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_drift int;
BEGIN
  SELECT count(*) INTO v_drift
    FROM public.app_users a
    JOIN public.profiles p USING (user_id)
   WHERE a.vitana_id IS DISTINCT FROM p.vitana_id;

  IF v_drift > 0 THEN
    INSERT INTO public.oasis_events (topic, vtid, status, message, metadata)
    VALUES (
      'vitana_id.mirror.drift',
      'VTID-DANCE-D8',
      'warning',
      format('Mirror trigger drift detected: %s rows', v_drift),
      jsonb_build_object('drift_count', v_drift, 'detected_at', now())
    );
  END IF;

  RETURN v_drift;
END;
$$;

COMMENT ON FUNCTION public.vitana_id_mirror_reconcile() IS
  'D8: daily assertion that app_users.vitana_id matches profiles.vitana_id. Emits OASIS warning if any drift. Cheap insurance against silent regression of the mirror trigger.';

-- Schedule daily at 03:15 UTC (off-peak). Idempotent re-schedule.
DO $$
BEGIN
  PERFORM cron.unschedule('vitana_id_mirror_reconcile_daily');
EXCEPTION WHEN OTHERS THEN
  -- Job didn't exist; ignore.
  NULL;
END $$;

SELECT cron.schedule(
  'vitana_id_mirror_reconcile_daily',
  '15 3 * * *',
  $cron$ SELECT public.vitana_id_mirror_reconcile() $cron$
);

-- 2. Match TTL archival.
CREATE OR REPLACE FUNCTION public.intent_matches_archive_old()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_archived int := 0;
BEGIN
  -- Only archive if the archive table exists (P2-C scaffold).
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='intent_matches_archive') THEN
    RAISE NOTICE 'intent_matches_archive table missing — skipping';
    RETURN 0;
  END IF;

  WITH moved AS (
    DELETE FROM public.intent_matches im
     WHERE im.state IN ('closed','fulfilled','declined')
       AND im.created_at < now() - interval '90 days'
    RETURNING im.*
  )
  INSERT INTO public.intent_matches_archive
  SELECT * FROM moved;

  GET DIAGNOSTICS v_archived = ROW_COUNT;
  RETURN v_archived;
END;
$$;

COMMENT ON FUNCTION public.intent_matches_archive_old() IS
  'D8: archives terminal-state matches >90 days old to intent_matches_archive. Reduces hot-path table size; cold queries hit the archive instead.';

DO $$
BEGIN
  PERFORM cron.unschedule('intent_matches_archive_daily');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'intent_matches_archive_daily',
  '30 3 * * *',
  $cron$ SELECT public.intent_matches_archive_old() $cron$
);
