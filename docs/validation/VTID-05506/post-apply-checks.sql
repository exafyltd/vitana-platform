-- VTID-05506 post-apply-checks: READ-ONLY. Run by Kiro through RUN-MIGRATION's read-only check AFTER the two lane
-- migrations (20261102141000, 20261102141100). SELECT statements only. Each check names its expected result.

-- 1. [after 141000] both functions now carry the erp request. Expect: provision_tenant mentions_bootstrap_requested true;
--    merge_fn mentions_erp true; both body_md5 differ from live-before.sql section 3.
SELECT p.proname, md5(p.prosrc) AS body_md5,
       position('bootstrap_requested' IN p.prosrc) > 0 AS mentions_bootstrap_requested,
       position('''erp''' IN p.prosrc) > 0 AS mentions_erp
  FROM pg_proc p
 WHERE p.oid IN (to_regprocedure('public.provision_tenant(text,text,text,uuid,text,text,numeric,text,text[],text,text)'),
                 to_regprocedure('public.tenant_settings_merge_feature_flags(uuid,jsonb,boolean,uuid)'))
 ORDER BY p.proname;

-- 2. [after 141000] definitions and grants unchanged in kind. Expect: provision_tenant secdef true, config {search_path=public};
--    merge_fn secdef false, config {"search_path=public, pg_catalog"}; anon_exec false, auth_exec false, service_exec true on both.
SELECT p.proname, p.prosecdef AS secdef, p.proconfig AS config,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
  FROM pg_proc p
 WHERE p.oid IN (to_regprocedure('public.provision_tenant(text,text,text,uuid,text,text,numeric,text,text[],text,text)'),
                 to_regprocedure('public.tenant_settings_merge_feature_flags(uuid,jsonb,boolean,uuid)'))
 ORDER BY p.proname;

-- 3. [after 141000] no tenant got the flag from the migration (it only sets the flag when provision_tenant runs). Expect the
--    same count as live-before.sql section 4 (0 until the first provisioning).
SELECT count(*) AS tenants_with_erp_key FROM public.tenant_settings WHERE feature_flags ? 'erp';

-- 4. [after 141100] the per-tenant function. Expect: by_tenant present; secdef true; volatility 's'; config
--    {"search_path=public, pg_catalog"}; anon_exec false, auth_exec false, service_exec true.
SELECT to_regprocedure('public.ci_tenant_isolation_health_by_tenant()') AS by_tenant,
       p.prosecdef AS secdef, p.provolatile AS volatility, p.proconfig AS config,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.ci_tenant_isolation_health_by_tenant()');

-- 5. [after 141100] the single-number function is untouched. Expect: the same body_md5 as live-before.sql section 3.
SELECT md5(p.prosrc) AS ci_health_body_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.ci_tenant_isolation_health()');

-- 6. [after 141100] the rows sum to the single-number function. Expect: zero rows (every column agrees) and no scan errors.
WITH h AS (SELECT public.ci_tenant_isolation_health()::jsonb AS j, public.ci_tenant_isolation_health_by_tenant()::jsonb AS t),
     cols(c) AS (VALUES ('foreign_tenant_rows'), ('null_tenant_rows'), ('users_zero_primary'), ('users_multi_primary'),
                        ('auth_users_without_membership'), ('memberships_not_in_user_tenants'),
                        ('user_tenants_not_in_memberships'), ('default_tenant_count'), ('platform_tenant_count'))
SELECT cols.c AS disagreeing_column
  FROM cols, h
 WHERE (SELECT coalesce(sum((e ->> cols.c)::bigint), -1) FROM jsonb_array_elements(h.t -> 'tenants') e) IS DISTINCT FROM (h.j ->> cols.c)::bigint
    OR (h.t -> 'totals' ->> cols.c)::bigint IS DISTINCT FROM (h.j ->> cols.c)::bigint;
SELECT jsonb_array_length(t -> 'scan_errors') AS scan_errors FROM (SELECT public.ci_tenant_isolation_health_by_tenant()::jsonb AS t) s;   -- Expect 0 (same tables as the single-number function).

-- 7. [after 141100] every registered tenant is listed. Expect: listed = registered.
SELECT (SELECT count(*) FROM jsonb_array_elements(public.ci_tenant_isolation_health_by_tenant()::jsonb -> 'tenants') e WHERE (e ->> 'is_registered')::boolean) AS listed,
       (SELECT count(*) FROM public.tenants) AS registered;

-- 8. [after 141100] the per-tenant picture, for the morning health review (ids and counts only). Rows with any non-zero drift column.
SELECT e ->> 'slug' AS slug, e ->> 'tenant_id' AS tenant_id, e ->> 'is_registered' AS is_registered,
       e ->> 'foreign_tenant_rows' AS foreign_rows, e ->> 'null_tenant_rows' AS null_rows,
       e ->> 'memberships_not_in_user_tenants' AS m_not_ut, e ->> 'user_tenants_not_in_memberships' AS ut_not_m
  FROM jsonb_array_elements(public.ci_tenant_isolation_health_by_tenant()::jsonb -> 'tenants') e
 WHERE e -> 'tenant_id' <> 'null'::jsonb AND NOT (e ->> 'is_registered')::boolean OR (e ->> 'foreign_tenant_rows')::bigint + (e ->> 'null_tenant_rows')::bigint + (e ->> 'memberships_not_in_user_tenants')::bigint
       + (e ->> 'user_tenants_not_in_memberships')::bigint > 0
 ORDER BY 1 NULLS LAST;
