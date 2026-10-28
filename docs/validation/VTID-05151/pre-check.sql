-- VTID-05151 pre-check (read-only). Run before applying 20261014000600 / 20261014000700.
-- Expected 2026-10-13: both functions absent; maxina/alkalma active + open_signup;
-- maxina branding {brand_accent #FF7BAC, brand_bg #FFF5F8, brand_fg #1a1a2e}, profile without
-- landing; alkalma branding {} and profile {}.
SELECT to_regprocedure('public.resolve_tenant(text)') IS NULL      AS resolve_tenant_absent,
       to_regprocedure('public.list_public_tenants()') IS NULL     AS list_public_tenants_absent,
       to_regprocedure('public._tenant_public_registry()') IS NULL AS internal_absent,
       to_regclass('legacy_archive.bak_vtid_05151_tenant_settings') IS NULL AS snapshot_absent;

SELECT slug, open_signup, is_active FROM public.tenants ORDER BY slug;

SELECT t.slug, s.branding, s.profile
  FROM public.tenants t LEFT JOIN public.tenant_settings s USING (tenant_id)
 ORDER BY t.slug;
