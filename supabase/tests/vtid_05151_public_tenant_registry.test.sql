-- VTID-05151 assertions. Runs after vtid_05151_fixture.sql and both VTID-05151
-- migrations (each applied twice). Every block raises on failure (ON_ERROR_STOP).

-- (a) anon gets the active, slugged rows only, in slug order, with the whitelisted fields.
SET ROLE anon;
DO $$
DECLARE
  slugs text[];
BEGIN
  SELECT array_agg(slug ORDER BY slug) INTO slugs FROM public.list_public_tenants();
  ASSERT slugs = ARRAY['alkalma', 'maxina', 'zz-closed', 'zz-platform'],
    format('anon sees active slugged tenants only (got %s)', slugs);
  ASSERT (SELECT array_agg(slug) FROM public.list_public_tenants()) = slugs, 'list is ordered by slug';
  ASSERT EXISTS (SELECT 1 FROM public.list_public_tenants()
                  WHERE slug = 'maxina' AND display_name = 'Maxina' AND open_signup
                    AND brand = '{"accent":"#FF7BAC","bg":"#FFF5F8","fg":"#1a1a2e"}'::jsonb
                    AND landing = '{"intro":true,"auto_switch_on_visit":true,"post_login_path":"/onboarding/welcome","oauth":true}'::jsonb
                    AND locales IS NULL),
    'maxina entry: live brand + seeded landing';
  ASSERT EXISTS (SELECT 1 FROM public.list_public_tenants()
                  WHERE slug = 'alkalma' AND name = 'Alkalma' AND display_name = 'AlKalma'
                    AND brand = '{"accent":"#3B82F6","bg":"#EFF6FF","fg":"#1A1A1A"}'::jsonb
                    AND landing ->> 'post_login_path' = '/home'),
    'alkalma entry: seeded display name, colours and landing';
  -- Type guards: a non-object `tokens`, a non-boolean `intro`, a nested tagline value and
  -- unknown landing keys are dropped; a flat logo path is kept.
  ASSERT EXISTS (SELECT 1 FROM public.list_public_tenants()
                  WHERE slug = 'zz-closed' AND NOT open_signup
                    AND brand = '{"logo_path":"zz-closed/logo.png"}'::jsonb
                    AND landing = '{"tagline":{"de":"Hallo","en":"Hello"},"oauth":false,"post_login_path":"/home"}'::jsonb),
    'zz-closed entry: whitelist and type guards';
END $$;

-- (b) inactive and slug-NULL tenants are absent from both functions.
DO $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM public.list_public_tenants() WHERE slug = 'zz-inactive' OR slug IS NULL),
    'inactive / slug-NULL absent from list_public_tenants';
  ASSERT NOT EXISTS (SELECT 1 FROM public.resolve_tenant('zz-inactive')), 'inactive absent from resolve_tenant';
  ASSERT NOT EXISTS (SELECT 1 FROM public.resolve_tenant(NULL)), 'NULL slug resolves nothing';
END $$;

-- (c) exact resolution, never a fallback.
DO $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM public.resolve_tenant('UNKNOWN')), 'unknown slug is empty';
  ASSERT NOT EXISTS (SELECT 1 FROM public.resolve_tenant('')), 'empty slug is empty';
  ASSERT NOT EXISTS (SELECT 1 FROM public.resolve_tenant('maxin')), 'no prefix match';
  ASSERT (SELECT count(*) FROM public.resolve_tenant(' Maxina ')) = 1, 'trimmed, case-folded slug resolves';
  ASSERT (SELECT slug FROM public.resolve_tenant(' Maxina ')) = 'maxina', 'resolves to maxina';
  ASSERT (SELECT count(*) FROM public.resolve_tenant('alkalma')) = 1, 'alkalma resolves';
END $$;

-- (d) anon cannot reach the internal function nor read tenants / tenant_settings beyond today's policies.
DO $$
DECLARE
  refused boolean := false;
BEGIN
  BEGIN
    PERFORM * FROM public._tenant_public_registry();
  EXCEPTION WHEN insufficient_privilege THEN refused := true;
  END;
  ASSERT refused, 'anon cannot execute _tenant_public_registry()';
  ASSERT (SELECT count(*) FROM public.tenants) = 0, 'anon still reads no tenants row directly';
  ASSERT (SELECT count(*) FROM public.tenant_settings) = 0, 'anon still reads no tenant_settings row directly';
END $$;
RESET ROLE;

SET ROLE authenticated;
DO $$
DECLARE
  refused boolean := false;
BEGIN
  BEGIN
    PERFORM * FROM public._tenant_public_registry();
  EXCEPTION WHEN insufficient_privilege THEN refused := true;
  END;
  ASSERT refused, 'authenticated cannot execute _tenant_public_registry()';
  ASSERT (SELECT count(*) FROM public.resolve_tenant('maxina')) = 1, 'authenticated can resolve';
  ASSERT (SELECT count(*) FROM public.tenant_settings) = 0, 'non-member reads no tenant_settings row directly';
END $$;
RESET ROLE;

DO $$
BEGIN
  ASSERT has_function_privilege('anon', 'public.list_public_tenants()', 'EXECUTE'), 'anon EXECUTE list_public_tenants';
  ASSERT has_function_privilege('anon', 'public.resolve_tenant(text)', 'EXECUTE'), 'anon EXECUTE resolve_tenant';
  ASSERT has_function_privilege('service_role', 'public.resolve_tenant(text)', 'EXECUTE'), 'service_role EXECUTE resolve_tenant';
  ASSERT NOT has_function_privilege('anon', 'public._tenant_public_registry()', 'EXECUTE'), 'anon no EXECUTE on internal';
  ASSERT NOT has_function_privilege('authenticated', 'public._tenant_public_registry()', 'EXECUTE'), 'authenticated no EXECUTE on internal';
  ASSERT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.list_public_tenants()'::regprocedure), 'list is SECURITY DEFINER';
  ASSERT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.resolve_tenant(text)'::regprocedure), 'resolve is SECURITY DEFINER';
  ASSERT NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public._tenant_public_registry()'::regprocedure), 'internal is not SECURITY DEFINER';
  ASSERT (SELECT provolatile FROM pg_proc WHERE oid = 'public.resolve_tenant(text)'::regprocedure) = 's', 'resolve is STABLE (GET-able)';
  ASSERT (SELECT provolatile FROM pg_proc WHERE oid = 'public.list_public_tenants()'::regprocedure) = 's', 'list is STABLE (GET-able)';
END $$;

-- (f) no secret ever leaves the function, and only whitelisted keys exist.
SET ROLE anon;
DO $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM public.list_public_tenants() r
                      WHERE to_jsonb(r)::text ~ '(sk_live|secret-plan|support@|stripe_key|api_key|drop)'),
    'no planted secret in the output';
  ASSERT NOT EXISTS (SELECT 1 FROM public.list_public_tenants() r, jsonb_object_keys(r.brand) k
                      WHERE k NOT IN ('accent', 'bg', 'fg', 'logo_path', 'favicon_path', 'og_image_path')),
    'brand keys are whitelisted';
  ASSERT NOT EXISTS (SELECT 1 FROM public.list_public_tenants() r, jsonb_object_keys(r.landing) k
                      WHERE k NOT IN ('tagline', 'intro', 'auto_switch_on_visit', 'post_login_path', 'oauth')),
    'landing keys are whitelisted';
END $$;
RESET ROLE;

-- (e) forward compatibility: lane A's is_platform and lane B's brand/landing/locales columns are
-- picked up without re-creating the functions; the platform row disappears.
ALTER TABLE public.tenants ADD COLUMN is_platform boolean NOT NULL DEFAULT false;
UPDATE public.tenants SET is_platform = true WHERE slug = 'zz-platform';
ALTER TABLE public.tenant_settings ADD COLUMN brand jsonb, ADD COLUMN landing jsonb, ADD COLUMN locales jsonb;
UPDATE public.tenant_settings
   SET brand   = '{"tokens":{"accent":"#000001"},"assets":{"logo":"maxina/logo.svg"},"display_name":"MAXINA","secret":"drop"}',
       landing = '{"oauth":false,"post_login_path":"/home","secret":"drop"}',
       locales = '["de","en"]'
 WHERE tenant_id = '11111111-0000-0000-0000-000000000001';

SET ROLE anon;
DO $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM public.list_public_tenants() WHERE slug = 'zz-platform'), 'platform row filtered from list';
  ASSERT NOT EXISTS (SELECT 1 FROM public.resolve_tenant('zz-platform')), 'platform row filtered from resolve';
  ASSERT (SELECT count(*) FROM public.list_public_tenants()) = 3, 'three public tenants after is_platform';
  ASSERT EXISTS (SELECT 1 FROM public.resolve_tenant('maxina')
                  WHERE display_name = 'MAXINA'
                    AND brand = '{"accent":"#000001","bg":"#FFF5F8","fg":"#1a1a2e","logo_path":"maxina/logo.svg"}'::jsonb
                    AND landing = '{"intro":true,"auto_switch_on_visit":true,"post_login_path":"/home","oauth":false}'::jsonb
                    AND locales = '["de","en"]'::jsonb),
    'tenant_settings.brand/landing/locales override the legacy keys';
  ASSERT EXISTS (SELECT 1 FROM public.resolve_tenant('alkalma') WHERE locales IS NULL AND display_name = 'AlKalma'),
    'a NULL brand/landing/locales column changes nothing';
  ASSERT NOT EXISTS (SELECT 1 FROM public.list_public_tenants() r WHERE to_jsonb(r)::text ~ '(secret|drop)'),
    'new columns still go through the whitelist';
END $$;
RESET ROLE;

-- (f) lane B's (VTID-05150) actual column names: tenant_settings.display_name, enabled_locales
-- (text[]), brand.colors.* and brand.<kind>_path are what the registry exposes.
ALTER TABLE public.tenant_settings ADD COLUMN display_name text, ADD COLUMN enabled_locales text[];
UPDATE public.tenant_settings
   SET display_name = 'AlKalma Community', enabled_locales = '{de,sr}',
       brand = '{"colors":{"accent":"#0A0B0C","bg":"#FFFFFF","fg":"#111111"},"logo_path":"alkalma/logo.png"}'
 WHERE tenant_id = (SELECT tenant_id FROM public.tenants WHERE slug = 'alkalma');
SET ROLE anon;
DO $$
BEGIN
  ASSERT EXISTS (SELECT 1 FROM public.resolve_tenant('alkalma')
                  WHERE display_name = 'AlKalma Community'
                    AND locales = '["de","sr"]'::jsonb
                    AND brand ->> 'accent' = '#0A0B0C' AND brand ->> 'fg' = '#111111'
                    AND brand ->> 'logo_path' = 'alkalma/logo.png'),
    'lane B column names (display_name, enabled_locales, brand.colors, brand.logo_path) are exposed';
END $$;
RESET ROLE;

\echo 'VTID-05151: all assertions passed'
