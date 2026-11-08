-- VTID-05579 fixture, part 1: stand-ins for the LIVE tables the lane migrations touch. Local throwaway database only
-- (PGlite / `supabase test db`); never a shared or live one. Loaded BEFORE the real dependency migrations 20261102050000
-- (chat_messages.scope, VTID-05576) and 20261102051000 (is_network_excluded_account + the network_visible guard, VTID-05582),
-- then vtid_05579_fixture_data.sql (the rows), then the lane files. Shapes follow: 20260525000000 (chat_groups,
-- chat_group_members, RLS), 20260522010000 (is_chat_group_member and the recursion-free read policies; the allow-all
-- service_role policies were dropped by 20260608120000:26-27), 20260225200000 / 20260315000000 / 20261021140000 (chat_messages),
-- vitana-v1 20250917153624 (global_community_profiles) and 20251111124306 (connection_requests).
-- Supabase default: every table created in public is granted to the three API roles (RLS then gates rows).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
CREATE TABLE public.tenants (tenant_id uuid PRIMARY KEY, slug text, is_platform boolean NOT NULL DEFAULT false);
CREATE TABLE public.user_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL,
  active_role text NOT NULL DEFAULT 'community', is_primary boolean NOT NULL DEFAULT false, UNIQUE (tenant_id, user_id));
CREATE TABLE public.service_bot_accounts (user_id uuid PRIMARY KEY);
CREATE TABLE public.notification_test_actors (user_id uuid PRIMARY KEY);
CREATE TABLE public.platform_only_accounts (user_id uuid PRIMARY KEY);
CREATE TABLE public.global_community_profiles (
  user_id uuid PRIMARY KEY, display_name text, is_visible boolean NOT NULL DEFAULT true);
CREATE TABLE public.connection_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  to_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  status text CHECK (status IN ('pending', 'accepted', 'declined')) DEFAULT 'pending',
  message text, request_type text DEFAULT 'normal', created_at timestamptz DEFAULT now(), responded_at timestamptz,
  UNIQUE (from_user_id, to_user_id));
CREATE TABLE public.user_blocklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL, blocked_user_id uuid NOT NULL,
  reason text NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, blocked_user_id));

CREATE TABLE public.chat_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, name text NOT NULL, description text,
  created_by uuid, is_system boolean NOT NULL DEFAULT false, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.chat_group_members (
  group_id uuid NOT NULL REFERENCES public.chat_groups(id) ON DELETE CASCADE, user_id uuid NOT NULL, tenant_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'bot')),
  joined_at timestamptz NOT NULL DEFAULT now(), last_read_at timestamptz, PRIMARY KEY (group_id, user_id));
CREATE INDEX idx_chat_group_members_user ON public.chat_group_members (user_id);
CREATE FUNCTION public.is_chat_group_member(p_group_id uuid, p_user_id uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER
  SET search_path = public STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.chat_group_members WHERE group_id = p_group_id AND user_id = p_user_id) $$;
REVOKE ALL ON FUNCTION public.is_chat_group_member(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_chat_group_member(uuid, uuid) TO authenticated, anon, service_role;
ALTER TABLE public.chat_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_group_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_groups_member_read ON public.chat_groups FOR SELECT USING (public.is_chat_group_member(chat_groups.id, auth.uid()));
CREATE POLICY chat_group_members_read ON public.chat_group_members FOR SELECT USING (public.is_chat_group_member(chat_group_members.group_id, auth.uid()));

CREATE TABLE public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, sender_id uuid NOT NULL, receiver_id uuid,
  content text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  message_type text NOT NULL DEFAULT 'text', metadata jsonb NOT NULL DEFAULT '{}',
  group_id uuid NULL REFERENCES public.chat_groups(id) ON DELETE SET NULL,
  client_message_id uuid NULL, delivered_at timestamptz NULL,
  CONSTRAINT chat_messages_target_xor CHECK ((receiver_id IS NOT NULL AND group_id IS NULL) OR (receiver_id IS NULL AND group_id IS NOT NULL)));
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_read_group_messages ON public.chat_messages FOR SELECT
  USING (group_id IS NOT NULL AND public.is_chat_group_member(chat_messages.group_id, auth.uid()));
