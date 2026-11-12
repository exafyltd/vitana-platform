-- VTID-05595 (mt-native-health-r2/health-home-tenant-db) H4 - pgTAP: app_users.health_home_tenant_id,
-- public.health_home_tenant_id(uuid) and public.backfill_health_home_tenant(int).
-- Runs on a throwaway Postgres after the two lane migrations 20261102130000 and 20261102130100.
-- One transaction, rolled back at the end: never a shared or live database. The test inserts its own tenants, users
-- and memberships and asserts only about them (no absolute counts, no rows left behind by a harness).
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(40);

CREATE SCHEMA t05595;
GRANT USAGE ON SCHEMA t05595 TO authenticated, anon, service_role;

CREATE FUNCTION t05595.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('05595000-0000-4000-8000-00000000' || lpad(n::text, 4, '0'))::uuid $$;

-- Inserts a tenant and returns its key (live key tenants.tenant_id, bootstrap key tenants.id).
CREATE FUNCTION t05595.mk_tenant(p_slug text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_key text; v_id uuid;
BEGIN
  SELECT c.column_name INTO v_key FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'tenants' AND c.column_name IN ('tenant_id', 'id')
   ORDER BY (c.column_name = 'tenant_id') DESC LIMIT 1;
  EXECUTE format('INSERT INTO public.tenants (slug, name) VALUES (%L, %L) RETURNING %I', p_slug, p_slug, v_key) INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION t05595.mk_member(p_n int, p_tenant uuid, p_primary boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.app_users (user_id, email) VALUES (t05595.u(p_n), 't05595-' || p_n || '@example.invalid')
    ON CONFLICT (user_id) DO NOTHING;
  IF p_tenant IS NOT NULL THEN
    INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES (p_tenant, t05595.u(p_n), p_primary);
  END IF;
END $$;

-- First column of the first row of p_sql run as role p_role with auth.uid() = p_uid and optional extra JWT claims
-- ('error:<SQLSTATE>' on failure, 'null' for SQL NULL).
CREATE FUNCTION t05595.val(p_role text, p_uid uuid, p_sql text, p_claims jsonb DEFAULT '{}') RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    (jsonb_build_object('role', p_role) || p_claims
       || CASE WHEN p_uid IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sub', p_uid) END)::text, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql INTO v;
    v := coalesce(v, 'null');
  EXCEPTION WHEN OTHERS THEN
    v := 'error:' || SQLSTATE;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v;
END $$;

CREATE FUNCTION t05595.home(p_role text, p_n int, p_claims jsonb DEFAULT '{}') RETURNS text LANGUAGE sql AS $$
  SELECT t05595.val(p_role, NULL, format('SELECT public.health_home_tenant_id(%L::uuid)::text', t05595.u(p_n)), p_claims)
$$;
CREATE FUNCTION t05595.col(p_n int) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce((SELECT health_home_tenant_id::text FROM public.app_users WHERE user_id = t05595.u(p_n)), 'null')
$$;

-- Fixture (all rows are this test's own).
CREATE TEMP TABLE t05595_t (k text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;
INSERT INTO t05595_t VALUES ('a', t05595.mk_tenant('t05595-a')), ('b', t05595.mk_tenant('t05595-b'));
GRANT SELECT ON t05595_t TO PUBLIC;

-- u1 ab_dual: primary in A, member of B. u2 single primary in B. u3 two primaries. u4 member with no primary.
-- u5 no membership. u6 already frozen to B while its primary is A (frozen value wins, backfill must not touch it).
SELECT t05595.mk_member(1, (SELECT id FROM t05595_t WHERE k = 'a'), true);
SELECT t05595.mk_member(1, (SELECT id FROM t05595_t WHERE k = 'b'), false);
SELECT t05595.mk_member(2, (SELECT id FROM t05595_t WHERE k = 'b'), true);
SELECT t05595.mk_member(3, (SELECT id FROM t05595_t WHERE k = 'a'), true);
SELECT t05595.mk_member(3, (SELECT id FROM t05595_t WHERE k = 'b'), true);
SELECT t05595.mk_member(4, (SELECT id FROM t05595_t WHERE k = 'a'), false);
SELECT t05595.mk_member(5, NULL, false);
SELECT t05595.mk_member(6, (SELECT id FROM t05595_t WHERE k = 'a'), true);
UPDATE public.app_users SET health_home_tenant_id = (SELECT id FROM t05595_t WHERE k = 'b') WHERE user_id = t05595.u(6);

-- 1-4 shape
SELECT has_function('public', 'health_home_tenant_id', 'resolver exists');
SELECT has_function('public', 'backfill_health_home_tenant', 'backfill function exists');
SELECT ok(EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'app_users' AND column_name = 'health_home_tenant_id'
                     AND is_nullable = 'YES' AND data_type = 'uuid'),
          'app_users.health_home_tenant_id is a nullable uuid');
SELECT ok(EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'app_users'
                   AND indexname = 'idx_app_users_health_home_tenant'), 'the column is indexed');

-- 5-7 resolver definition
SELECT ok((SELECT p.prosecdef AND p.provolatile = 's' FROM pg_proc p WHERE p.oid = 'public.health_home_tenant_id(uuid)'::regprocedure),
          'resolver is STABLE SECURITY DEFINER');
SELECT ok((SELECT coalesce(p.proconfig::text, '') ~ 'search_path' FROM pg_proc p WHERE p.oid = 'public.health_home_tenant_id(uuid)'::regprocedure),
          'resolver pins its search_path');
SELECT ok((SELECT p.prosrc !~* 'app_metadata|jwt|current_setting|current_tenant_id' FROM pg_proc p WHERE p.oid = 'public.health_home_tenant_id(uuid)'::regprocedure),
          'resolver never reads app_metadata, a JWT claim, a setting or the session tenant');

-- 8-14 resolver before any backfill: column first, then the single primary row, never a guess
SELECT is(t05595.home('service_role', 1), (SELECT id::text FROM t05595_t WHERE k = 'a'), 'ab_dual member resolves to the primary tenant');
SELECT is(t05595.home('service_role', 1, jsonb_build_object('app_metadata', jsonb_build_object('tenant_id', (SELECT id FROM t05595_t WHERE k = 'b')))),
          (SELECT id::text FROM t05595_t WHERE k = 'a'), 'ab_dual member resolves the same with the other tenant in the session claims');
SELECT is(t05595.home('service_role', 2), (SELECT id::text FROM t05595_t WHERE k = 'b'), 'single-primary member resolves to that tenant');
SELECT is(t05595.home('service_role', 3), 'null', 'two primary rows resolve to NULL');
SELECT is(t05595.home('service_role', 4), 'null', 'a member with no primary row resolves to NULL');
SELECT is(t05595.home('service_role', 5), 'null', 'a user with no membership resolves to NULL');
SELECT is(t05595.home('service_role', 6), (SELECT id::text FROM t05595_t WHERE k = 'b'), 'a frozen column wins over the primary row');

-- 15-17 who may call it
SELECT is(t05595.home('authenticated', 1), 'error:42501', 'authenticated cannot execute the resolver');
SELECT is(t05595.home('anon', 1), 'error:42501', 'anon cannot execute the resolver');
SELECT is(t05595.val('authenticated', t05595.u(1), format('SELECT public.backfill_health_home_tenant(10)::text')), 'error:42501',
          'authenticated cannot execute the backfill');

-- 18-20 backfill freezes exactly the unambiguous members, once
SELECT is(t05595.col(1), 'null', 'before the backfill the column of an unambiguous member is NULL');
SELECT ok(t05595.val('service_role', NULL, 'SELECT public.backfill_health_home_tenant(1)::text')::bigint >= 2,
          'the backfill (batch size 1, so it loops) freezes at least the two unambiguous members');
SELECT is(t05595.col(1) || '/' || t05595.col(2),
          (SELECT id::text FROM t05595_t WHERE k = 'a') || '/' || (SELECT id::text FROM t05595_t WHERE k = 'b'),
          'ab_dual and single-primary members are frozen to their primary tenant');

-- 21-24 ambiguous members and the already-frozen member are untouched
SELECT is(t05595.col(3), 'null', 'two primary rows stay NULL');
SELECT is(t05595.col(4), 'null', 'no primary row stays NULL');
SELECT is(t05595.col(5), 'null', 'no membership stays NULL');
SELECT is(t05595.col(6), (SELECT id::text FROM t05595_t WHERE k = 'b'), 'an already-frozen column is not overwritten');

-- 25-28 snapshot
SELECT is((SELECT new_health_home_tenant_id::text FROM legacy_archive.bak_05595_health_home_tenant WHERE user_id = t05595.u(1)),
          (SELECT id::text FROM t05595_t WHERE k = 'a'), 'the snapshot holds the frozen value of a backfilled member');
SELECT ok((SELECT previous_health_home_tenant_id IS NULL AND keep_until >= snapshot_at + interval '29 days'
             FROM legacy_archive.bak_05595_health_home_tenant WHERE user_id = t05595.u(1)),
          'the snapshot holds the previous (NULL) value and a 30-day retention');
SELECT is((SELECT count(*)::int FROM legacy_archive.bak_05595_health_home_tenant WHERE user_id IN (t05595.u(3), t05595.u(4), t05595.u(5), t05595.u(6))),
          0, 'no snapshot row for members the backfill did not touch');
SELECT is(t05595.val('authenticated', t05595.u(1), 'SELECT count(*)::text FROM legacy_archive.bak_05595_health_home_tenant'), 'error:42501',
          'a member cannot read the snapshot');

-- 29-31 idempotent, and stable when the membership later changes
SELECT is(t05595.val('service_role', NULL, 'SELECT public.backfill_health_home_tenant(1000)::text'), '0', 'a second backfill run freezes nothing');
SELECT is(t05595.col(1) || '/' || t05595.col(3), (SELECT id::text FROM t05595_t WHERE k = 'a') || '/null', 'a second run changes no value');
UPDATE public.user_tenants SET is_primary = (tenant_id = (SELECT id FROM t05595_t WHERE k = 'b')) WHERE user_id = t05595.u(1);
SELECT is(t05595.home('service_role', 1), (SELECT id::text FROM t05595_t WHERE k = 'a'),
          'a frozen member keeps the home tenant after its primary membership moves');

-- 32-34 the ambiguous member resolves again once the data is fixed (the column is the only thing that freezes)
UPDATE public.user_tenants SET is_primary = (tenant_id = (SELECT id FROM t05595_t WHERE k = 'a')) WHERE user_id = t05595.u(3);
SELECT is(t05595.home('service_role', 3), (SELECT id::text FROM t05595_t WHERE k = 'a'), 'a repaired member resolves to its single primary tenant');
SELECT is(t05595.val('service_role', NULL, 'SELECT public.backfill_health_home_tenant(1000)::text'), '1', 'the next backfill freezes only the repaired member');
SELECT is(t05595.col(3), (SELECT id::text FROM t05595_t WHERE k = 'a'), 'the repaired member is frozen');

-- 35-37 integrity and write access
SELECT is(t05595.val('service_role', NULL,
            format('UPDATE public.app_users SET health_home_tenant_id = %L::uuid WHERE user_id = %L::uuid RETURNING 1::text',
                   '05595fff-0000-4000-8000-000000000000', t05595.u(5))), 'error:23503', 'the column references a real tenant');
SELECT is(t05595.val('authenticated', t05595.u(2),
            format('WITH w AS (UPDATE public.app_users SET health_home_tenant_id = %L::uuid WHERE user_id = %L::uuid RETURNING 1) SELECT count(*)::text FROM w',
                   (SELECT id FROM t05595_t WHERE k = 'a'), t05595.u(2))), '0', 'a member cannot change its own home tenant');
SELECT is(t05595.col(2), (SELECT id::text FROM t05595_t WHERE k = 'b'), 'the member''s home tenant is unchanged after the attempt');

-- 38-40 the batch argument is validated and an untouched call is harmless
SELECT is(t05595.val('service_role', NULL, 'SELECT public.backfill_health_home_tenant(0)::text'), 'error:P0001', 'a batch size below 1 is refused');
SELECT is(t05595.val('service_role', NULL, 'SELECT public.backfill_health_home_tenant(NULL)::text'), 'error:P0001', 'a NULL batch size is refused');
SELECT is(t05595.home('service_role', 999), 'null', 'the resolver of an unknown user is NULL');

SELECT * FROM finish();
ROLLBACK;
