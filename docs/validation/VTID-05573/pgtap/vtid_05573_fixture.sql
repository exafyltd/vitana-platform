-- VTID-05573 fixture: stand-ins for the LIVE tables the lane migrations touch, plus members and legacy message rows.
-- Local throwaway database only (PGlite / `supabase test db`); never a shared or live one. Loaded BEFORE the real
-- migrations 20261102050000 (chat_messages.scope, VTID-05576) and 20261102051000 (is_network_excluded_account, VTID-05582),
-- then the lane files. Shapes follow: vitana-v1 20250917143525 / 20250917153624 / 20250918121457 (legacy tables) and the
-- platform chat tables (20260225200000, 20260315000000, 20260525000000, 20261021140000).
-- Members (ids ...0001..0008):
--   U1 TA primary          U2 TA                U3 TB             U4 TA primary and TB   U5 service bot (rule 43)
--   U6 notification actor  U7 TB (no activity)  U8 no tenant at all
-- Supabase default: every table created in public is granted to the three API roles (RLS then gates rows).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
CREATE TABLE public.tenants (tenant_id uuid PRIMARY KEY, slug text, is_platform boolean NOT NULL DEFAULT false);
CREATE TABLE public.user_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL,
  active_role text NOT NULL DEFAULT 'community', is_primary boolean NOT NULL DEFAULT false, UNIQUE (tenant_id, user_id));
CREATE TABLE public.service_bot_accounts (user_id uuid PRIMARY KEY);
CREATE TABLE public.notification_test_actors (user_id uuid PRIMARY KEY);
CREATE TABLE public.global_community_profiles (
  user_id uuid PRIMARY KEY, display_name text, is_visible boolean NOT NULL DEFAULT true);

CREATE TABLE public.chat_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, name text NOT NULL, description text,
  created_by uuid, is_system boolean NOT NULL DEFAULT false, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.chat_group_members (
  group_id uuid NOT NULL REFERENCES public.chat_groups(id) ON DELETE CASCADE, user_id uuid NOT NULL, tenant_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'bot')),
  joined_at timestamptz NOT NULL DEFAULT now(), last_read_at timestamptz, PRIMARY KEY (group_id, user_id));
CREATE TABLE public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, sender_id uuid NOT NULL, receiver_id uuid,
  content text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  message_type text NOT NULL DEFAULT 'text', metadata jsonb NOT NULL DEFAULT '{}',
  group_id uuid NULL REFERENCES public.chat_groups(id) ON DELETE SET NULL,
  client_message_id uuid NULL, delivered_at timestamptz NULL,
  CONSTRAINT chat_messages_target_xor CHECK ((receiver_id IS NOT NULL AND group_id IS NULL) OR (receiver_id IS NULL AND group_id IS NOT NULL)));
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.chat_messages TO authenticated;
GRANT ALL ON public.chat_messages, public.chat_groups, public.chat_group_members TO service_role;

-- Legacy tables (vitana-v1). Table-level ALL for the three API roles is the Supabase default; RLS does the gating.
CREATE TABLE public.message_threads (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, name text, type text NOT NULL DEFAULT 'direct',
  tenant_id uuid NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), metadata jsonb DEFAULT '{}'::jsonb);
CREATE TABLE public.thread_participants (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES public.message_threads(id) ON DELETE CASCADE, user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member', joined_at timestamptz NOT NULL DEFAULT now(), last_read_at timestamptz,
  is_active boolean NOT NULL DEFAULT true, UNIQUE (thread_id, user_id));
CREATE TABLE public.messages (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, tenant_id uuid NOT NULL, sender_id uuid, recipient_id uuid,
  thread_id uuid, body text NOT NULL, message_type text NOT NULL DEFAULT 'text', content_data jsonb,
  parent_message_id uuid REFERENCES public.messages(id), workflow_type text, action_buttons jsonb, expires_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz DEFAULT now(), delivered_at timestamptz, read_at timestamptz);
CREATE TABLE public.global_message_threads (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, created_by uuid NOT NULL, name text, type text NOT NULL DEFAULT 'direct',
  metadata jsonb DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.global_thread_participants (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, thread_id uuid NOT NULL, user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member', joined_at timestamptz NOT NULL DEFAULT now(), last_read_at timestamptz,
  is_active boolean NOT NULL DEFAULT true, UNIQUE (thread_id, user_id));
ALTER TABLE public.global_thread_participants ADD CONSTRAINT fk_global_thread_participants_thread   -- vitana-v1 20250917153624
  FOREIGN KEY (thread_id) REFERENCES public.global_message_threads(id) ON DELETE CASCADE;
CREATE TABLE public.global_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, thread_id uuid NOT NULL, sender_id uuid NOT NULL, body text NOT NULL,
  message_type text NOT NULL DEFAULT 'text', content_data jsonb, parent_message_id uuid,
  created_at timestamptz DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz DEFAULT now(), delivered_at timestamptz, read_at timestamptz);
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.global_messages ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.message_threads, public.thread_participants, public.messages, public.global_message_threads,
  public.global_thread_participants, public.global_messages TO anon, authenticated, service_role;

INSERT INTO public.tenants (tenant_id, slug, is_platform) VALUES
  ('05573000-0000-4000-8000-0000000000a1', 'ta', false),
  ('05573000-0000-4000-8000-0000000000a2', 'tb', false),
  ('05573000-0000-4000-8000-0000000000a3', 'platform', true);
INSERT INTO auth.users (id, email)
  SELECT ('05573000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid, 'u' || g || '@example.test' FROM generate_series(1, 8) g;
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES
  ('05573000-0000-4000-8000-0000000000a1', '05573000-0000-4000-8000-000000000001', true),
  ('05573000-0000-4000-8000-0000000000a1', '05573000-0000-4000-8000-000000000002', true),
  ('05573000-0000-4000-8000-0000000000a2', '05573000-0000-4000-8000-000000000003', true),
  ('05573000-0000-4000-8000-0000000000a1', '05573000-0000-4000-8000-000000000004', true),
  ('05573000-0000-4000-8000-0000000000a2', '05573000-0000-4000-8000-000000000004', false),
  ('05573000-0000-4000-8000-0000000000a3', '05573000-0000-4000-8000-000000000001', false),
  ('05573000-0000-4000-8000-0000000000a3', '05573000-0000-4000-8000-000000000003', false),
  ('05573000-0000-4000-8000-0000000000a2', '05573000-0000-4000-8000-000000000007', true);
INSERT INTO public.service_bot_accounts (user_id) VALUES ('05573000-0000-4000-8000-000000000005');
INSERT INTO public.notification_test_actors (user_id) VALUES ('05573000-0000-4000-8000-000000000006');

-- One pre-existing platform group message (must stay untouched by the lane).
INSERT INTO public.chat_groups (id, tenant_id, name) VALUES ('05573000-0000-4000-8000-0000000000b1', '05573000-0000-4000-8000-0000000000a1', 'Existing TA group');
INSERT INTO public.chat_group_members (group_id, user_id, tenant_id) VALUES
  ('05573000-0000-4000-8000-0000000000b1', '05573000-0000-4000-8000-000000000001', '05573000-0000-4000-8000-0000000000a1');
INSERT INTO public.chat_messages (id, tenant_id, sender_id, group_id, content) VALUES
  ('05573000-0000-4000-8000-0000000000c1', '05573000-0000-4000-8000-0000000000a1', '05573000-0000-4000-8000-000000000001',
   '05573000-0000-4000-8000-0000000000b1', 'pre-existing group message');
INSERT INTO public.chat_messages (id, tenant_id, sender_id, receiver_id, content) VALUES
  ('05573000-0000-4000-8000-0000000000c2', '05573000-0000-4000-8000-0000000000a1', '05573000-0000-4000-8000-000000000001',
   '05573000-0000-4000-8000-000000000002', 'pre-existing dm');

-- Legacy tenant messenger: 3 threads, 7 messages. Ids: threads ...0e1..0e3, messages ...0f01..0f07.
INSERT INTO public.message_threads (id, name, type, tenant_id, created_by) VALUES
  ('05573000-0000-4000-8000-0000000000e1', NULL,        'direct', '05573000-0000-4000-8000-0000000000a1', '05573000-0000-4000-8000-000000000001'),
  ('05573000-0000-4000-8000-0000000000e2', 'Team A',    'group',  '05573000-0000-4000-8000-0000000000a1', '05573000-0000-4000-8000-000000000001'),
  ('05573000-0000-4000-8000-0000000000e3', 'Bot group', 'group',  '05573000-0000-4000-8000-0000000000a1', '05573000-0000-4000-8000-000000000001');
INSERT INTO public.thread_participants (thread_id, user_id, role) VALUES
  ('05573000-0000-4000-8000-0000000000e1', '05573000-0000-4000-8000-000000000001', 'member'),
  ('05573000-0000-4000-8000-0000000000e1', '05573000-0000-4000-8000-000000000002', 'member'),
  ('05573000-0000-4000-8000-0000000000e2', '05573000-0000-4000-8000-000000000001', 'admin'),
  ('05573000-0000-4000-8000-0000000000e2', '05573000-0000-4000-8000-000000000002', 'moderator'),
  ('05573000-0000-4000-8000-0000000000e2', '05573000-0000-4000-8000-000000000004', 'member'),
  ('05573000-0000-4000-8000-0000000000e3', '05573000-0000-4000-8000-000000000001', 'member'),
  ('05573000-0000-4000-8000-0000000000e3', '05573000-0000-4000-8000-000000000005', 'member');
INSERT INTO public.messages (id, tenant_id, sender_id, recipient_id, thread_id, body, message_type, content_data, created_at, read_at) VALUES
  ('05573000-0000-4000-8000-000000000f01', '05573000-0000-4000-8000-0000000000a1', '05573000-0000-4000-8000-000000000001', '05573000-0000-4000-8000-000000000002', NULL, 'm1 shared tenant dm', 'text', '{"k":1}', '2026-01-01 10:00+00', '2026-01-01 11:00+00'),
  ('05573000-0000-4000-8000-000000000f02', '05573000-0000-4000-8000-0000000000a1', '05573000-0000-4000-8000-000000000001', '05573000-0000-4000-8000-000000000003', NULL, 'm2 no shared tenant dm', 'text', NULL, '2026-01-02 10:00+00', NULL),
  ('05573000-0000-4000-8000-000000000f03', '05573000-0000-4000-8000-0000000000a2', '05573000-0000-4000-8000-000000000003', '05573000-0000-4000-8000-000000000004', NULL, 'm3 tb dm', 'text', NULL, '2026-01-03 10:00+00', NULL),
  ('05573000-0000-4000-8000-000000000f04', '05573000-0000-4000-8000-0000000000a1', '05573000-0000-4000-8000-000000000001', '05573000-0000-4000-8000-000000000005', NULL, 'm4 to service bot', 'text', NULL, '2026-01-04 10:00+00', NULL),
  ('05573000-0000-4000-8000-000000000f05', '05573000-0000-4000-8000-0000000000a1', '05573000-0000-4000-8000-000000000002', NULL, '05573000-0000-4000-8000-0000000000e1', 'm5 thread dm', 'text', NULL, '2026-01-05 10:00+00', NULL),
  ('05573000-0000-4000-8000-000000000f06', '05573000-0000-4000-8000-0000000000a1', '05573000-0000-4000-8000-000000000001', NULL, '05573000-0000-4000-8000-0000000000e2', 'm6 group msg', 'text', NULL, '2026-01-06 10:00+00', NULL),
  ('05573000-0000-4000-8000-000000000f07', '05573000-0000-4000-8000-0000000000a1', '05573000-0000-4000-8000-000000000008', '05573000-0000-4000-8000-000000000001', NULL, 'm7 sender without tenant', 'text', NULL, '2026-01-07 10:00+00', NULL);

-- Legacy global messenger: 6 threads, 7 messages. Threads ...0d1..0d6, messages ...0a01..0a07.
INSERT INTO public.global_message_threads (id, created_by, name, type) VALUES
  ('05573000-0000-4000-8000-0000000000d1', '05573000-0000-4000-8000-000000000001', NULL,         'direct'),
  ('05573000-0000-4000-8000-0000000000d2', '05573000-0000-4000-8000-000000000003', NULL,         'direct'),
  ('05573000-0000-4000-8000-0000000000d3', '05573000-0000-4000-8000-000000000001', 'TA trio',    'group'),
  ('05573000-0000-4000-8000-0000000000d4', '05573000-0000-4000-8000-000000000001', 'Cross group', 'group'),
  ('05573000-0000-4000-8000-0000000000d5', '05573000-0000-4000-8000-000000000005', 'Bots only',  'group'),
  ('05573000-0000-4000-8000-0000000000d6', '05573000-0000-4000-8000-000000000001', 'Empty',      'group');
INSERT INTO public.global_thread_participants (thread_id, user_id, role) VALUES
  ('05573000-0000-4000-8000-0000000000d1', '05573000-0000-4000-8000-000000000001', 'member'),
  ('05573000-0000-4000-8000-0000000000d1', '05573000-0000-4000-8000-000000000002', 'member'),
  ('05573000-0000-4000-8000-0000000000d2', '05573000-0000-4000-8000-000000000001', 'member'),
  ('05573000-0000-4000-8000-0000000000d2', '05573000-0000-4000-8000-000000000003', 'member'),
  ('05573000-0000-4000-8000-0000000000d3', '05573000-0000-4000-8000-000000000001', 'admin'),
  ('05573000-0000-4000-8000-0000000000d3', '05573000-0000-4000-8000-000000000002', 'member'),
  ('05573000-0000-4000-8000-0000000000d3', '05573000-0000-4000-8000-000000000004', 'member'),
  ('05573000-0000-4000-8000-0000000000d4', '05573000-0000-4000-8000-000000000001', 'admin'),
  ('05573000-0000-4000-8000-0000000000d4', '05573000-0000-4000-8000-000000000003', 'member'),
  ('05573000-0000-4000-8000-0000000000d4', '05573000-0000-4000-8000-000000000004', 'member'),
  ('05573000-0000-4000-8000-0000000000d5', '05573000-0000-4000-8000-000000000005', 'member'),
  ('05573000-0000-4000-8000-0000000000d5', '05573000-0000-4000-8000-000000000006', 'member');
INSERT INTO public.global_messages (id, thread_id, sender_id, body, created_at) VALUES
  ('05573000-0000-4000-8000-000000000a01', '05573000-0000-4000-8000-0000000000d1', '05573000-0000-4000-8000-000000000001', 'g1 shared dm a', '2026-02-01 10:00+00'),
  ('05573000-0000-4000-8000-000000000a02', '05573000-0000-4000-8000-0000000000d1', '05573000-0000-4000-8000-000000000002', 'g2 shared dm b', '2026-02-01 10:05+00'),
  ('05573000-0000-4000-8000-000000000a03', '05573000-0000-4000-8000-0000000000d2', '05573000-0000-4000-8000-000000000003', 'g3 cross dm', '2026-02-02 10:00+00'),
  ('05573000-0000-4000-8000-000000000a04', '05573000-0000-4000-8000-0000000000d3', '05573000-0000-4000-8000-000000000004', 'g4 ta group', '2026-02-03 10:00+00'),
  ('05573000-0000-4000-8000-000000000a05', '05573000-0000-4000-8000-0000000000d4', '05573000-0000-4000-8000-000000000003', 'g5 cross group a', '2026-02-04 10:00+00'),
  ('05573000-0000-4000-8000-000000000a06', '05573000-0000-4000-8000-0000000000d4', '05573000-0000-4000-8000-000000000001', 'g6 cross group b', '2026-02-04 10:05+00'),
  ('05573000-0000-4000-8000-000000000a07', '05573000-0000-4000-8000-0000000000d5', '05573000-0000-4000-8000-000000000005', 'g7 bot message', '2026-02-05 10:00+00');
