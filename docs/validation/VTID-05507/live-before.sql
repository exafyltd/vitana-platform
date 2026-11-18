-- VTID-05507 live-before: READ-ONLY. Run by Kiro through RUN-MIGRATION's read-only check BEFORE the first lane
-- migration (20261102140000). SELECT statements only; nothing here writes. Compare with post-apply-checks.sql.

-- 1. The objects the lane creates must not exist yet. Expect: tenant_domains NULL, trigger_fn NULL, two_arg NULL.
SELECT to_regclass('public.tenant_domains') AS tenant_domains,
       to_regprocedure('public.tenant_domains_reject_reserved()') AS trigger_fn,
       to_regprocedure('public.resolve_tenant(text, text)') AS two_arg;

-- 2. What the lane depends on. Expect: reserved_tenant_slugs and the one-argument resolve_tenant present.
SELECT to_regclass('public.reserved_tenant_slugs') AS reserved_tenant_slugs,
       to_regprocedure('public.resolve_tenant(text)') AS one_arg,
       to_regprocedure('public._tenant_public_registry()') AS registry;

-- 3. The tenants key the migration references (live is tenants.tenant_id; the migration accepts tenant_id or id).
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name IN ('tenant_id', 'id') ORDER BY column_name;

-- 4. Baseline of the one-argument function, to compare after. Expect the same md5 and result_md5 afterwards.
SELECT md5(p.prosrc) AS one_arg_body_md5, pg_get_function_result(p.oid) AS one_arg_result
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.resolve_tenant(text)');
SELECT md5(coalesce(string_agg(r::text, '|' ORDER BY r.slug), '')) AS result_md5, count(*) AS tenants
  FROM public.list_public_tenants() r;
