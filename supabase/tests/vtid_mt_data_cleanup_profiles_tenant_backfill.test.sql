-- VTID-05572 (mt-data-cleanup-r2 / profiles-tenant-backfill) — pgTAP: profiles.tenant_id backfill, listing, never
-- Maxina, snapshot and rollback (tasks P1, P2, P4).
-- Runs with `supabase test db` (pg_prove) after every migration including
-- 20261102042000_vtid_05572_profiles_tenant_backfill_fn.sql. The apply file (042100) is a thin caller of
-- mt_profiles_tenant_backfill_run(), so this test drives the function directly. One transaction, rolled back at the end.
-- The test inserts its own tenants, users and profiles and asserts only on those rows (it never depends on rows that
-- already exist or on absolute counts).
--
-- Covers:
--  * a member with exactly one membership gets that tenant;
--  * a member with no membership and a member with two memberships stay NULL and are listed (never defaulted);
--  * a profile that already has a tenant_id is never overwritten; a service-bot account is never backfilled;
--  * no own profile ends up in a tenant it is not a member of;
--  * the snapshot holds the prior value, a second run is a no-op, the column is still nullable;
--  * nothing here is executable by anon/authenticated;
--  * the restore reverts only what the backfill set, keeps a later change, and a re-run re-applies.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(22);

-- Fixture ---------------------------------------------------------------------------------------
CREATE TEMP TABLE t05572_ids (k text PRIMARY KEY, v uuid NOT NULL);
INSERT INTO t05572_ids VALUES
  ('U1', '05572000-0000-4000-8000-0000000000a1'),  -- exactly one membership (TA), profile NULL
  ('U0', '05572000-0000-4000-8000-0000000000a2'),  -- no membership, profile NULL
  ('U2', '05572000-0000-4000-8000-0000000000a3'),  -- two memberships (TA, TB), profile NULL
  ('U3', '05572000-0000-4000-8000-0000000000a4'),  -- one membership (TA) but profile already in TB
  ('US', '05572000-0000-4000-8000-0000000000a5');  -- service-bot account with one membership (TB)

CREATE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT v FROM t05572_ids WHERE k = p $$;

DO $fx$
DECLARE r jsonb;
BEGIN
  INSERT INTO public.tenants (name, slug) VALUES ('VTID-05572 tenant A', 'vtid-05572-a') RETURNING to_jsonb(tenants.*) INTO r;
  INSERT INTO t05572_ids VALUES ('TA', coalesce(r ->> 'tenant_id', r ->> 'id')::uuid);
  INSERT INTO public.tenants (name, slug) VALUES ('VTID-05572 tenant B', 'vtid-05572-b') RETURNING to_jsonb(tenants.*) INTO r;
  INSERT INTO t05572_ids VALUES ('TB', coalesce(r ->> 'tenant_id', r ->> 'id')::uuid);
END
$fx$;

-- Membership rows: the primary-membership side-effect triggers stay silent (as in the 05466 / 05571 tests).
SELECT set_config('vitana.suppress_membership_side_effects', 'on', true);

INSERT INTO auth.users (id, email)
SELECT v, 'vtid05572-' || lower(k) || '@vitanatest.exafy.io' FROM t05572_ids WHERE k IN ('U1', 'U0', 'U2', 'U3', 'US')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.app_users (user_id, email, display_name)
SELECT v, 'vtid05572-' || lower(k) || '@vitanatest.exafy.io', 'VTID-05572 ' || k
  FROM t05572_ids WHERE k IN ('U1', 'U0', 'U2', 'U3', 'US')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES
  (pg_temp.id('TA'), pg_temp.id('U1'), true),
  (pg_temp.id('TA'), pg_temp.id('U2'), true),
  (pg_temp.id('TB'), pg_temp.id('U2'), false),
  (pg_temp.id('TA'), pg_temp.id('U3'), true),
  (pg_temp.id('TB'), pg_temp.id('US'), true);

INSERT INTO public.service_bot_accounts (user_id, label, reason)
VALUES (pg_temp.id('US'), 'vtid-05572 test bot', 'pgTAP fixture');

-- Profiles: all NULL except U3, which already holds TB (and must keep it).
INSERT INTO public.profiles (user_id)
SELECT v FROM t05572_ids WHERE k IN ('U1', 'U0', 'U2', 'US')
ON CONFLICT (user_id) DO UPDATE SET tenant_id = NULL;
INSERT INTO public.profiles (user_id, tenant_id) VALUES (pg_temp.id('U3'), pg_temp.id('TB'))
ON CONFLICT (user_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id;

CREATE FUNCTION pg_temp.ptenant(p text) RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT tenant_id FROM public.profiles WHERE user_id = pg_temp.id(p) $$;
CREATE FUNCTION pg_temp.reason(p text) RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT reason FROM legacy_archive.mt_profiles_tenant_unresolved WHERE user_id = pg_temp.id(p) $$;

-- Privileges ------------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('anon', 'public.mt_profiles_tenant_backfill_run()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.mt_profiles_tenant_backfill_run()', 'EXECUTE'),
  'the backfill function is not executable by anon or authenticated');
SELECT ok(NOT has_function_privilege('anon', 'public.mt_profiles_tenant_restore()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.mt_profiles_tenant_restore()', 'EXECUTE'),
  'the restore function is not executable by anon or authenticated');

-- Backfill --------------------------------------------------------------------------------------
CREATE TEMP TABLE t05572_run1 AS SELECT public.mt_profiles_tenant_backfill_run() AS r;

SELECT is(pg_temp.ptenant('U1'), pg_temp.id('TA'), 'single-membership member gets its tenant');
SELECT is(pg_temp.ptenant('U0'), NULL::uuid, 'a member with no membership stays NULL');
SELECT is(pg_temp.ptenant('U2'), NULL::uuid, 'a member with two memberships stays NULL');
SELECT is(pg_temp.ptenant('U3'), pg_temp.id('TB'), 'an existing tenant_id is never overwritten');
SELECT is(pg_temp.ptenant('US'), NULL::uuid, 'a service-bot account is never backfilled');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM public.profiles p
   WHERE p.user_id IN (SELECT v FROM t05572_ids WHERE k IN ('U1', 'U0', 'U2', 'U3', 'US'))
     AND p.tenant_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = p.user_id AND ut.tenant_id = p.tenant_id)
     AND p.user_id <> pg_temp.id('U3')),
  'no backfilled profile holds a tenant it is not a member of (nobody defaulted to Maxina)');

SELECT is(pg_temp.reason('U0'), 'no_membership', 'the member with no membership is listed as no_membership');
SELECT is(pg_temp.reason('U2'), 'multiple_memberships', 'the member with two memberships is listed as multiple_memberships');
SELECT is(pg_temp.reason('U1'), NULL::text, 'a resolved member is not listed');
SELECT is(pg_temp.reason('US'), NULL::text, 'a service-bot account is not listed');

SELECT is((SELECT membership_count FROM legacy_archive.mt_profiles_tenant_unresolved WHERE user_id = pg_temp.id('U2')), 2,
  'the listing records the membership count');

-- Snapshot --------------------------------------------------------------------------------------
SELECT is((SELECT count(*)::int FROM legacy_archive.bak_mt_data_cleanup_profiles
            WHERE user_id IN (SELECT v FROM t05572_ids) AND tenant_id_before IS NULL), 4,
  'the snapshot holds the NULL prior value of the four NULL profiles');
SELECT is((SELECT tenant_id_before FROM legacy_archive.bak_mt_data_cleanup_profiles WHERE user_id = pg_temp.id('U3')),
  pg_temp.id('TB'), 'the snapshot holds the prior non-NULL value');

-- Idempotent, nullable ----------------------------------------------------------------------------
SELECT is((public.mt_profiles_tenant_backfill_run() ->> 'set')::int, 0, 'a second run sets nothing');
SELECT is((SELECT is_nullable FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'tenant_id'), 'YES',
  'profiles.tenant_id is still nullable');

-- Restore ---------------------------------------------------------------------------------------
-- A later change of one backfilled profile must survive the restore.
CREATE TEMP TABLE t05572_logged AS
  SELECT user_id FROM legacy_archive.mt_profiles_tenant_backfill_log WHERE user_id IN (SELECT v FROM t05572_ids);
SELECT is((SELECT count(*)::int FROM t05572_logged), 1, 'the log holds exactly this test''s one backfilled profile');

SELECT lives_ok($$ SELECT public.mt_profiles_tenant_restore() $$, 'the restore runs');
SELECT is(pg_temp.ptenant('U1'), NULL::uuid, 'the restore puts the snapshot value back for the backfilled profile');
SELECT is(pg_temp.ptenant('U3'), pg_temp.id('TB'), 'the restore leaves profiles the backfill did not touch alone');

-- Re-run re-applies; then a later manual change is kept by the restore.
SELECT public.mt_profiles_tenant_backfill_run();
UPDATE public.profiles SET tenant_id = pg_temp.id('TB') WHERE user_id = pg_temp.id('U1');
SELECT public.mt_profiles_tenant_restore();
SELECT is(pg_temp.ptenant('U1'), pg_temp.id('TB'), 'the restore keeps a value changed after the backfill');

SELECT * FROM finish();
ROLLBACK;
