-- VTID-05493 PGlite stand-ins for the live tables the lane files touch (tenants key = tenant_id, live shape).
-- Columns are the subset the migrations and tests use. tenants_select is the bootstrap policy (20251231000000).
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb DEFAULT '{}';
CREATE TYPE public.tenant_role AS ENUM ('community', 'admin');
CREATE TABLE public.tenants (
  tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  open_signup boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false,
  is_platform boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_default_not_platform CHECK (NOT (is_default AND is_platform))
);
CREATE UNIQUE INDEX tenants_one_default ON public.tenants ((true)) WHERE is_default;
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_select_authenticated ON public.tenants FOR SELECT TO authenticated USING (true);
CREATE POLICY tenants_all_service_role ON public.tenants FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TABLE public.user_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  active_role text NOT NULL DEFAULT 'community',
  is_primary boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, user_id)
);
CREATE TABLE public.memberships (
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  role public.tenant_role NOT NULL,
  status text NOT NULL DEFAULT 'active',
  UNIQUE (user_id, tenant_id)
);
CREATE TABLE public.role_preferences (
  user_id uuid NOT NULL, tenant_id uuid NOT NULL, role text NOT NULL, UNIQUE (user_id, tenant_id)
);
CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, tenant_id uuid, event_type text,
  event_data jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.tenants, public.user_tenants, public.memberships, public.audit_events TO authenticated;
GRANT ALL ON public.tenants, public.user_tenants, public.memberships, public.role_preferences, public.audit_events TO service_role;
