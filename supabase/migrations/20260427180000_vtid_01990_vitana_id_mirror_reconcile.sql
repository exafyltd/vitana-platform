-- VTID-01990: Daily Vitana ID mirror reconcile (defense-in-depth)
--
-- The mirror trigger (vitana-v1 / 20260427000400_vitana_id_mirror_trigger.sql)
-- keeps app_users.vitana_id in sync with profiles.vitana_id. That trigger is
-- the only writer; application code never touches app_users.vitana_id directly.
--
-- This is cheap insurance: if any code path ever writes app_users.vitana_id
-- directly, or the trigger is dropped/disabled, profiles and app_users will
-- silently de-sync. This job detects drift, repairs it from the source of
-- truth (profiles), and emits an OASIS event so on-call sees it.
--
-- Schedule: daily at 04:00 UTC (one hour after oasis-events-retention).

CREATE OR REPLACE FUNCTION public.reconcile_vitana_id_mirror()
RETURNS TABLE (drift_count int, repaired_count int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_drift int := 0;
  v_repaired int := 0;
  v_sample jsonb;
BEGIN
  -- Count drift before repair (rows where app_users.vitana_id disagrees
  -- with profiles.vitana_id, including missing-from-app_users cases).
  SELECT count(*)::int INTO v_drift
    FROM public.profiles p
    JOIN public.app_users au ON au.user_id = p.user_id
   WHERE p.vitana_id IS DISTINCT FROM au.vitana_id;

  IF v_drift > 0 THEN
    -- Capture up to 10 sample drift rows for the event payload.
    SELECT jsonb_agg(jsonb_build_object(
             'user_id',             d.user_id,
             'profiles_vitana_id',  d.profiles_vitana_id,
             'app_users_vitana_id', d.app_users_vitana_id
           ))
      INTO v_sample
      FROM (
        SELECT p.user_id,
               p.vitana_id  AS profiles_vitana_id,
               au.vitana_id AS app_users_vitana_id
          FROM public.profiles p
          JOIN public.app_users au ON au.user_id = p.user_id
         WHERE p.vitana_id IS DISTINCT FROM au.vitana_id
         LIMIT 10
      ) d;

    -- Repair from source of truth.
    WITH repair AS (
      UPDATE public.app_users au
         SET vitana_id = p.vitana_id
        FROM public.profiles p
       WHERE au.user_id = p.user_id
         AND p.vitana_id IS DISTINCT FROM au.vitana_id
       RETURNING au.user_id
    )
    SELECT count(*)::int INTO v_repaired FROM repair;

    INSERT INTO public.oasis_events (
      topic, source, status, vtid, metadata, message
    ) VALUES (
      'vitana_id.mirror.drift_detected',
      'reconcile-vitana-id-mirror',
      'warning',
      'VTID-01990',
      jsonb_build_object(
        'drift_count', v_drift,
        'repaired_count', v_repaired,
        'sample', COALESCE(v_sample, '[]'::jsonb)
      ),
      format('vitana_id mirror drift detected: %s rows out of sync, %s repaired', v_drift, v_repaired)
    );
  ELSE
    INSERT INTO public.oasis_events (
      topic, source, status, vtid, metadata, message
    ) VALUES (
      'vitana_id.mirror.reconcile_clean',
      'reconcile-vitana-id-mirror',
      'info',
      'VTID-01990',
      jsonb_build_object('drift_count', 0),
      'vitana_id mirror reconcile: 0 drift'
    );
  END IF;

  RETURN QUERY SELECT v_drift, v_repaired;
END;
$$;

COMMENT ON FUNCTION public.reconcile_vitana_id_mirror() IS
  'Defense-in-depth: detects + repairs drift between profiles.vitana_id and app_users.vitana_id. Emits OASIS event vitana_id.mirror.drift_detected (warning) or .reconcile_clean (info). Cron-driven daily.';

GRANT EXECUTE ON FUNCTION public.reconcile_vitana_id_mirror() TO service_role;

-- Schedule via pg_cron. Daily at 04:00 UTC. Idempotent — uses unschedule
-- guard so re-running this migration won't error.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Drop any prior schedule with the same name before re-creating.
    PERFORM cron.unschedule(jobid)
       FROM cron.job
      WHERE jobname = 'vitana-id-mirror-reconcile';

    PERFORM cron.schedule(
      'vitana-id-mirror-reconcile',
      '0 4 * * *',
      $cron$SELECT public.reconcile_vitana_id_mirror()$cron$
    );

    RAISE NOTICE 'pg_cron: scheduled vitana-id-mirror-reconcile (daily 04:00 UTC)';
  ELSE
    RAISE NOTICE 'pg_cron not available — call reconcile_vitana_id_mirror() manually';
  END IF;
END$$;
