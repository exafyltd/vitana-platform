-- VTID-05324 read-only post-check (after rows 9 and 10 of docs/multitenancy/MIGRATION-QUEUE.md).
-- Every column must be true. Reads catalogs and calls the read-only readiness function; writes nothing.

-- P1 section (after row 9)
SELECT
  to_regclass('public.tenant_pack_intake') IS NOT NULL AS pack_intake_present,
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tenant_pack_intake'::regclass) AS pack_intake_rls,
  NOT has_table_privilege('anon', 'public.tenant_pack_intake', 'SELECT') AS anon_cannot_read_intake,
  NOT has_table_privilege('authenticated', 'public.tenant_pack_intake', 'SELECT') AS authed_cannot_read_intake,
  (SELECT count(*) FROM public.tenant_pack_intake) = 0 AS intake_not_backfilled;

-- P2 + P3 section (after row 10)
SELECT
  to_regclass('public.tenant_content_pipeline') IS NOT NULL AS content_pipeline_present,
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tenant_content_pipeline'::regclass) AS content_pipeline_rls,
  NOT has_table_privilege('anon', 'public.tenant_content_pipeline', 'SELECT') AS anon_cannot_read_pipeline,
  NOT has_table_privilege('authenticated', 'public.tenant_content_pipeline', 'SELECT') AS authed_cannot_read_pipeline,
  (SELECT NOT prosecdef AND provolatile = 's' AND proconfig @> ARRAY['search_path=public, pg_catalog']
     FROM pg_proc WHERE oid = 'public.get_tenant_launch_readiness(uuid)'::regprocedure) AS readiness_invoker_stable_pinned,
  NOT has_function_privilege('anon', 'public.get_tenant_launch_readiness(uuid)', 'EXECUTE') AS anon_cannot_execute,
  NOT has_function_privilege('authenticated', 'public.get_tenant_launch_readiness(uuid)', 'EXECUTE') AS authed_cannot_execute,
  (SELECT (public.get_tenant_launch_readiness(t.tenant_id) ->> 'total')::int = 13
     FROM public.tenants t WHERE t.slug = 'maxina') AS readiness_returns_for_maxina;
