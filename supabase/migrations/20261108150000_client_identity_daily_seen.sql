-- VTID-05658 — client_identity_daily_seen: one row per (day, tenant, member, client class).
-- Native-app adoption measurement (plan native-wave3-release-r2, lane client-identity-store).
-- Written best-effort by the gateway middleware (service role); only aggregates are ever read out.
-- FILE ONLY: applied after the owner approves this file and the target database (collaboration.md §7d).

CREATE TABLE IF NOT EXISTS public.client_identity_daily_seen (
  day          DATE NOT NULL,
  tenant_id    UUID NOT NULL,
  user_id      UUID NOT NULL,
  client_class TEXT NOT NULL CHECK (client_class IN ('native', 'web')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, tenant_id, user_id, client_class)
);

-- RLS on with NO policy: anon/authenticated see nothing; the gateway's service role bypasses RLS.
ALTER TABLE public.client_identity_daily_seen ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_identity_daily_seen FROM anon, authenticated;

COMMENT ON TABLE public.client_identity_daily_seen IS
  'VTID-05658: members seen per UTC day and client class (native|web). 35-day retention. Service role only.';

-- 35-day purge.
CREATE OR REPLACE FUNCTION public.purge_client_identity_daily_seen()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted BIGINT;
BEGIN
  DELETE FROM public.client_identity_daily_seen WHERE day < (now() AT TIME ZONE 'utc')::date - 35;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;
REVOKE ALL ON FUNCTION public.purge_client_identity_daily_seen() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_client_identity_daily_seen() TO service_role;

-- Daily at 03:30 UTC when pg_cron exists; otherwise the function can be called by any scheduler.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-client-identity-daily-seen';
    PERFORM cron.schedule('purge-client-identity-daily-seen', '30 3 * * *',
                          'SELECT public.purge_client_identity_daily_seen()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END $$;
