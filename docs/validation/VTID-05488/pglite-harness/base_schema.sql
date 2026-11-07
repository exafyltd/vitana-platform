-- VTID-05488 PGlite stand-ins for the live tables the lane files touch. Models the LIVE tenants key (tenants.tenant_id,
-- see 20260218000000 / VTID-04716). base_schema_id.sql models the bootstrap key (tenants.id) for the second run.
-- Columns are the subset the migrations and tests use; the policies are the REAL foundation ones (is_active only).
CREATE TABLE public.tenants (
  tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.user_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  active_role text NOT NULL DEFAULT 'community',
  is_primary boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, user_id)
);
ALTER TABLE public.user_tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_tenants_select_own ON public.user_tenants FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE TABLE public.tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(tenant_id),
  feature_flags jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tenant_settings ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (name != ''),
  source_network text NOT NULL,
  is_active boolean NOT NULL DEFAULT TRUE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_network, name)
);
CREATE TABLE public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  source_network text NOT NULL,
  source_product_id text NOT NULL,
  title text NOT NULL CHECK (title != ''),
  affiliate_url text NOT NULL,
  is_active boolean NOT NULL DEFAULT TRUE,
  UNIQUE (source_network, source_product_id)
);
-- Real policies from 20260416120000_vtid_02000_marketplace_foundation.sql:728-738
ALTER TABLE public.merchants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS merchants_select ON public.merchants;
CREATE POLICY merchants_select ON public.merchants FOR SELECT TO authenticated USING (is_active = TRUE);
DROP POLICY IF EXISTS merchants_service ON public.merchants;
CREATE POLICY merchants_service ON public.merchants FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS products_select ON public.products;
CREATE POLICY products_select ON public.products FOR SELECT TO authenticated USING (is_active = TRUE);
DROP POLICY IF EXISTS products_service ON public.products;
CREATE POLICY products_service ON public.products FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
GRANT SELECT ON public.merchants, public.products, public.tenants, public.user_tenants, public.tenant_settings TO authenticated;
GRANT ALL ON public.merchants, public.products, public.tenants, public.user_tenants, public.tenant_settings TO service_role;
-- partner_tenant as Prisma created it (20260808_vcaop_mesh_factory_0001 + 0005), tenant_id TEXT NOT NULL.
CREATE TABLE public.partner_tenant (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'discovered',
  jurisdiction text,
  owner_user_id text,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- partner_organizations (VTID-04471) minimal stand-in for the optional FK.
CREATE TABLE public.partner_organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), display_name text);
