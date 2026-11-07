-- VTID-05507 post-apply-checks: READ-ONLY. Run by Kiro through RUN-MIGRATION's read-only check AFTER the two lane
-- migrations (20261102140000, 20261102140100). SELECT statements only. Each check names its expected result.

-- 1. [after 140000] table, RLS, policies, privileges. Expect: rls_on true; NO policy rows; every privilege false except service_role.
SELECT c.relrowsecurity AS rls_on FROM pg_class c WHERE c.oid = 'public.tenant_domains'::regclass;
SELECT policyname, cmd, roles FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tenant_domains' ORDER BY policyname;
SELECT has_table_privilege('anon', 'public.tenant_domains', 'SELECT') AS anon_select,
       has_table_privilege('authenticated', 'public.tenant_domains', 'SELECT') AS auth_select,
       has_table_privilege('authenticated', 'public.tenant_domains', 'INSERT') AS auth_insert,
       has_table_privilege('service_role', 'public.tenant_domains', 'INSERT') AS service_insert;
-- Expect: anon_select false, auth_select false, auth_insert false, service_insert true.

-- 2. [after 140000] constraints, indexes, trigger. Expect: unique host, format + normalized CHECKs, FK to tenants, one-primary index, trigger enabled.
SELECT conname, contype FROM pg_constraint WHERE conrelid = 'public.tenant_domains'::regclass ORDER BY conname;
SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'tenant_domains' ORDER BY indexname;
SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.tenant_domains'::regclass AND NOT tgisinternal;
SELECT count(*) AS rows FROM public.tenant_domains;   -- Expect 0 (the lane inserts nothing).

-- 3. [after 140100] the overload. Expect: two resolve_tenant overloads, 0 defaults on the new one, anon EXECUTE on both,
--    identical result column lists.
SELECT p.oid::regprocedure AS overload, p.pronargdefaults AS defaults, pg_get_function_result(p.oid) AS result,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
  FROM pg_proc p WHERE p.proname = 'resolve_tenant' AND p.pronamespace = 'public'::regnamespace ORDER BY p.pronargs;

-- 4. [after 140100] the one-argument function is untouched. Expect: the same one_arg_body_md5, one_arg_result and
--    result_md5 as live-before.sql section 4.
SELECT md5(p.prosrc) AS one_arg_body_md5, pg_get_function_result(p.oid) AS one_arg_result
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.resolve_tenant(text)');
SELECT md5(coalesce(string_agg(r::text, '|' ORDER BY r.slug), '')) AS result_md5, count(*) AS tenants
  FROM public.list_public_tenants() r;

-- 5. [after 140100] with no host rows, the two-argument call equals the slug arm. Expect: same_as_slug_arm true.
SELECT bool_and(coalesce((SELECT md5(r2::text) FROM public.resolve_tenant('no-such-host.invalid', r.slug) r2), '')
              = coalesce((SELECT md5(r1::text) FROM public.resolve_tenant(r.slug) r1), '')) AS same_as_slug_arm
  FROM public.list_public_tenants() r;
