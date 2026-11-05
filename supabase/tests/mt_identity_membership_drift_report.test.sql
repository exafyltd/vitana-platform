-- VTID-05466 (mt-identity-r2 / membership-unification) — pgTAP: the membership drift report.
-- Runs with `supabase test db` (pg_prove) on the local stack, after every migration including
-- 20261102031000_vtid_05466_user_tenants_canonical.sql and 20261102031200_vtid_05466_membership_drift_report.sql.
-- One transaction, rolled back at the end. The local stack may carry seed rows, so counts are checked
-- as deltas against a baseline taken inside this transaction.
--
-- Covers: drift counts move by exactly the rows this test adds; the bot and service accounts are left
-- out of every member count; the memberships -> user_tenants direction reads its baseline again after
-- the backfill; the recorder stores one row; the table and both functions are service-role-only
-- (REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT to service_role; RLS on, no policy).
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(18);

CREATE TEMP TABLE t05466d_ids (k text PRIMARY KEY, v uuid NOT NULL);
INSERT INTO t05466d_ids VALUES
  ('A',   '05466000-0000-4000-8000-0000000000d1'),  -- active membership only
  ('U',   '05466000-0000-4000-8000-0000000000d2'),  -- user_tenants only
  ('S',   '05466000-0000-4000-8000-0000000000d3'),  -- service account, membership only
  ('BOT', '00000000-0000-0000-0000-000000000001');
CREATE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT v FROM t05466d_ids WHERE k = p $$;
CREATE FUNCTION pg_temp.r(p jsonb, k text) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT (p ->> k)::int $$;

CREATE TEMP TABLE t05466d_r (step text PRIMARY KEY, r jsonb NOT NULL);
INSERT INTO t05466d_r VALUES ('base', public.membership_drift_report());

DO $fx$
DECLARE r jsonb;
BEGIN
  INSERT INTO public.tenants (name, slug)
  VALUES ('VTID-05466 drift test tenant', 'vtid-05466-drift-test')
  RETURNING to_jsonb(tenants.*) INTO r;
  INSERT INTO t05466d_ids VALUES ('T', coalesce(r ->> 'tenant_id', r ->> 'id')::uuid);
END
$fx$;

INSERT INTO public.app_users (user_id, email, display_name)
SELECT v, 'vtid05466d-' || lower(k) || '@vitanatest.exafy.io', 'VTID-05466 ' || k
  FROM t05466d_ids WHERE k IN ('A', 'U', 'S', 'BOT')
ON CONFLICT (user_id) DO NOTHING;
INSERT INTO public.service_bot_accounts (user_id, label, reason)
VALUES (pg_temp.id('S'), 'vtid-05466-drift-test', 'VTID-05466 pgTAP fixture')
ON CONFLICT (user_id) DO NOTHING;

SELECT set_config('vitana.suppress_membership_side_effects', 'on', true);
INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
VALUES (pg_temp.id('T'), pg_temp.id('U'), 'community', false);
SELECT set_config('vitana.suppress_membership_side_effects', '', true);

INSERT INTO public.memberships (user_id, tenant_id, role, status) VALUES
  (pg_temp.id('A'),   pg_temp.id('T'), 'community', 'active'),
  (pg_temp.id('S'),   pg_temp.id('T'), 'community', 'active'),
  (pg_temp.id('BOT'), pg_temp.id('T'), 'community', 'active')
ON CONFLICT (user_id, tenant_id) DO NOTHING;

INSERT INTO t05466d_r VALUES ('drifted', public.membership_drift_report());

SELECT is(pg_temp.r((SELECT r FROM t05466d_r WHERE step = 'drifted'), 'memberships_not_in_user_tenants')
        - pg_temp.r((SELECT r FROM t05466d_r WHERE step = 'base'), 'memberships_not_in_user_tenants'), 1,
  'memberships -> user_tenants drift counts the one real member and neither the bot nor the service account');
SELECT is(pg_temp.r((SELECT r FROM t05466d_r WHERE step = 'drifted'), 'user_tenants_not_in_memberships')
        - pg_temp.r((SELECT r FROM t05466d_r WHERE step = 'base'), 'user_tenants_not_in_memberships'), 1,
  'user_tenants -> memberships drift counts the user_tenants-only member');
SELECT ok(pg_temp.r((SELECT r FROM t05466d_r WHERE step = 'drifted'), 'excluded_bot_rows')
        > pg_temp.r((SELECT r FROM t05466d_r WHERE step = 'base'), 'excluded_bot_rows'),
  'the bot and service-account rows are counted only as excluded_bot_rows');
SELECT is(pg_temp.r((SELECT r FROM t05466d_r WHERE step = 'drifted'), 'drift'),
          pg_temp.r((SELECT r FROM t05466d_r WHERE step = 'drifted'), 'memberships_not_in_user_tenants')
        + pg_temp.r((SELECT r FROM t05466d_r WHERE step = 'drifted'), 'user_tenants_not_in_memberships'),
  'drift is the sum of both directions');

SELECT is(public.mt_backfill_memberships_to_user_tenants(), 1, 'the backfill closes the one real drifted row');
INSERT INTO t05466d_r VALUES ('after', public.membership_drift_report());
SELECT is(pg_temp.r((SELECT r FROM t05466d_r WHERE step = 'after'), 'memberships_not_in_user_tenants'),
          pg_temp.r((SELECT r FROM t05466d_r WHERE step = 'base'), 'memberships_not_in_user_tenants'),
  'after the backfill the memberships -> user_tenants direction is back at its baseline');

-- Recorder.
SELECT lives_ok($$SELECT public.record_membership_drift_report()$$, 'the nightly recorder runs');
SELECT is((SELECT drift FROM public.membership_drift_reports ORDER BY id DESC LIMIT 1),
          pg_temp.r((SELECT r FROM t05466d_r WHERE step = 'after'), 'drift'),
  'the recorder stores the report''s drift');

-- Service-role-only.
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.membership_drift_reports'::regclass),
  'RLS is on for membership_drift_reports');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename = 'membership_drift_reports'), 0,
  'membership_drift_reports has no policy');
SELECT ok(NOT has_table_privilege('authenticated', 'public.membership_drift_reports', 'SELECT'),
  'authenticated cannot read the drift reports');
SELECT ok(NOT has_table_privilege('anon', 'public.membership_drift_reports', 'SELECT'),
  'anon cannot read the drift reports');
SELECT ok(has_table_privilege('service_role', 'public.membership_drift_reports', 'SELECT')
          AND has_table_privilege('service_role', 'public.membership_drift_reports', 'INSERT'),
  'service_role can read and write the drift reports');
SELECT ok(NOT has_function_privilege('authenticated', 'public.membership_drift_report()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.record_membership_drift_report()', 'EXECUTE'),
  'authenticated cannot execute the drift functions');
SELECT ok(NOT has_function_privilege('anon', 'public.membership_drift_report()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.record_membership_drift_report()', 'EXECUTE'),
  'anon cannot execute the drift functions');
SELECT ok(has_function_privilege('service_role', 'public.membership_drift_report()', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.record_membership_drift_report()', 'EXECUTE'),
  'service_role can execute the drift functions');

SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT count(*) FROM public.membership_drift_reports$$, '42501', NULL,
  'a member reading the drift reports is refused');
SELECT throws_ok($$SELECT public.membership_drift_report()$$, '42501', NULL,
  'a member running the drift report is refused');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
