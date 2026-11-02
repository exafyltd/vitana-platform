-- VTID-05465 read-only post-check, after 20261102030000 and 20261102030100. SELECT only; no writes.

-- 1. Both helpers exist, STABLE SECURITY DEFINER, executable by authenticated and not by anon.
SELECT p.oid::regprocedure AS fn, p.prosecdef AS security_definer, p.provolatile = 's' AS stable,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
FROM pg_proc p
WHERE p.oid IN (to_regprocedure('public.is_member(uuid)'), to_regprocedure('public.tenant_id_for_policies()'));

-- 2. Expected 0 rows: no bare current_tenant_id() policy left on any public table.
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
  AND coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ 'current_tenant_id\('
  AND coalesce(qual, '') || ' ' || coalesce(with_check, '') !~ '(auth\.uid|current_user_id|is_member|is_tenant_admin|auth\.role)\('
  AND NOT roles <@ ARRAY['service_role', 'postgres', 'supabase_admin']::name[]
ORDER BY 1, 2;

-- 3. The rewritten policies as they now read: expect 32 rows, all on tenant_id_for_policies(), none on is_member() (plan amendment 1).
SELECT tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ '(is_member|tenant_id_for_policies)\('
ORDER BY 1, 2;

-- 4. current_tenant_id() unchanged (compare with the pre-apply md5).
SELECT md5(prosrc) AS current_tenant_id_md5 FROM pg_proc WHERE oid = 'public.current_tenant_id()'::regprocedure;
