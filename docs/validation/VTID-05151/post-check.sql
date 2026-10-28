-- VTID-05151 post-check (read-only). Run after applying both migrations.
SELECT has_function_privilege('anon', 'public.list_public_tenants()', 'EXECUTE')               AS anon_list,      -- true
       has_function_privilege('anon', 'public.resolve_tenant(text)', 'EXECUTE')                AS anon_resolve,   -- true
       has_function_privilege('anon', 'public._tenant_public_registry()', 'EXECUTE')           AS anon_internal,  -- false
       has_function_privilege('authenticated', 'public._tenant_public_registry()', 'EXECUTE')  AS auth_internal,  -- false
       (SELECT count(*) FROM public.list_public_tenants() WHERE slug IN ('maxina', 'alkalma')) AS legacy_rows,    -- 2
       NOT EXISTS (SELECT 1 FROM public.resolve_tenant('zz-not-a-tenant'))                     AS unknown_empty;  -- true

-- Exactly 2 rows: maxina (display Maxina) and alkalma (display AlKalma), whitelisted keys only.
SELECT slug, display_name, open_signup, brand, landing, locales FROM public.list_public_tenants();

-- Must return no row.
SELECT r.slug, k AS unexpected_brand_key
  FROM public.list_public_tenants() r, jsonb_object_keys(r.brand) k
 WHERE k NOT IN ('accent', 'bg', 'fg', 'logo_path', 'favicon_path', 'og_image_path');
SELECT r.slug, k AS unexpected_landing_key
  FROM public.list_public_tenants() r, jsonb_object_keys(r.landing) k
 WHERE k NOT IN ('tagline', 'intro', 'auto_switch_on_visit', 'post_login_path', 'oauth');

-- Snapshot retained (30 days): 2 rows today.
SELECT count(*) AS snapshot_rows FROM legacy_archive.bak_vtid_05151_tenant_settings;
