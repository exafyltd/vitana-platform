-- VTID-05491 PGlite stand-ins for the live tables the lane files touch. Models the LIVE tenants key (tenants.tenant_id,
-- VTID-04716). Columns are the subset the migrations and tests use; the content_reports / moderation_actions tables and
-- policies are the REAL ones (vitana-v1 20251010065205 and 20260622120000_vtid_03319_phase1_moderation.sql).
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
GRANT EXECUTE ON FUNCTION auth.jwt() TO anon, authenticated, service_role;
CREATE TYPE public.tenant_role AS ENUM ('community', 'professional', 'staff', 'admin');
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
CREATE TABLE public.memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  role public.tenant_role NOT NULL DEFAULT 'community',
  status text NOT NULL DEFAULT 'active',
  UNIQUE (user_id, tenant_id)
);
CREATE TABLE public.tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(tenant_id),
  feature_flags jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.profile_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  tenant_id uuid,
  moderation_status text NOT NULL DEFAULT 'active',
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Real content_reports (vitana-v1 20251010065205:4-18, :79-80, :104, :109-118).
CREATE TABLE public.content_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  content_id UUID NOT NULL,
  reason TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  action_taken TEXT,
  admin_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_content_reports_status ON public.content_reports(status);
ALTER TABLE public.content_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can create content reports" ON public.content_reports FOR INSERT TO authenticated WITH CHECK (auth.uid() = reporter_user_id);
CREATE POLICY "Staff and admins can view all reports" ON public.content_reports FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = auth.uid() AND m.role IN ('staff', 'admin') AND m.status = 'active') OR COALESCE((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean, false) = true);
CREATE POLICY "Staff and admins can update reports" ON public.content_reports FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = auth.uid() AND m.role IN ('staff', 'admin') AND m.status = 'active') OR COALESCE((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean, false) = true);
-- Real moderation_actions + is_community_moderator() (vitana-v1 20260622120000:14-29, :53-71).
CREATE FUNCTION public.is_community_moderator() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  select exists (select 1 from public.memberships m where m.user_id = auth.uid()
        and m.role = any (array['staff','admin']::tenant_role[]) and m.status = 'active')
    or coalesce(((auth.jwt() -> 'app_metadata' ->> 'exafy_admin'))::boolean, false) = true;
$$;
CREATE TABLE public.moderation_actions (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid,
  action      text not null,
  target_type text not null,
  target_id   uuid,
  reason      text,
  created_at  timestamptz not null default now()
);
ALTER TABLE public.moderation_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins view moderation actions" ON public.moderation_actions FOR SELECT TO authenticated USING (public.is_community_moderator());
GRANT SELECT ON public.tenants, public.user_tenants, public.memberships, public.tenant_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.content_reports TO authenticated;
GRANT SELECT ON public.moderation_actions TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
-- service_role bypasses RLS on Supabase; PGlite's plain role needs the attribute.
ALTER ROLE service_role BYPASSRLS;
