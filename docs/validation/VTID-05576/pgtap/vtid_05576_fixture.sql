-- VTID-05576 fixture: stand-ins for the LIVE tables the lane migrations touch, plus members. Local throwaway
-- database only (PGlite / `supabase test db`); never a shared or live one. Loaded BEFORE the lane migrations, so the
-- pre-existing chat_messages rows exist when the scope column is added (the backfill must give them 'community').
-- Shapes follow: 20260225200000 (chat_messages + policies), 20260315000000 (message_type, metadata), 20260525000000
-- (receiver_id nullable, group_id, target XOR, group policies), 20260522010000 (is_chat_group_member),
-- 20261021140000 (client_message_id, delivered_at). 20260608120000 already dropped service_role_manage_chat.
-- global_community_profiles / connection_requests are vitana-v1 tables (network-visibility-db, VTID-05582 columns).
CREATE TABLE public.tenants (tenant_id uuid PRIMARY KEY, slug text, is_platform boolean NOT NULL DEFAULT false);
CREATE TABLE public.user_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL,
  active_role text NOT NULL DEFAULT 'community', is_primary boolean NOT NULL DEFAULT false, UNIQUE (tenant_id, user_id));
CREATE TABLE public.global_community_profiles (
  user_id uuid PRIMARY KEY, display_name text, is_visible boolean NOT NULL DEFAULT true,
  network_visible boolean NOT NULL DEFAULT false, network_visible_decided_at timestamptz NULL,
  messaging_preference text NOT NULL DEFAULT 'connections' CHECK (messaging_preference IN ('everyone', 'connections', 'nobody')));
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
CREATE TABLE public.service_bot_accounts (user_id uuid PRIMARY KEY);
CREATE TABLE public.notification_test_actors (user_id uuid PRIMARY KEY);

CREATE TABLE public.chat_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, name text NOT NULL, description text,
  created_by uuid, is_system boolean NOT NULL DEFAULT false, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.chat_group_members (
  group_id uuid NOT NULL REFERENCES public.chat_groups(id) ON DELETE CASCADE, user_id uuid NOT NULL, tenant_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member', joined_at timestamptz NOT NULL DEFAULT now(), last_read_at timestamptz,
  PRIMARY KEY (group_id, user_id));
CREATE FUNCTION public.is_chat_group_member(p_group_id uuid, p_user_id uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER
  SET search_path = public STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.chat_group_members WHERE group_id = p_group_id AND user_id = p_user_id) $$;

CREATE TABLE public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, sender_id uuid NOT NULL, receiver_id uuid,
  content text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  message_type text NOT NULL DEFAULT 'text', metadata jsonb NOT NULL DEFAULT '{}',
  group_id uuid NULL REFERENCES public.chat_groups(id) ON DELETE SET NULL,
  client_message_id uuid NULL, delivered_at timestamptz NULL,
  CONSTRAINT chat_messages_target_xor CHECK ((receiver_id IS NOT NULL AND group_id IS NULL) OR (receiver_id IS NULL AND group_id IS NOT NULL)));
CREATE UNIQUE INDEX uq_chat_messages_sender_client_message_id ON public.chat_messages (sender_id, client_message_id) WHERE client_message_id IS NOT NULL;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_read_own_messages ON public.chat_messages FOR SELECT USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
CREATE POLICY users_send_messages ON public.chat_messages FOR INSERT WITH CHECK (auth.uid() = sender_id);
CREATE POLICY users_mark_received_read ON public.chat_messages FOR UPDATE USING (auth.uid() = receiver_id) WITH CHECK (auth.uid() = receiver_id);
CREATE POLICY users_read_group_messages ON public.chat_messages FOR SELECT
  USING (group_id IS NOT NULL AND public.is_chat_group_member(chat_messages.group_id, auth.uid()));
CREATE POLICY users_send_group_messages ON public.chat_messages FOR INSERT
  WITH CHECK (group_id IS NOT NULL AND auth.uid() = sender_id AND public.is_chat_group_member(chat_messages.group_id, auth.uid()));
-- Live grants: clients may SELECT/INSERT/UPDATE (anon lost every write in 20260608120000); service_role has everything.
GRANT SELECT, INSERT, UPDATE ON public.chat_messages TO authenticated;
GRANT ALL ON public.chat_messages TO service_role;
GRANT SELECT ON public.chat_group_members, public.chat_groups TO authenticated, service_role;

-- Members. Ids: ...0001..0004 real members, 0005 service bot, 0006 notification test actor.
INSERT INTO public.tenants (tenant_id, slug, is_platform) VALUES
  ('05576000-0000-4000-8000-0000000000a1', 'ta', false),
  ('05576000-0000-4000-8000-0000000000a2', 'tb', false),
  ('05576000-0000-4000-8000-0000000000a3', 'platform', true);
INSERT INTO auth.users (id, email)
  SELECT ('05576000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid, 'u' || g || '@example.test' FROM generate_series(1, 8) g;
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES
  ('05576000-0000-4000-8000-0000000000a1', '05576000-0000-4000-8000-000000000001', true),   -- U1 in TA
  ('05576000-0000-4000-8000-0000000000a1', '05576000-0000-4000-8000-000000000002', true),   -- U2 in TA
  ('05576000-0000-4000-8000-0000000000a2', '05576000-0000-4000-8000-000000000003', true),   -- U3 in TB
  ('05576000-0000-4000-8000-0000000000a1', '05576000-0000-4000-8000-000000000004', true),   -- U4 in TA and TB
  ('05576000-0000-4000-8000-0000000000a2', '05576000-0000-4000-8000-000000000004', false),
  ('05576000-0000-4000-8000-0000000000a3', '05576000-0000-4000-8000-000000000001', false),  -- U1, U3 also in the PLATFORM tenant
  ('05576000-0000-4000-8000-0000000000a3', '05576000-0000-4000-8000-000000000003', false);
INSERT INTO public.service_bot_accounts (user_id) VALUES ('05576000-0000-4000-8000-000000000005');
INSERT INTO public.notification_test_actors (user_id) VALUES ('05576000-0000-4000-8000-000000000006');
INSERT INTO public.global_community_profiles (user_id, display_name)
  SELECT ('05576000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid, 'User ' || g FROM generate_series(1, 7) g;

-- A TA group (U1, U2 members) and two PRE-EXISTING messages (one DM, one group message), written before the scope column exists.
INSERT INTO public.chat_groups (id, tenant_id, name) VALUES ('05576000-0000-4000-8000-0000000000b1', '05576000-0000-4000-8000-0000000000a1', 'TA group');
INSERT INTO public.chat_group_members (group_id, user_id, tenant_id) VALUES
  ('05576000-0000-4000-8000-0000000000b1', '05576000-0000-4000-8000-000000000001', '05576000-0000-4000-8000-0000000000a1'),
  ('05576000-0000-4000-8000-0000000000b1', '05576000-0000-4000-8000-000000000002', '05576000-0000-4000-8000-0000000000a1');
INSERT INTO public.chat_messages (id, tenant_id, sender_id, receiver_id, content) VALUES
  ('05576000-0000-4000-8000-0000000000c1', '05576000-0000-4000-8000-0000000000a1', '05576000-0000-4000-8000-000000000001', '05576000-0000-4000-8000-000000000002', 'pre-existing dm');
INSERT INTO public.chat_messages (id, tenant_id, sender_id, group_id, content) VALUES
  ('05576000-0000-4000-8000-0000000000c2', '05576000-0000-4000-8000-0000000000a1', '05576000-0000-4000-8000-000000000001', '05576000-0000-4000-8000-0000000000b1', 'pre-existing group message');
