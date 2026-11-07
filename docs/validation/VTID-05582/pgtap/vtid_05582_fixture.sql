-- VTID-05582 fixture: stand-ins for the LIVE tables the lane migrations touch, plus members. Local throwaway
-- database only (PGlite / `supabase test db`); never a shared or live one. Loaded BEFORE the lane migrations, so the
-- profile rows exist when the network_visible column is added (the backfill must leave them false).
-- global_community_profiles and connection_requests are vitana-v1 tables (20251111124306:24-37 for the latter).
CREATE TABLE public.tenants (tenant_id uuid PRIMARY KEY, slug text, is_platform boolean NOT NULL DEFAULT false);
CREATE TABLE public.user_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL,
  active_role text NOT NULL DEFAULT 'community', is_primary boolean NOT NULL DEFAULT false, UNIQUE (tenant_id, user_id));
CREATE TABLE public.global_community_profiles (user_id uuid PRIMARY KEY, display_name text, is_visible boolean NOT NULL DEFAULT true);
ALTER TABLE public.global_community_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY gcp_read ON public.global_community_profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY gcp_own_update ON public.global_community_profiles FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY gcp_own_insert ON public.global_community_profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
GRANT SELECT, INSERT, UPDATE ON public.global_community_profiles TO authenticated;
GRANT ALL ON public.global_community_profiles TO service_role;

CREATE TABLE public.connection_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  to_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  status text CHECK (status IN ('pending', 'accepted', 'declined')) DEFAULT 'pending',
  message text,
  request_type text CHECK (request_type IN ('normal', 'super')) DEFAULT 'normal',
  created_at timestamptz DEFAULT now(),
  responded_at timestamptz,
  UNIQUE (from_user_id, to_user_id));
ALTER TABLE public.connection_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view connection requests they sent or received" ON public.connection_requests FOR SELECT
  USING (auth.uid() = from_user_id OR auth.uid() = to_user_id);
CREATE POLICY "Users can create connection requests" ON public.connection_requests FOR INSERT WITH CHECK (auth.uid() = from_user_id);
CREATE POLICY "Recipients can update connection requests" ON public.connection_requests FOR UPDATE USING (auth.uid() = to_user_id);
-- Live grants (scripts/aws/aurora-cutover-restore-grants.sql:274,1664,3058): authenticated can SELECT/INSERT/UPDATE/DELETE.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.connection_requests TO authenticated;
GRANT ALL ON public.connection_requests TO service_role;

CREATE TABLE public.service_bot_accounts (user_id uuid PRIMARY KEY);
CREATE TABLE public.notification_test_actors (user_id uuid PRIMARY KEY);
CREATE TABLE public.platform_only_members (user_id uuid PRIMARY KEY);
-- platform_only_accounts is a VIEW (created by another spec); the migration reads it only when it exists.
CREATE VIEW public.platform_only_accounts AS SELECT user_id FROM public.platform_only_members;
CREATE TABLE public.user_blocklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL, blocked_user_id uuid NOT NULL,
  reason text NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, blocked_user_id));

-- Members. Ids: ...0001..0004 real members, 0005 service bot, 0006 notification test actor, 0007 platform-only.
INSERT INTO public.tenants (tenant_id, slug, is_platform) VALUES
  ('05582000-0000-4000-8000-0000000000a1', 'ta', false),
  ('05582000-0000-4000-8000-0000000000a2', 'tb', false),
  ('05582000-0000-4000-8000-0000000000a3', 'platform', true);
INSERT INTO auth.users (id, email)
  SELECT ('05582000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid, 'u' || g || '@example.test' FROM generate_series(1, 8) g;
INSERT INTO public.user_tenants (tenant_id, user_id) VALUES
  ('05582000-0000-4000-8000-0000000000a1', '05582000-0000-4000-8000-000000000001'),  -- U1 in TA
  ('05582000-0000-4000-8000-0000000000a1', '05582000-0000-4000-8000-000000000002'),  -- U2 in TA
  ('05582000-0000-4000-8000-0000000000a2', '05582000-0000-4000-8000-000000000003'),  -- U3 in TB
  ('05582000-0000-4000-8000-0000000000a1', '05582000-0000-4000-8000-000000000004'),  -- U4 in TA and TB
  ('05582000-0000-4000-8000-0000000000a2', '05582000-0000-4000-8000-000000000004'),
  ('05582000-0000-4000-8000-0000000000a3', '05582000-0000-4000-8000-000000000001'),  -- U1 also in the PLATFORM tenant
  ('05582000-0000-4000-8000-0000000000a3', '05582000-0000-4000-8000-000000000003');  -- U3 also in the PLATFORM tenant
INSERT INTO public.service_bot_accounts (user_id) VALUES ('05582000-0000-4000-8000-000000000005');
INSERT INTO public.notification_test_actors (user_id) VALUES ('05582000-0000-4000-8000-000000000006');
INSERT INTO public.platform_only_members (user_id) VALUES ('05582000-0000-4000-8000-000000000007');
INSERT INTO public.global_community_profiles (user_id, display_name)
  SELECT ('05582000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid, 'User ' || g FROM generate_series(1, 7) g;
