-- VTID-05493 post-apply-checks: READ-ONLY. After 070300 and 070350. SELECT only.
-- Expect: snapshot_rows = tenants_at_apply (or fewer than tenants now), both functions present, archived_at_col 1,
-- authenticated_exec_* false, service_role_exec_* true, switch_has_fallback and switch_has_open_signup true,
-- exactly one default tenant, and the default tenant active.
SELECT to_regprocedure('public.deactivate_tenant(text)') AS deactivate_tenant,
       to_regprocedure('public.archive_tenant(text)') AS archive_tenant,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'archived_at') AS archived_at_col,
       (SELECT count(*) FROM public.bak_vtid_05493_tenant_lifecycle) AS snapshot_rows,
       (SELECT count(*) FROM public.tenants) AS tenants_now;
SELECT has_function_privilege('authenticated', 'public.deactivate_tenant(text)', 'EXECUTE') AS authenticated_exec_deactivate,
       has_function_privilege('authenticated', 'public.archive_tenant(text)', 'EXECUTE') AS authenticated_exec_archive,
       has_function_privilege('anon', 'public.switch_to_tenant_by_slug(text)', 'EXECUTE') AS anon_exec_switch,
       has_function_privilege('authenticated', 'public.switch_to_tenant_by_slug(text)', 'EXECUTE') AS authenticated_exec_switch,
       has_function_privilege('service_role', 'public.deactivate_tenant(text)', 'EXECUTE') AS service_role_exec_deactivate,
       has_function_privilege('service_role', 'public.archive_tenant(text)', 'EXECUTE') AS service_role_exec_archive;
SELECT pg_get_functiondef('public.switch_to_tenant_by_slug(text)'::regprocedure) LIKE '%open_signup%' AS switch_has_open_signup,
       pg_get_functiondef('public.switch_to_tenant_by_slug(text)'::regprocedure) LIKE '%is_default%' AS switch_has_fallback;
SELECT (SELECT count(*) FROM public.tenants WHERE is_default) AS default_tenants,
       (SELECT bool_and(is_active) FROM public.tenants WHERE is_default) AS default_active,
       (SELECT count(*) FROM public.tenants WHERE NOT is_active) AS inactive_tenants,
       (SELECT count(*) FROM public.tenants WHERE archived_at IS NOT NULL) AS archived_tenants;
