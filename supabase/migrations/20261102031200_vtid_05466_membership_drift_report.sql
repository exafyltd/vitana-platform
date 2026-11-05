-- VTID-05466 (mt-identity-r2 / membership-unification, M3): nightly membership drift report.
--
-- Apply after 20261102031000_vtid_05466_user_tenants_canonical.sql, in its own RUN-MIGRATION dispatch,
-- only after the owner approves the files and the target database (collaboration.md §7d).
--
-- public.membership_drift_report() counts, read-only, how far the legacy public.memberships rows and
-- the canonical public.user_tenants rows disagree. Bot user 00000000-0000-0000-0000-000000000001 and
-- every public.service_bot_accounts user are left out of every member count (counted separately as
-- excluded_bot_rows). `drift` is the sum of both directions and reads 0 when the two stores are
-- converged:
--   memberships_not_in_user_tenants  active memberships rows of an app_users user with no user_tenants
--                                    row (what 20261102031000 backfills; 0 right after it)
--   user_tenants_not_in_memberships  user_tenants rows with no memberships row (closes when memberships
--                                    is derived from user_tenants, M2)
-- Informational, not in `drift`: memberships rows whose user has no app_users row (deleted accounts,
-- VTID-05124) and non-active memberships rows that do have a user_tenants row (status_mismatch).
--
-- public.record_membership_drift_report() stores one row per run in public.membership_drift_reports;
-- pg_cron runs it nightly at 02:20 UTC where the extension exists (Supabase). The table and both
-- functions are service-role-only: REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT to
-- service_role; RLS on, no policy.
--
-- Rollback: 20261102031000_vtid_05466_membership_unification_rollback.sql.

-- impact-allow-solo-migration: a new read-only report; no code reads it yet.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.membership_drift_reports (
  id                              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  generated_at                    timestamptz NOT NULL DEFAULT now(),
  drift                           integer NOT NULL,
  memberships_not_in_user_tenants integer NOT NULL,
  user_tenants_not_in_memberships integer NOT NULL,
  memberships_without_app_user    integer NOT NULL,
  status_mismatch                 integer NOT NULL,
  excluded_bot_rows               integer NOT NULL,
  report                          jsonb NOT NULL
);

COMMENT ON TABLE public.membership_drift_reports IS
  'VTID-05466: one row per nightly membership drift report (memberships vs user_tenants). '
  'drift = 0 when converged. Service role only.';

REVOKE ALL ON public.membership_drift_reports FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.membership_drift_reports TO service_role;
ALTER TABLE public.membership_drift_reports ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.membership_drift_report()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_bot        constant uuid := '00000000-0000-0000-0000-000000000001';
  v_m_not_ut   integer;
  v_ut_not_m   integer;
  v_no_app     integer;
  v_status     integer;
  v_bots       integer;
BEGIN
  SELECT count(*) INTO v_m_not_ut
    FROM public.memberships m
   WHERE m.status = 'active'
     AND m.user_id <> v_bot
     AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = m.user_id)
     AND EXISTS (SELECT 1 FROM public.app_users au WHERE au.user_id = m.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.user_tenants ut
                      WHERE ut.tenant_id = m.tenant_id AND ut.user_id = m.user_id);

  SELECT count(*) INTO v_ut_not_m
    FROM public.user_tenants ut
   WHERE ut.user_id <> v_bot
     AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = ut.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.memberships m
                      WHERE m.tenant_id = ut.tenant_id AND m.user_id = ut.user_id);

  SELECT count(*) INTO v_no_app
    FROM public.memberships m
   WHERE m.user_id <> v_bot
     AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = m.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.app_users au WHERE au.user_id = m.user_id);

  SELECT count(*) INTO v_status
    FROM public.memberships m
    JOIN public.user_tenants ut ON ut.tenant_id = m.tenant_id AND ut.user_id = m.user_id
   WHERE m.status <> 'active'
     AND m.user_id <> v_bot
     AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = m.user_id);

  SELECT (SELECT count(*) FROM public.memberships m
           WHERE m.user_id = v_bot
              OR EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = m.user_id))
       + (SELECT count(*) FROM public.user_tenants ut
           WHERE ut.user_id = v_bot
              OR EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = ut.user_id))
    INTO v_bots;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'drift', v_m_not_ut + v_ut_not_m,
    'memberships_not_in_user_tenants', v_m_not_ut,
    'user_tenants_not_in_memberships', v_ut_not_m,
    'memberships_without_app_user', v_no_app,
    'status_mismatch', v_status,
    'excluded_bot_rows', v_bots
  );
END
$fn$;

COMMENT ON FUNCTION public.membership_drift_report() IS
  'VTID-05466: read-only memberships vs user_tenants drift counts, bots and service accounts '
  'excluded; drift = 0 when converged. Service role only.';

CREATE OR REPLACE FUNCTION public.record_membership_drift_report()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE r jsonb := public.membership_drift_report();
BEGIN
  INSERT INTO public.membership_drift_reports
         (generated_at, drift, memberships_not_in_user_tenants, user_tenants_not_in_memberships,
          memberships_without_app_user, status_mismatch, excluded_bot_rows, report)
  VALUES ((r ->> 'generated_at')::timestamptz,
          (r ->> 'drift')::int,
          (r ->> 'memberships_not_in_user_tenants')::int,
          (r ->> 'user_tenants_not_in_memberships')::int,
          (r ->> 'memberships_without_app_user')::int,
          (r ->> 'status_mismatch')::int,
          (r ->> 'excluded_bot_rows')::int,
          r);
  RETURN r;
END
$fn$;

COMMENT ON FUNCTION public.record_membership_drift_report() IS
  'VTID-05466: stores one membership_drift_report() row in membership_drift_reports (nightly, pg_cron). '
  'Service role only.';

REVOKE ALL ON FUNCTION public.membership_drift_report() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_membership_drift_report() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.membership_drift_report() TO service_role;
GRANT EXECUTE ON FUNCTION public.record_membership_drift_report() TO service_role;

-- Nightly schedule, only where pg_cron exists (a throwaway Postgres or Aurora skips it).
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'membership-drift-report-nightly') THEN
      PERFORM cron.unschedule('membership-drift-report-nightly');
    END IF;
    PERFORM cron.schedule('membership-drift-report-nightly', '20 2 * * *',
                          'SELECT public.record_membership_drift_report()');
  END IF;
END
$cron$;

-- Self-check: service-role-only, by effect.
DO $check$
DECLARE r text; p text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF has_table_privilege(r, 'public.membership_drift_reports', p) THEN
        RAISE EXCEPTION 'VTID-05466 self-check: % has % on membership_drift_reports', r, p;
      END IF;
    END LOOP;
    IF has_function_privilege(r, 'public.membership_drift_report()', 'EXECUTE')
       OR has_function_privilege(r, 'public.record_membership_drift_report()', 'EXECUTE') THEN
      RAISE EXCEPTION 'VTID-05466 self-check: % can execute a drift report function', r;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role', 'public.membership_drift_reports', 'SELECT') THEN
    RAISE EXCEPTION 'VTID-05466 self-check: service_role cannot read membership_drift_reports';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'membership_drift_reports') THEN
    RAISE EXCEPTION 'VTID-05466 self-check: membership_drift_reports must have no policy';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.membership_drift_reports'::regclass) THEN
    RAISE EXCEPTION 'VTID-05466 self-check: RLS is off on membership_drift_reports';
  END IF;
END
$check$;

COMMIT;
