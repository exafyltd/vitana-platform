-- VTID-05506 rollback-check: READ-ONLY. After the two rollback files ran (rollback-141100 first, then rollback-141000).
-- Expect: by_tenant NULL; provision_tenant and merge_fn present with the SAME body_md5 as live-before.sql section 3;
-- mentions_bootstrap_requested false for provision_tenant and mentions_erp false for the merge function;
-- ci_health_body_md5 unchanged; anon/authenticated cannot execute, service_role can.
SELECT to_regprocedure('public.ci_tenant_isolation_health_by_tenant()') AS by_tenant;
SELECT p.proname, md5(p.prosrc) AS body_md5,
       position('bootstrap_requested' IN p.prosrc) > 0 AS mentions_bootstrap_requested,
       position('''erp''' IN p.prosrc) > 0 AS mentions_erp,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
  FROM pg_proc p
 WHERE p.oid IN (to_regprocedure('public.provision_tenant(text,text,text,uuid,text,text,numeric,text,text[],text,text)'),
                 to_regprocedure('public.tenant_settings_merge_feature_flags(uuid,jsonb,boolean,uuid)'),
                 to_regprocedure('public.ci_tenant_isolation_health()'))
 ORDER BY p.proname;
SELECT count(*) AS tenants_with_erp_key FROM public.tenant_settings WHERE feature_flags ? 'erp';   -- flags already written stay (harmless)
