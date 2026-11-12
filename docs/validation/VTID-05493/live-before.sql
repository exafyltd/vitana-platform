-- VTID-05493 live-before: READ-ONLY. Run before 070300 through the RUN-MIGRATION read-only check. SELECT only.
-- Keep the output: it is the state the rollbacks restore.
SELECT tenant_id, slug, is_active, is_default, is_platform, open_signup FROM public.tenants ORDER BY slug;
SELECT (SELECT count(*) FROM public.tenants WHERE is_default) AS default_tenants,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'archived_at') AS archived_at_col,
       to_regprocedure('public.deactivate_tenant(text)') AS deactivate_tenant,
       to_regprocedure('public.archive_tenant(text)') AS archive_tenant,
       to_regclass('public.bak_vtid_05493_tenant_lifecycle') AS snapshot_table;
SELECT md5(pg_get_functiondef('public.switch_to_tenant_by_slug(text)'::regprocedure)) AS switch_def_md5,
       pg_get_functiondef('public.switch_to_tenant_by_slug(text)'::regprocedure) LIKE '%open_signup%' AS switch_has_open_signup,
       pg_get_functiondef('public.switch_to_tenant_by_slug(text)'::regprocedure) LIKE '%is_default%' AS switch_has_fallback;
