-- VTID-05595 PGlite stand-ins for the live tables the lane files touch. Models the LIVE tenants key (tenants.tenant_id,
-- VTID-04716). base_schema_id.sql models the bootstrap key (tenants.id). Columns are the subset the migrations use; the
-- policies are the REAL bootstrap ones (20251231000000_vtid_01101_phase_a_bootstrap.sql).
CREATE TABLE public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.app_users (
  user_id uuid PRIMARY KEY,
  email text UNIQUE NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_users_select_own ON public.app_users FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY app_users_all_service_role ON public.app_users FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TABLE public.user_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  active_role text NOT NULL DEFAULT 'community',
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
ALTER TABLE public.user_tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_tenants_select_own ON public.user_tenants FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY user_tenants_all_service_role ON public.user_tenants FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT ON public.tenants, public.app_users, public.user_tenants TO authenticated;
GRANT UPDATE ON public.app_users TO authenticated;  -- column grant is wider than prod on purpose: the RLS policy set (no UPDATE policy) must still block a member write
GRANT ALL ON public.tenants, public.app_users, public.user_tenants TO service_role;
