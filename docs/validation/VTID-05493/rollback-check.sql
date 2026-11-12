-- VTID-05493 rollback-check: READ-ONLY. After rollback-070350 then rollback-070300. SELECT only.
-- Expect: deactivate_tenant NULL, archive_tenant NULL, archived_at_col 0, switch_has_fallback false,
-- switch_has_open_signup true, tenants_differing_from_snapshot 0. The snapshot table may remain.
SELECT to_regprocedure('public.deactivate_tenant(text)') AS deactivate_tenant,
       to_regprocedure('public.archive_tenant(text)') AS archive_tenant,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'archived_at') AS archived_at_col,
       pg_get_functiondef('public.switch_to_tenant_by_slug(text)'::regprocedure) LIKE '%is_default%' AS switch_has_fallback,
       pg_get_functiondef('public.switch_to_tenant_by_slug(text)'::regprocedure) LIKE '%open_signup%' AS switch_has_open_signup;
SELECT count(*) AS tenants_differing_from_snapshot
  FROM public.tenants t JOIN public.bak_vtid_05493_tenant_lifecycle b USING (tenant_id)
 WHERE t.is_active IS DISTINCT FROM b.is_active;
