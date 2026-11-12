-- VTID-05493 (mt-tenant-admin-r2/tenant-lifecycle-db) — pgTAP: deactivate_tenant(), archive_tenant() and the closing
-- switch_to_tenant_by_slug() change (tasks L1-L3). Runs on a throwaway Postgres after vtid_05493_fixture.sql and
-- 20261102070300 + 20261102070350 (vtid_05493). One transaction, rolled back at the end: never a shared or live database.
-- Users (…c0..c6): u0 maxina member, uA t-a member, uAB t-a+t-b member, uX nobody, uE exafy-admin, uC t-c member,
-- uAM t-a+maxina member. Tenants (…a0..a4): maxina (default, open_signup), t-a, t-b, platform, t-c.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(72);

CREATE SCHEMA t05493;
GRANT USAGE ON SCHEMA t05493 TO authenticated, anon, service_role;

-- 'error:<SQLSTATE>' or first column of the first row of p_sql, run as p_role with JWT sub = p_user.
CREATE FUNCTION t05493.val(p_role text, p_user uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims', (jsonb_build_object('role', p_role) || CASE WHEN p_user IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sub', p_user) END)::text, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN EXECUTE p_sql INTO v; EXCEPTION WHEN OTHERS THEN v := 'error:' || SQLSTATE; END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v;
END $$;
-- 'SQLSTATE:message' of a failing statement.
CREATE FUNCTION t05493.err(p_role text, p_user uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims', (jsonb_build_object('role', p_role) || CASE WHEN p_user IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sub', p_user) END)::text, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN EXECUTE p_sql; v := 'no error'; EXCEPTION WHEN OTHERS THEN v := SQLSTATE || ':' || SQLERRM; END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v;
END $$;
CREATE FUNCTION t05493.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-0000-0000-0000000000' || p)::uuid $$;
CREATE FUNCTION t05493.claim(p_user uuid) RETURNS text LANGUAGE sql AS
$$ SELECT raw_app_meta_data->>'active_tenant_id' FROM auth.users WHERE id = p_user $$;
CREATE FUNCTION t05493.sw(p_user uuid, p_slug text) RETURNS text LANGUAGE sql AS
$$ SELECT t05493.val('authenticated', p_user, format('SELECT ''ok'' FROM (SELECT public.switch_to_tenant_by_slug(%L)) s', p_slug)) $$;
CREATE FUNCTION t05493.svc(p_sql text) RETURNS text LANGUAGE sql AS $$ SELECT t05493.val('service_role', NULL, p_sql) $$;

-- ---- structure and grants -------------------------------------------------------------------------------------
SELECT ok(to_regprocedure('public.deactivate_tenant(text)') IS NOT NULL, 'deactivate_tenant(text) exists');
SELECT ok(to_regprocedure('public.archive_tenant(text)') IS NOT NULL, 'archive_tenant(text) exists');
SELECT is((SELECT data_type || '/' || is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'archived_at'),
          'timestamp with time zone/YES'::text, 'tenants.archived_at is a nullable timestamptz (expand only)');
SELECT is((SELECT count(*) FROM public.bak_vtid_05493_tenant_lifecycle)::text, '5'::text, 'snapshot holds one row per tenant that existed at apply');
SELECT ok(NOT has_function_privilege('authenticated', 'public.deactivate_tenant(text)', 'EXECUTE'), 'authenticated cannot execute deactivate_tenant');
SELECT ok(NOT has_function_privilege('anon', 'public.deactivate_tenant(text)', 'EXECUTE'), 'anon cannot execute deactivate_tenant');
SELECT ok(has_function_privilege('service_role', 'public.deactivate_tenant(text)', 'EXECUTE'), 'service_role can execute deactivate_tenant');
SELECT ok(NOT has_function_privilege('authenticated', 'public.archive_tenant(text)', 'EXECUTE'), 'authenticated cannot execute archive_tenant');
SELECT ok(NOT has_function_privilege('anon', 'public.archive_tenant(text)', 'EXECUTE'), 'anon cannot execute archive_tenant');
SELECT ok(has_function_privilege('service_role', 'public.archive_tenant(text)', 'EXECUTE'), 'service_role can execute archive_tenant');
SELECT is(t05493.val('authenticated', t05493.u('c1'), $$SELECT public.deactivate_tenant('t-b')::text$$), 'error:42501'::text, 'a member calling deactivate_tenant is refused (42501)');
SELECT ok(has_function_privilege('authenticated', 'public.switch_to_tenant_by_slug(text)', 'EXECUTE'), 'authenticated keeps EXECUTE on switch_to_tenant_by_slug');
SELECT ok(NOT has_function_privilege('anon', 'public.switch_to_tenant_by_slug(text)', 'EXECUTE'), 'anon has no EXECUTE on switch_to_tenant_by_slug');
SELECT matches(pg_get_functiondef('public.switch_to_tenant_by_slug(text)'::regprocedure), 'open_signup', 'switch keeps the open_signup join rule (VTID-05043 co-ownership guard)');
SELECT matches(pg_get_functiondef('public.switch_to_tenant_by_slug(text)'::regprocedure), 'is_default', 'switch resolves a deactivated tenant through is_default');
SELECT is((SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tenants')::text, '2'::text, 'the lane adds no policy on tenants');
SELECT ok(NOT has_table_privilege('authenticated', 'public.bak_vtid_05493_tenant_lifecycle', 'SELECT') AND NOT has_table_privilege('anon', 'public.bak_vtid_05493_tenant_lifecycle', 'SELECT'),
          'the snapshot table is closed to authenticated and anon');

-- ---- switch regression: active tenants behave as before -----------------------------------------------------
SELECT is(t05493.sw(t05493.u('c2'), 't-b'), 'ok'::text, 'a member switches to an active tenant');
SELECT is(t05493.claim(t05493.u('c2')), t05493.u('a2')::text, 'the claim points at the active tenant');
SELECT is(t05493.err('authenticated', t05493.u('c3'), $$SELECT public.switch_to_tenant_by_slug('t-a')$$), '42501:TENANT_NOT_JOINABLE'::text, 'a non-member cannot join an invite-only active tenant');
SELECT is(t05493.sw(t05493.u('c3'), 'maxina'), 'ok'::text, 'a non-member joins the open_signup default tenant');
SELECT is((SELECT count(*) FROM public.user_tenants WHERE user_id = t05493.u('c3'))::text, '1'::text, 'the join wrote one user_tenants row');
SELECT is(left(t05493.err('authenticated', t05493.u('c3'), $$SELECT public.switch_to_tenant_by_slug('no-such-tenant')$$), 6), 'P0001:'::text, 'an unknown slug raises');
SELECT is(t05493.sw(t05493.u('c4'), 't-a'), 'ok'::text, 'an exafy admin switches to any tenant');
SELECT is(t05493.claim(t05493.u('c4')), t05493.u('a1')::text, 'the exafy admin claim points at the tenant');

-- ---- deactivate_tenant ----------------------------------------------------------------------------------------
SELECT is(t05493.svc($$SELECT (public.deactivate_tenant('t-a')->>'changed')$$), 'true'::text, 'deactivate_tenant reports changed:true on the first call');
SELECT is((SELECT is_active FROM public.tenants WHERE slug = 't-a')::text, 'false'::text, 'the tenant is inactive');
SELECT is(t05493.svc($$SELECT (public.deactivate_tenant('t-a')->>'changed')$$), 'false'::text, 'a second call is idempotent (changed:false)');
SELECT is((SELECT count(*) FROM public.tenants WHERE NOT is_active)::text, '1'::text, 'exactly one tenant is inactive');
SELECT is((SELECT count(*) FROM public.tenants WHERE is_active)::text, '4'::text, 'every other tenant is untouched');
SELECT is(t05493.svc($$SELECT (public.deactivate_tenant(' T-A ')->>'slug')$$), 't-a'::text, 'the slug is trimmed and lower-cased');
SELECT is(t05493.err('service_role', NULL, $$SELECT public.deactivate_tenant('no-such-tenant')$$), '22023:TENANT_NOT_FOUND'::text, 'unknown slug -> TENANT_NOT_FOUND');
SELECT is(t05493.err('service_role', NULL, $$SELECT public.deactivate_tenant('maxina')$$), '22023:DEFAULT_TENANT_PROTECTED'::text, 'the default tenant cannot be deactivated');
SELECT is(t05493.err('service_role', NULL, $$SELECT public.deactivate_tenant('platform')$$), '22023:PLATFORM_TENANT_PROTECTED'::text, 'the platform tenant cannot be deactivated');
SELECT is(t05493.err('service_role', NULL, $$SELECT public.deactivate_tenant('  ')$$), '22023:INVALID_SLUG'::text, 'a blank slug -> INVALID_SLUG');
SELECT is(t05493.err('service_role', NULL, $$SELECT public.deactivate_tenant(NULL)$$), '22023:INVALID_SLUG'::text, 'a NULL slug -> INVALID_SLUG');

-- ---- the closing switch: a deactivated tenant's members resolve to the default tenant --------------------------
SELECT is(t05493.sw(t05493.u('c1'), 't-a'), 'ok'::text, 'a member of a deactivated tenant is not locked out');
SELECT is(t05493.claim(t05493.u('c1')), t05493.u('a0')::text, 'the claim resolves to the default tenant');
SELECT is((SELECT count(*) FROM public.user_tenants WHERE user_id = t05493.u('c1') AND tenant_id = t05493.u('a0'))::text, '1'::text, 'the member is enrolled in the default tenant (open_signup rule)');
SELECT is((SELECT count(*) FROM public.audit_events WHERE user_id = t05493.u('c1') AND event_data->>'fallback' = 'true' AND event_data->>'tenant_slug' = 'maxina' AND event_data->>'requested_slug' = 't-a')::text, '1'::text, 'one audit row records the fallback');
SELECT is(t05493.sw(t05493.u('c1'), 't-a'), 'ok'::text, 'repeating the switch succeeds');
SELECT is((SELECT count(*) FROM public.audit_events WHERE user_id = t05493.u('c1'))::text, '1'::text, 'the repeat is write-free (no second audit row)');
SELECT is(t05493.sw(t05493.u('c6'), 't-a'), 'ok'::text, 'a member of both the deactivated and the default tenant switches');
SELECT is(t05493.claim(t05493.u('c6')), t05493.u('a0')::text, 'that member resolves to the default tenant');
SELECT is((SELECT count(*) FROM public.user_tenants WHERE user_id = t05493.u('c6'))::text, '2'::text, 'no extra membership was created');
SELECT is(t05493.err('authenticated', t05493.u('c0'), $$SELECT public.switch_to_tenant_by_slug('t-a')$$), '42501:TENANT_NOT_JOINABLE'::text, 'a non-member cannot reach a deactivated tenant');
SELECT is(t05493.sw(t05493.u('c4'), 't-a'), 'ok'::text, 'an exafy admin can still switch to the deactivated tenant');
SELECT is(t05493.claim(t05493.u('c4')), t05493.u('a1')::text, 'the exafy admin claim stays on the deactivated tenant');
SELECT is(t05493.val('authenticated', t05493.u('c4'), $$SELECT count(*) FROM public.tenants WHERE slug = 't-a'$$), '1'::text, 'an exafy admin can still read the deactivated tenant row');
SELECT is(t05493.sw(t05493.u('c2'), 't-a'), 'ok'::text, 'a multi-tenant member switching to the deactivated tenant resolves to default');
SELECT is(t05493.claim(t05493.u('c2')), t05493.u('a0')::text, 'multi-tenant member claim is the default tenant');
SELECT is((SELECT count(*) FROM public.user_tenants WHERE user_id = t05493.u('c2') AND tenant_id = t05493.u('a1'))::text, '1'::text, 'the membership in the deactivated tenant is kept (data untouched)');

-- ---- archive_tenant -------------------------------------------------------------------------------------------
SELECT is(t05493.sw(t05493.u('c5'), 't-c'), 'ok'::text, 'before archiving, the member switches to t-c');
SELECT is(t05493.claim(t05493.u('c5')), t05493.u('a4')::text, 'claim is t-c');
SELECT is(t05493.svc($$SELECT (public.archive_tenant('t-c')->>'changed')$$), 'true'::text, 'archive_tenant reports changed:true');
SELECT is((SELECT is_active FROM public.tenants WHERE slug = 't-c')::text, 'false'::text, 'an archived tenant is inactive');
SELECT ok((SELECT archived_at IS NOT NULL FROM public.tenants WHERE slug = 't-c'), 'archived_at is set');
CREATE TEMP TABLE t05493_snap AS SELECT archived_at FROM public.tenants WHERE slug = 't-c';
SELECT is(t05493.svc($$SELECT (public.archive_tenant('t-c')->>'changed')$$), 'false'::text, 'a second archive is idempotent (changed:false)');
SELECT is((SELECT archived_at::text FROM public.tenants WHERE slug = 't-c'), (SELECT archived_at::text FROM t05493_snap), 'archived_at is not rewritten');
SELECT is(t05493.sw(t05493.u('c5'), 't-c'), 'ok'::text, 'a member of an archived tenant is not locked out');
SELECT is(t05493.claim(t05493.u('c5')), t05493.u('a0')::text, 'and resolves to the default tenant');
SELECT is(t05493.svc($$SELECT (public.archive_tenant('t-a')->>'changed')$$), 'true'::text, 'archiving an already-deactivated tenant sets archived_at');
SELECT ok((SELECT NOT is_active AND archived_at IS NOT NULL FROM public.tenants WHERE slug = 't-a'), 'it stays inactive and is archived');
SELECT is(t05493.svc($$SELECT (public.deactivate_tenant('t-c')->>'changed')$$), 'false'::text, 'deactivating an archived tenant changes nothing');
SELECT ok((SELECT archived_at IS NOT NULL FROM public.tenants WHERE slug = 't-c'), 'and keeps archived_at');
SELECT is(t05493.err('service_role', NULL, $$SELECT public.archive_tenant('maxina')$$), '22023:DEFAULT_TENANT_PROTECTED'::text, 'the default tenant cannot be archived');
SELECT is(t05493.err('service_role', NULL, $$SELECT public.archive_tenant('platform')$$), '22023:PLATFORM_TENANT_PROTECTED'::text, 'the platform tenant cannot be archived');
SELECT is(t05493.err('service_role', NULL, $$SELECT public.archive_tenant('no-such-tenant')$$), '22023:TENANT_NOT_FOUND'::text, 'unknown slug -> TENANT_NOT_FOUND');
SELECT is(t05493.err('service_role', NULL, $$SELECT public.archive_tenant(NULL)$$), '22023:INVALID_SLUG'::text, 'NULL slug -> INVALID_SLUG');
SELECT is(t05493.val('authenticated', t05493.u('c1'), $$SELECT public.archive_tenant('t-b')::text$$), 'error:42501'::text, 'a member calling archive_tenant is refused (42501)');
SELECT is(t05493.val('authenticated', t05493.u('c4'), $$SELECT count(*) FROM public.tenants WHERE slug = 't-c'$$), '1'::text, 'an exafy admin can still read the archived tenant row');
SELECT is((SELECT is_active FROM public.tenants WHERE slug = 't-b')::text, 'true'::text, 'an untouched tenant is still active');

SELECT * FROM finish();
ROLLBACK;
