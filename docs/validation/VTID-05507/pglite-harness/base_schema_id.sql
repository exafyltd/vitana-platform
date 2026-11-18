-- VTID-05507 PGlite stand-ins for the live tables the lane files touch. Models the LIVE tenants key (tenants.tenant_id).
-- base_schema_id.sql models the bootstrap key (tenants.id). Columns are the subset _tenant_public_registry() and the
-- migrations read. reserved_tenant_slugs is the VTID-05150 table (same columns, same grants).
CREATE TABLE public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_platform boolean NOT NULL DEFAULT false,
  open_signup boolean NOT NULL DEFAULT false,
  branding jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id),
  profile jsonb NOT NULL DEFAULT '{}',
  branding jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE public.reserved_tenant_slugs (
  slug text PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('spa_route', 'public_file', 'platform')),
  added_vtid text
);
ALTER TABLE public.reserved_tenant_slugs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.reserved_tenant_slugs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.reserved_tenant_slugs TO service_role;
GRANT SELECT ON public.tenants, public.tenant_settings TO authenticated;
GRANT ALL ON public.tenants, public.tenant_settings TO service_role;
