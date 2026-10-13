-- VTID-05151 test fixture: the live (2026-10-13) shape of public.tenants and
-- public.tenant_settings, their client-facing policies and grants, and the two
-- live tenant rows, plus test-only tenants (inactive, slug NULL, a future
-- platform row) and secret keys planted in branding/profile. Used by
-- scripts/ci/test-vtid-05151-public-tenant-registry.sh.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE FUNCTION public.current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid $$;

-- Live columns (information_schema, 2026-10-13).
CREATE TABLE public.tenants (
  tenant_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  created_at     timestamptz DEFAULT now(),
  slug           text UNIQUE,
  policy_profile jsonb NOT NULL DEFAULT '{}',
  branding       jsonb NOT NULL DEFAULT '{}',
  is_active      boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  open_signup    boolean NOT NULL DEFAULT false
);

CREATE TABLE public.tenant_settings (
  tenant_id     uuid PRIMARY KEY REFERENCES public.tenants (tenant_id),
  profile       jsonb NOT NULL DEFAULT '{}',
  branding      jsonb NOT NULL DEFAULT '{}',
  feature_flags jsonb NOT NULL DEFAULT '{}',
  integrations  jsonb NOT NULL DEFAULT '{}',
  domains       jsonb NOT NULL DEFAULT '{}',
  billing       jsonb NOT NULL DEFAULT '{}',
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid
);

CREATE TABLE public.memberships (
  user_id uuid NOT NULL, tenant_id uuid NOT NULL, status text NOT NULL DEFAULT 'active',
  PRIMARY KEY (user_id, tenant_id)
);

-- Supabase default table grants, live policies.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenants, public.tenant_settings, public.memberships
  TO anon, authenticated, service_role;
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_all_service_role ON public.tenants FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY tenants_cud_exafy_only ON public.tenants FOR ALL TO public
  USING (((auth.jwt() -> 'app_metadata') ->> 'exafy_admin')::boolean = true);
CREATE POLICY tenants_read ON public.tenants FOR SELECT TO public USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenants_select_any_member ON public.tenants FOR SELECT TO public USING (
  (((auth.jwt() -> 'app_metadata') ->> 'exafy_admin')::boolean = true)
  OR EXISTS (SELECT 1 FROM public.memberships m
              WHERE m.user_id = auth.uid() AND m.tenant_id = tenants.tenant_id AND m.status = 'active'));
CREATE POLICY tenants_select_authenticated ON public.tenants FOR SELECT TO authenticated USING (true);
CREATE POLICY service_all ON public.tenant_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY tenant_settings_member_read ON public.tenant_settings FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.memberships m
           WHERE m.tenant_id = tenant_settings.tenant_id AND m.user_id = auth.uid() AND m.status = 'active'));

-- Live rows (2026-10-13), with a secret planted in maxina's branding/profile and integrations.
INSERT INTO public.tenants (tenant_id, name, slug, open_signup, policy_profile) VALUES
  ('11111111-0000-0000-0000-000000000001', 'Maxina',  'maxina',  true, '{"stripe_key":"sk_live_policy"}'),
  ('11111111-0000-0000-0000-000000000002', 'Alkalma', 'alkalma', true, '{}');
INSERT INTO public.tenant_settings (tenant_id, branding, profile, integrations, billing) VALUES
  ('11111111-0000-0000-0000-000000000001',
   '{"brand_accent":"#FF7BAC","brand_bg":"#FFF5F8","brand_fg":"#1a1a2e","stripe_key":"sk_live_branding"}',
   '{"name":"Maxina","description":"Maxina Longevity Community","support_email":"support@vitanaland.com","stripe_key":"sk_live_profile"}',
   '{"api_key":"sk_live_integrations"}', '{"plan":"secret-plan"}'),
  ('11111111-0000-0000-0000-000000000002', '{}', '{}', '{}', '{}');

-- Test-only tenants.
INSERT INTO public.tenants (tenant_id, name, slug, is_active, open_signup) VALUES
  ('11111111-0000-0000-0000-0000000000a1', 'Retired Co', 'zz-inactive', false, true),
  ('11111111-0000-0000-0000-0000000000a2', 'No Slug',    NULL,          true,  true),
  ('11111111-0000-0000-0000-0000000000a3', 'Vitana Platform', 'zz-platform', true, false),
  ('11111111-0000-0000-0000-0000000000a4', 'Closed Co',  'zz-closed',   true,  false);
INSERT INTO public.tenant_settings (tenant_id, branding, profile) VALUES
  ('11111111-0000-0000-0000-0000000000a4',
   '{"tokens":"not-an-object","logo_path":"zz-closed/logo.png"}',
   '{"landing":{"tagline":{"de":"Hallo","en":"Hello","x":{"nested":"drop"}},"intro":"yes","oauth":false,"post_login_path":"/home","secret":"drop"}}');
