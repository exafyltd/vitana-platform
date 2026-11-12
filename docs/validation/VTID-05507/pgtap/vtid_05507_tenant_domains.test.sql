-- VTID-05507 (mt-m3-r2/tenant-domains-db) — pgTAP: tenant_domains (D1) and the resolve_tenant(p_host, p_slug) host arm (D2).
-- Runs on a throwaway Postgres after vtid_05507_fixture.sql and 20261102140000..20261102140100_vtid_05507_*.sql.
-- One transaction, rolled back at the end: never against a shared or live database.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(48);

CREATE SCHEMA t05507;
GRANT USAGE ON SCHEMA t05507 TO authenticated, anon, service_role;

-- First column of the first row of p_sql, run as p_role; 'error:<SQLSTATE>' on failure.
CREATE FUNCTION t05507.val(p_role text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', p_role)::text, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    v := 'error:' || SQLSTATE;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v;
END $$;

-- Slug of the resolved tenant ('' when none), as a client role would call it.
CREATE FUNCTION t05507.res(p_role text, p_host text, p_slug text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(t05507.val(p_role, format('SELECT slug FROM public.resolve_tenant(%L, %L)', p_host, p_slug)), '')
$$;
GRANT EXECUTE ON FUNCTION t05507.val(text, text), t05507.res(text, text, text) TO authenticated, anon, service_role;

-- ── D1: table, RLS, privileges ─────────────────────────────────────────────
SELECT has_table('public', 'tenant_domains', '1 tenant_domains exists');
SELECT ok((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.tenant_domains'::regclass), '2 RLS is enabled');
SELECT is((SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tenant_domains')::int, 0, '3 no client policy exists');
SELECT is(t05507.val('anon', 'SELECT count(*) FROM public.tenant_domains'), 'error:42501', '4 anon cannot read');
SELECT is(t05507.val('authenticated', 'SELECT count(*) FROM public.tenant_domains'), 'error:42501', '5 authenticated cannot read');
SELECT is(t05507.val('authenticated', $q$INSERT INTO public.tenant_domains (tenant_id, host) VALUES ('05507000-0000-4000-8000-0000000000a2', 'x.example.org')$q$), 'error:42501', '6 authenticated cannot write');
SELECT is(t05507.val('anon', $q$INSERT INTO public.tenant_domains (tenant_id, host) VALUES ('05507000-0000-4000-8000-0000000000a2', 'x.example.org')$q$), 'error:42501', '7 anon cannot write');
SELECT is(t05507.val('authenticated', $q$DELETE FROM public.tenant_domains$q$), 'error:42501', '8 authenticated cannot delete');
SELECT isnt(t05507.val('service_role', $q$INSERT INTO public.tenant_domains (tenant_id, host, verified_at, is_primary)
  VALUES ('05507000-0000-4000-8000-0000000000a2', 'verified.example.org', now(), true) RETURNING host$q$), 'error:42501', '9 service_role can write');
SELECT is(t05507.val('service_role', 'SELECT count(*) FROM public.tenant_domains'), '1', '10 service_role can read (RLS bypass, no policy)');

-- Rows used by the resolve cases (inserted as the owner, bypassing nothing the trigger needs).
INSERT INTO public.tenant_domains (tenant_id, host, verified_at) VALUES
  ('05507000-0000-4000-8000-0000000000a2', 'pending.example.org', NULL),
  ('05507000-0000-4000-8000-0000000000a0', 'max.example.org', now()),
  ('05507000-0000-4000-8000-0000000000a3', 'inactive.example.org', now()),
  ('05507000-0000-4000-8000-0000000000a4', 'platform.example.org', now());

-- ── D1: host rules ─────────────────────────────────────────────────────────
SELECT throws_ok($q$INSERT INTO public.tenant_domains (tenant_id, host) VALUES ('05507000-0000-4000-8000-0000000000a2', 'Upper.Example.org')$q$, '23514', NULL, '11 upper-case host rejected');
SELECT throws_ok($q$INSERT INTO public.tenant_domains (tenant_id, host) VALUES ('05507000-0000-4000-8000-0000000000a2', ' pad.example.org')$q$, '23514', NULL, '12 padded host rejected');
SELECT throws_ok($q$INSERT INTO public.tenant_domains (tenant_id, host) VALUES ('05507000-0000-4000-8000-0000000000a2', 'under_score.example.org')$q$, '23514', NULL, '13 underscore host rejected');
SELECT throws_ok($q$INSERT INTO public.tenant_domains (tenant_id, host) VALUES ('05507000-0000-4000-8000-0000000000a2', '-lead.example.org')$q$, '23514', NULL, '14 leading hyphen rejected');
SELECT throws_ok($q$INSERT INTO public.tenant_domains (tenant_id, host) VALUES ('05507000-0000-4000-8000-0000000000a2', 'trail.example.org.')$q$, '23514', NULL, '15 trailing dot rejected');
SELECT throws_ok($q$INSERT INTO public.tenant_domains (tenant_id, host) VALUES ('05507000-0000-4000-8000-0000000000a2', '')$q$, '23514', NULL, '16 empty host rejected');
SELECT throws_ok(format('INSERT INTO public.tenant_domains (tenant_id, host) VALUES (%L, %L)', '05507000-0000-4000-8000-0000000000a2', repeat('a', 63) || '.' || repeat('b', 63) || '.' || repeat('c', 63) || '.' || repeat('d', 63) || '.org'),
  '23514', NULL, '17 host longer than 253 characters rejected');
SELECT lives_ok($q$INSERT INTO public.tenant_domains (tenant_id, host) VALUES ('05507000-0000-4000-8000-0000000000a2', 'a.b.sub-domain.example.org')$q$, '18 a normal multi-label host is accepted');
SELECT throws_ok($q$INSERT INTO public.tenant_domains (tenant_id, host) VALUES ('05507000-0000-4000-8000-0000000000a2', 'verified.example.org')$q$, '23505', NULL, '19 duplicate host rejected');
SELECT throws_ok($q$INSERT INTO public.tenant_domains (tenant_id, host, is_primary) VALUES ('05507000-0000-4000-8000-0000000000a2', 'second-primary.example.org', true)$q$, '23505', NULL, '20 a second primary host for one tenant rejected');
SELECT lives_ok($q$INSERT INTO public.tenant_domains (tenant_id, host, is_primary) VALUES ('05507000-0000-4000-8000-0000000000a0', 'max-primary.example.org', true)$q$, '21 a primary host for another tenant accepted');
SELECT throws_ok($q$INSERT INTO public.tenant_domains (tenant_id, host) VALUES ('05507000-0000-4000-8000-0000000000ff', 'ghost.example.org')$q$, '23503', NULL, '22 unknown tenant rejected (FK)');

-- ── D1: reserved-slug trigger ──────────────────────────────────────────────
SELECT throws_ok($q$INSERT INTO public.tenant_domains (tenant_id, host) VALUES ('05507000-0000-4000-8000-0000000000a2', 'admin')$q$, '23514', 'tenant_domains: host admin is a reserved slug', '23 INSERT of a reserved-slug host raises (trigger)');
SELECT throws_ok($q$UPDATE public.tenant_domains SET host = 'api' WHERE host = 'pending.example.org'$q$, '23514', 'tenant_domains: host api is a reserved slug', '24 UPDATE of a host to a reserved slug raises (trigger)');
SELECT lives_ok($q$UPDATE public.tenant_domains SET verified_at = now() WHERE host = 'pending.example.org'$q$, '25 UPDATE of another column is not blocked');
UPDATE public.tenant_domains SET verified_at = NULL WHERE host = 'pending.example.org';
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tenant_domains_reject_reserved' AND tgrelid = 'public.tenant_domains'::regclass AND tgenabled = 'O'), '26 the reserved-slug trigger exists and is enabled');
SELECT ok(NOT has_function_privilege('anon', 'public.tenant_domains_reject_reserved()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.tenant_domains_reject_reserved()', 'EXECUTE'), '27 the trigger function is not executable by a client role');

-- ── D2: host arm ───────────────────────────────────────────────────────────
SELECT is(t05507.res('anon', 'verified.example.org', NULL), 't05507a', '28 a VERIFIED host resolves its tenant');
SELECT is(t05507.res('anon', '  VERIFIED.Example.ORG ', NULL), 't05507a', '29 the host is matched after lower(btrim())');
SELECT is(t05507.res('anon', 'pending.example.org', NULL), '', '30 an UNVERIFIED host resolves empty');
SELECT is(t05507.res('anon', 'pending.example.org', 'maxina'), 'maxina', '31 an unverified host falls through to the slug arm');
SELECT is(t05507.res('anon', 'inactive.example.org', NULL), '', '32 a verified host on an INACTIVE tenant resolves empty');
SELECT is(t05507.res('anon', 'platform.example.org', NULL), '', '33 a verified host on a PLATFORM tenant resolves empty');
SELECT is(t05507.res('anon', 'inactive.example.org', 'alkalma'), 'alkalma', '34 an inactive-tenant host falls through to the slug arm');
SELECT is(t05507.res('anon', 'verified.example.org', 'maxina'), 't05507a', '35 a verified host wins over the slug');
SELECT is(t05507.res('anon', 'unknown.example.org', 'maxina'), 'maxina', '36 an unknown host falls through to the slug');
SELECT is(t05507.res('anon', 'unknown.example.org', 'zz-nope'), '', '37 unknown host and unknown slug resolve empty');
SELECT is(t05507.res('anon', NULL, NULL), '', '38 NULL host and NULL slug resolve empty');
SELECT is(t05507.res('authenticated', 'verified.example.org', NULL), 't05507a', '39 authenticated can call the overload');

-- ── D2: the one-argument function is untouched; both return the same 8 columns ──
SELECT is((SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = 'public.resolve_tenant(text)'::regprocedure),
          '1b6ea21435300bab029f7b65a6a8b1c1', '40 resolve_tenant(p_slug) body is byte-identical to the VTID-05151 migration');
SELECT is(t05507.val('anon', $q$SELECT slug FROM public.resolve_tenant(p_slug => 'maxina')$q$), 'maxina', '41 a {p_slug}-only call still binds the one-argument function');
SELECT is((SELECT pg_get_function_result('public.resolve_tenant(text, text)'::regprocedure)),
          (SELECT pg_get_function_result('public.resolve_tenant(text)'::regprocedure)), '42 both overloads return the same 8 columns');
SELECT doesnt_match((SELECT pg_get_function_result('public.resolve_tenant(text, text)'::regprocedure)), '(host|verified_at|is_primary)', '43 no tenant_domains column is returned');
SELECT is((SELECT p.pronargdefaults FROM pg_proc p WHERE p.oid = 'public.resolve_tenant(text, text)'::regprocedure)::int, 0, '44 the two-argument overload has no parameter defaults');
SELECT ok(has_function_privilege('anon', 'public.resolve_tenant(text, text)', 'EXECUTE') AND has_function_privilege('anon', 'public.resolve_tenant(text)', 'EXECUTE'), '45 anon executes both overloads');
SELECT ok(NOT has_function_privilege('anon', 'public._tenant_public_registry()', 'EXECUTE'), '46 the internal registry is still not executable by anon');
SELECT is((SELECT count(*) FROM pg_proc p WHERE p.proname = 'resolve_tenant' AND p.pronamespace = 'public'::regnamespace)::int, 2, '47 exactly two resolve_tenant overloads exist');

-- Deleting a tenant removes its hosts (FK ON DELETE CASCADE).
INSERT INTO public.tenants (tenant_id, slug, name) VALUES ('05507000-0000-4000-8000-0000000000b0', 't05507tmp', 'Temp');
INSERT INTO public.tenant_domains (tenant_id, host) VALUES ('05507000-0000-4000-8000-0000000000b0', 'tmp.example.org');
DELETE FROM public.tenants WHERE tenant_id = '05507000-0000-4000-8000-0000000000b0';
SELECT is((SELECT count(*) FROM public.tenant_domains WHERE host = 'tmp.example.org')::int, 0, '48 deleting a tenant removes its hosts');

SELECT * FROM finish();
ROLLBACK;
