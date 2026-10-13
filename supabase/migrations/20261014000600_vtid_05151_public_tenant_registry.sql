-- VTID-05151 (multi-tenant M0, lane C, migration 1 of 2): public tenant registry.
--
-- Why: an anonymous visitor on a community link (/maxina, /alkalma, /<slug>) cannot resolve a
-- tenant today. The tenants policies only serve signed-in users (tenants_select_authenticated)
-- or the caller's own tenant (tenants_read, NULL for anon), and tenant_settings is readable only
-- through the legacy memberships table. So the frontend compiled two tenants in by name and
-- rendered every other tenant as Maxina. This migration exposes a fixed, whitelisted set of
-- public fields (name, open_signup, brand tokens/asset paths, landing switches, locales) through
-- two read functions, so the frontend can read the registry instead of compiling it in.
--
-- Shape:
--   _tenant_public_registry()    internal, NOT SECURITY DEFINER, revoked from every client role.
--                                LANGUAGE sql with a string body: the inner query is planned at
--                                call time, so columns lanes A/B add later (tenants.is_platform,
--                                tenant_settings.brand/landing/locales) are read through
--                                to_jsonb(...) without re-creating the function. The output is
--                                fixed by RETURNS TABLE and the key whitelist below: a new column
--                                never reaches a client unless a migration adds it here.
--   list_public_tenants()        SECURITY DEFINER wrappers, granted to anon/authenticated.
--   resolve_tenant(p_slug)       0 or 1 row, exact slug after lower(btrim()), never a fallback.
--
-- is_platform: inert until lane A adds tenants.is_platform (boolean NOT NULL DEFAULT false), so
-- the cast cannot fail. Whichever of A/C ships second rewrites the to_jsonb(t) read to
-- t.is_platform in its own migration (docs/multitenancy/MIGRATION-QUEUE.md).
--
-- Exposed: nothing but the RETURNS TABLE columns. Never policy_profile, feature_flags,
-- integrations, billing, domains, support e-mail or any other branding/profile key.
-- Lane B's (VTID-05150) actual names are read too: tenant_settings.display_name,
-- tenant_settings.enabled_locales (text[]), brand.colors.{accent,bg,fg}, brand.<kind>_path.
--
-- Rollback: docs/validation/VTID-05151/rollback-registry.sql (drops the three functions; no data).

-- impact-allow-solo-migration: expand only (three new read functions); the vitana-v1 registry
-- client ships in its own PRs and falls back to compiled Maxina until this is applied.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public._tenant_public_registry()
RETURNS TABLE (
  tenant_id    uuid,
  slug         text,
  name         text,
  display_name text,
  open_signup  boolean,
  brand        jsonb,
  landing      jsonb,
  locales      jsonb
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH src AS (
    SELECT t.tenant_id,
           t.slug,
           t.name,
           t.open_signup,
           to_jsonb(s) AS sj,
           s.profile   AS profile,
           -- Brand merge: tenants.branding < tenant_settings.branding < tenant_settings.brand
           -- (lane B). Only JSON objects take part; a JSON null or array is ignored.
           (CASE WHEN jsonb_typeof(t.branding) = 'object' THEN t.branding ELSE '{}'::jsonb END
            || CASE WHEN jsonb_typeof(s.branding) = 'object' THEN s.branding ELSE '{}'::jsonb END
            || CASE WHEN jsonb_typeof(to_jsonb(s) -> 'brand') = 'object' THEN to_jsonb(s) -> 'brand' ELSE '{}'::jsonb END
           ) AS b,
           (CASE WHEN jsonb_typeof(s.profile -> 'landing') = 'object' THEN s.profile -> 'landing' ELSE '{}'::jsonb END
            || CASE WHEN jsonb_typeof(to_jsonb(s) -> 'landing') = 'object' THEN to_jsonb(s) -> 'landing' ELSE '{}'::jsonb END
           ) AS l
      FROM public.tenants t
      LEFT JOIN public.tenant_settings s USING (tenant_id)
     WHERE t.is_active
       AND t.slug IS NOT NULL
       AND coalesce((to_jsonb(t) ->> 'is_platform')::boolean, false) = false
  )
  SELECT src.tenant_id,
         src.slug,
         src.name,
         coalesce(nullif(src.sj ->> 'display_name', ''), nullif(src.b ->> 'display_name', ''), src.name) AS display_name,
         src.open_signup,
         jsonb_strip_nulls(jsonb_build_object(
           'accent',        coalesce(src.b -> 'tokens' ->> 'accent', src.b -> 'colors' ->> 'accent', src.b ->> 'brand_accent'),
           'bg',            coalesce(src.b -> 'tokens' ->> 'bg',     src.b -> 'colors' ->> 'bg', src.b ->> 'brand_bg'),
           'fg',            coalesce(src.b -> 'tokens' ->> 'fg',     src.b -> 'colors' ->> 'fg', src.b ->> 'brand_fg'),
           'logo_path',     coalesce(src.b -> 'assets' ->> 'logo',     src.b ->> 'logo_path'),
           'favicon_path',  coalesce(src.b -> 'assets' ->> 'favicon',  src.b ->> 'favicon_path'),
           'og_image_path', coalesce(src.b -> 'assets' ->> 'og_image', src.b ->> 'og_image_path')
         )) AS brand,
         jsonb_strip_nulls(jsonb_build_object(
           'tagline', (SELECT jsonb_object_agg(e.key, e.value)
                         FROM jsonb_each(CASE WHEN jsonb_typeof(src.l -> 'tagline') = 'object'
                                              THEN src.l -> 'tagline' ELSE '{}'::jsonb END) e
                        WHERE jsonb_typeof(e.value) = 'string'),
           'intro',                CASE WHEN jsonb_typeof(src.l -> 'intro') = 'boolean' THEN src.l -> 'intro' END,
           'auto_switch_on_visit', CASE WHEN jsonb_typeof(src.l -> 'auto_switch_on_visit') = 'boolean' THEN src.l -> 'auto_switch_on_visit' END,
           'post_login_path',      CASE WHEN jsonb_typeof(src.l -> 'post_login_path') = 'string' THEN src.l -> 'post_login_path' END,
           'oauth',                CASE WHEN jsonb_typeof(src.l -> 'oauth') = 'boolean' THEN src.l -> 'oauth' END
         )) AS landing,
         CASE WHEN jsonb_typeof(coalesce(nullif(src.sj -> 'enabled_locales', 'null'::jsonb), nullif(src.sj -> 'locales', 'null'::jsonb), src.profile -> 'locales')) = 'array'
              THEN coalesce(nullif(src.sj -> 'enabled_locales', 'null'::jsonb), nullif(src.sj -> 'locales', 'null'::jsonb), src.profile -> 'locales')
         END AS locales
    FROM src
   ORDER BY src.slug
$fn$;

REVOKE ALL ON FUNCTION public._tenant_public_registry() FROM PUBLIC, anon, authenticated;

-- definer-public: anonymous visitors resolve a community's public brand/landing fields before sign-in (program §4.1); fixed whitelisted field list, never inactive or platform rows
CREATE OR REPLACE FUNCTION public.list_public_tenants()
RETURNS TABLE (
  tenant_id    uuid,
  slug         text,
  name         text,
  display_name text,
  open_signup  boolean,
  brand        jsonb,
  landing      jsonb,
  locales      jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT r.tenant_id, r.slug, r.name, r.display_name, r.open_signup, r.brand, r.landing, r.locales
    FROM public._tenant_public_registry() r
   ORDER BY r.slug
$fn$;

-- definer-public: same whitelist as list_public_tenants, one exact slug, empty for an unknown slug
CREATE OR REPLACE FUNCTION public.resolve_tenant(p_slug text)
RETURNS TABLE (
  tenant_id    uuid,
  slug         text,
  name         text,
  display_name text,
  open_signup  boolean,
  brand        jsonb,
  landing      jsonb,
  locales      jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT r.tenant_id, r.slug, r.name, r.display_name, r.open_signup, r.brand, r.landing, r.locales
    FROM public._tenant_public_registry() r
   WHERE r.slug = lower(btrim(p_slug))
$fn$;

REVOKE ALL ON FUNCTION public.list_public_tenants() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_tenant(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_public_tenants() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_tenant(text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.list_public_tenants() IS
  'VTID-05151: public tenant registry (active, non-platform tenants; whitelisted brand/landing/locales fields only).';
COMMENT ON FUNCTION public.resolve_tenant(text) IS
  'VTID-05151: one tenant from the public registry by exact slug; empty for an unknown slug, never a fallback.';

-- End state, asserted by effect.
DO $$
BEGIN
  IF NOT has_function_privilege('anon', 'public.list_public_tenants()', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05151: anon cannot execute list_public_tenants()';
  END IF;
  IF NOT has_function_privilege('anon', 'public.resolve_tenant(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05151: anon cannot execute resolve_tenant(text)';
  END IF;
  IF has_function_privilege('anon', 'public._tenant_public_registry()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._tenant_public_registry()', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05151: _tenant_public_registry() is executable by a client role';
  END IF;
  IF (SELECT count(*) FROM public.list_public_tenants() WHERE slug IN ('maxina', 'alkalma')) <> 2 THEN
    RAISE EXCEPTION 'VTID-05151: list_public_tenants() does not return maxina and alkalma';
  END IF;
  IF EXISTS (SELECT 1 FROM public.resolve_tenant('zz-not-a-tenant')) THEN
    RAISE EXCEPTION 'VTID-05151: resolve_tenant() returned a row for an unknown slug';
  END IF;
END $$;

COMMIT;
