-- VTID-05495 (mt-packs-r2/content-overrides-db) — pgTAP: public.tenant_content_overrides (WS5 content-pack override table).
-- Runs on a throwaway Postgres after 20261101100000_mt_packs_tenant_content_overrides.sql.
-- One transaction, rolled back at the end: never against a shared or live database.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(23);

CREATE SCHEMA t05495;
GRANT USAGE ON SCHEMA t05495 TO authenticated, anon, service_role;

-- First column of the first row of p_sql, run as p_role; 'error:<SQLSTATE>' on failure.
CREATE FUNCTION t05495.val(p_role text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
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

INSERT INTO public.tenants (slug, name) VALUES ('t05495a', 'Tenant A 05495'), ('t05495b', 'Tenant B 05495');
CREATE TEMP TABLE t05495_ids AS
  SELECT (SELECT tenant_id FROM public.tenants WHERE slug = 't05495a') AS ta,
         (SELECT tenant_id FROM public.tenants WHERE slug = 't05495b') AS tb;
GRANT SELECT ON t05495_ids TO PUBLIC;

-- Structure ------------------------------------------------------------------
SELECT has_table('public', 'tenant_content_overrides', 'tenant_content_overrides exists');
SELECT is((SELECT string_agg(a.attname, ',' ORDER BY k.ord)
             FROM pg_constraint c
             CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
            WHERE c.conrelid = 'public.tenant_content_overrides'::regclass AND c.contype = 'p'),
          'tenant_id,locale,key', 'primary key is (tenant_id, locale, key)');
SELECT is((SELECT count(*)::int FROM pg_constraint c
            WHERE c.conrelid = 'public.tenant_content_overrides'::regclass AND c.contype = 'f'
              AND c.confrelid = 'public.tenants'::regclass), 1, 'one foreign key to tenants');
SELECT is((SELECT string_agg(column_name || ':' || is_nullable, ',' ORDER BY ordinal_position)
             FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'tenant_content_overrides'),
          'tenant_id:NO,locale:NO,key:NO,value:NO,updated_by:YES,updated_at:NO', 'columns and nullability');
SELECT is((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tenant_content_overrides'::regclass), true, 'RLS is on');

-- Privileges -------------------------------------------------------------------
SELECT is(has_table_privilege('anon', 'public.tenant_content_overrides', 'SELECT'), false, 'anon has no SELECT privilege');
SELECT is(has_table_privilege('authenticated', 'public.tenant_content_overrides', 'SELECT'), false, 'authenticated has no SELECT privilege');
SELECT is(has_table_privilege('authenticated', 'public.tenant_content_overrides', 'INSERT'), false, 'authenticated has no INSERT privilege');
SELECT is(has_table_privilege('service_role', 'public.tenant_content_overrides', 'SELECT,INSERT,UPDATE,DELETE'), true, 'service_role has full DML');

-- Behaviour: service_role allowed ---------------------------------------------------
SELECT is(t05495.val('service_role', format(
  $q$INSERT INTO public.tenant_content_overrides (tenant_id, locale, key, value)
     VALUES (%L, 'de', 'home.title', 'Hallo') RETURNING 'ok'$q$, (SELECT ta FROM t05495_ids))),
  'ok', 'service_role can insert');
SELECT is(t05495.val('service_role', 'SELECT count(*)::text FROM public.tenant_content_overrides'), '1', 'service_role can read');
SELECT is(t05495.val('service_role', format(
  $q$INSERT INTO public.tenant_content_overrides (tenant_id, locale, key, value)
     VALUES (%L, 'pt-BR', 'home.title', 'Ola') RETURNING 'ok'$q$, (SELECT ta FROM t05495_ids))),
  'ok', 'a region locale (pt-BR) is accepted');
SELECT is((SELECT updated_at IS NOT NULL FROM public.tenant_content_overrides WHERE locale = 'de'), true, 'updated_at defaults to now()');
SELECT is((SELECT updated_by IS NULL FROM public.tenant_content_overrides WHERE locale = 'de'), true, 'updated_by is optional');

-- Behaviour: client roles denied -------------------------------------------------------
SELECT is(t05495.val('anon', 'SELECT count(*)::text FROM public.tenant_content_overrides'), 'error:42501', 'anon SELECT denied');
SELECT is(t05495.val('authenticated', 'SELECT count(*)::text FROM public.tenant_content_overrides'), 'error:42501', 'authenticated SELECT denied');
SELECT is(t05495.val('authenticated', format(
  $q$INSERT INTO public.tenant_content_overrides (tenant_id, locale, key, value)
     VALUES (%L, 'de', 'x', 'y') RETURNING 'ok'$q$, (SELECT ta FROM t05495_ids))),
  'error:42501', 'authenticated INSERT denied');
SELECT is(t05495.val('anon', format(
  $q$INSERT INTO public.tenant_content_overrides (tenant_id, locale, key, value)
     VALUES (%L, 'de', 'x', 'y') RETURNING 'ok'$q$, (SELECT ta FROM t05495_ids))),
  'error:42501', 'anon INSERT denied');

-- Constraints -----------------------------------------------------------------------
SELECT is(t05495.val('service_role', format(
  $q$INSERT INTO public.tenant_content_overrides (tenant_id, locale, key, value)
     VALUES (%L, 'DE', 'k', 'v') RETURNING 'ok'$q$, (SELECT ta FROM t05495_ids))),
  'error:23514', 'a bad locale (DE) fails the CHECK');
SELECT is(t05495.val('service_role', format(
  $q$INSERT INTO public.tenant_content_overrides (tenant_id, locale, key, value)
     VALUES (%L, 'deu', 'k', 'v') RETURNING 'ok'$q$, (SELECT ta FROM t05495_ids))),
  'error:23514', 'a bad locale (deu) fails the CHECK');
SELECT is(t05495.val('service_role', format(
  $q$INSERT INTO public.tenant_content_overrides (tenant_id, locale, key, value)
     VALUES (%L, 'de', 'home.title', 'dup') RETURNING 'ok'$q$, (SELECT ta FROM t05495_ids))),
  'error:23505', 'the same (tenant, locale, key) twice violates the primary key');
SELECT is(t05495.val('service_role',
  $q$INSERT INTO public.tenant_content_overrides (tenant_id, locale, key, value)
     VALUES ('00000000-0000-4000-8000-0000000000ff', 'de', 'k', 'v') RETURNING 'ok'$q$),
  'error:23503', 'an unknown tenant violates the foreign key');
SELECT is(t05495.val('service_role', format(
  $q$INSERT INTO public.tenant_content_overrides (tenant_id, locale, key, value)
     VALUES (%L, 'de', 'home.title', 'other tenant, same key') RETURNING 'ok'$q$, (SELECT tb FROM t05495_ids))),
  'ok', 'another tenant may use the same locale and key');

SELECT * FROM finish();
ROLLBACK;
