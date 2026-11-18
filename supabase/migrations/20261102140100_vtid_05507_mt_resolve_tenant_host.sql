-- VTID-05507 (mt-m3-r2/tenant-domains-db) D2: resolve_tenant(p_host text, p_slug text), the host arm.
--
-- A SEPARATE two-argument overload with NO parameter defaults. The VTID-05151 one-argument resolve_tenant(p_slug text)
-- is not touched: its caller (vitana-v1 src/lib/tenant-registry.ts) passes { p_slug } and keeps binding it. With no
-- defaults the two overloads can never be ambiguous.
--
-- Behaviour: a host resolves ONLY when its tenant_domains row has verified_at IS NOT NULL, and ONLY through
-- _tenant_public_registry() (the same internal source the slug arm uses), so the is_active AND is_platform = false
-- filter still applies. An unverified host, or a host on an inactive or platform tenant, resolves to nothing and the
-- call falls through to resolve_tenant(p_slug).
--
-- Lane C whitelist: the same 8 columns and the same grants as the one-argument function. No tenant_domains column
-- (host, verified_at, is_primary) is ever returned.
--
-- Expand only (one new function). Safe to re-run (CREATE OR REPLACE).
-- Rollback: docs/validation/VTID-05507/rollback-140100-resolve-tenant-host.sql (drops only the two-argument overload).
-- Depends on: 20261102140000 (tenant_domains) and 20261014000600 (VTID-05151, _tenant_public_registry).

-- impact-allow-solo-migration: expand only (one new read function); the gateway host arm is a separate lane, dark
-- behind MT_RESOLUTION_V2.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('public.tenant_domains') IS NULL THEN
    RAISE EXCEPTION 'VTID-05507: public.tenant_domains is missing; apply 20261102140000 first';
  END IF;
  IF to_regprocedure('public._tenant_public_registry()') IS NULL
     OR to_regprocedure('public.resolve_tenant(text)') IS NULL THEN
    RAISE EXCEPTION 'VTID-05507: the VTID-05151 public registry functions are missing';
  END IF;
END $$;

-- definer-public: anonymous visitors on a custom domain resolve that community's public brand/landing fields before
-- sign-in (program section 4.1); same fixed whitelist as resolve_tenant(text), verified hosts of active non-platform tenants only
CREATE OR REPLACE FUNCTION public.resolve_tenant(p_host text, p_slug text)
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
  WITH h AS (
    SELECT r.tenant_id, r.slug, r.name, r.display_name, r.open_signup, r.brand, r.landing, r.locales
      FROM public.tenant_domains d
      JOIN public._tenant_public_registry() r ON r.tenant_id = d.tenant_id
     WHERE d.host = lower(btrim(p_host))
       AND d.verified_at IS NOT NULL
  )
  SELECT h.tenant_id, h.slug, h.name, h.display_name, h.open_signup, h.brand, h.landing, h.locales
    FROM h
  UNION ALL
  SELECT s.tenant_id, s.slug, s.name, s.display_name, s.open_signup, s.brand, s.landing, s.locales
    FROM public.resolve_tenant(p_slug) s
   WHERE NOT EXISTS (SELECT 1 FROM h)
$fn$;

REVOKE ALL ON FUNCTION public.resolve_tenant(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_tenant(text, text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.resolve_tenant(text, text) IS
  'VTID-05507: one tenant from the public registry by VERIFIED custom host, else by exact slug (resolve_tenant(text)); empty when neither matches. Same 8 columns as resolve_tenant(text).';

-- End state, asserted by effect.
DO $$
BEGIN
  IF NOT has_function_privilege('anon', 'public.resolve_tenant(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05507: anon cannot execute resolve_tenant(text, text)';
  END IF;
  IF NOT has_function_privilege('anon', 'public.resolve_tenant(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05507: the one-argument resolve_tenant(text) lost its anon grant';
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.oid = 'public.resolve_tenant(text, text)'::regprocedure AND p.pronargdefaults = 0) <> 1 THEN
    RAISE EXCEPTION 'VTID-05507: resolve_tenant(text, text) must have no parameter defaults';
  END IF;
END $$;

COMMIT;
