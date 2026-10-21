-- VTID-05324 pgTAP plan (P5) for a THROWAWAY Postgres only (local Supabase stack or a CI service container),
-- never a live database. Run after both migrations:  pg_prove -d <throwaway-db> pgtap-pack-intake.sql
-- The gateway Jest suite services/gateway/test/mt-launch-pack-intake-pgtap.test.ts pins the same properties
-- from the migration source, so they are checked in CI without a database.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(14);

SELECT has_table('public', 'tenant_pack_intake', 'tenant_pack_intake exists');
SELECT has_table('public', 'tenant_content_pipeline', 'tenant_content_pipeline exists');
SELECT col_is_pk('public', 'tenant_pack_intake', ARRAY['tenant_id', 'item_key'], 'intake PK is (tenant_id, item_key)');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tenant_pack_intake'::regclass), 'intake RLS on');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tenant_content_pipeline'::regclass), 'pipeline RLS on');

-- A non-service-role client read of either table fails.
SET LOCAL ROLE anon;
SELECT throws_ok('SELECT * FROM public.tenant_pack_intake', '42501', NULL, 'anon cannot read intake');
SELECT throws_ok('SELECT * FROM public.tenant_content_pipeline', '42501', NULL, 'anon cannot read pipeline');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT throws_ok('SELECT * FROM public.tenant_pack_intake', '42501', NULL, 'authenticated cannot read intake');
SELECT throws_ok('SELECT * FROM public.tenant_content_pipeline', '42501', NULL, 'authenticated cannot read pipeline');
SELECT throws_ok($$SELECT public.get_tenant_launch_readiness(gen_random_uuid())$$, '42501', NULL,
                 'authenticated cannot execute readiness');
RESET ROLE;

-- The readiness function: SECURITY INVOKER, STABLE (read-only), search_path pinned; returns for maxina.
SELECT ok((SELECT NOT prosecdef FROM pg_proc WHERE oid = 'public.get_tenant_launch_readiness(uuid)'::regprocedure),
          'readiness is SECURITY INVOKER');
SELECT volatility_is('public', 'get_tenant_launch_readiness', ARRAY['uuid'], 'stable', 'readiness is STABLE');
SELECT ok((SELECT proconfig @> ARRAY['search_path=public, pg_catalog'] FROM pg_proc
           WHERE oid = 'public.get_tenant_launch_readiness(uuid)'::regprocedure), 'readiness search_path pinned');
SELECT is((SELECT (public.get_tenant_launch_readiness(t.tenant_id) ->> 'total')::int
           FROM public.tenants t WHERE t.slug = 'maxina'), 13, 'readiness returns all 13 items for maxina');

SELECT * FROM finish();
ROLLBACK;
