-- VTID-04878 test fixture, applied after the VTID-04809 wallet fixture and
-- migration (so credit_wallet() is the real one). Adds the account tables
-- claim_capped_reward() reads to exclude test/service accounts, and members.
-- Used by scripts/ci/test-vtid-04878-capped-rewards.sh on a throwaway local
-- Postgres; never against a real project.

CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);
CREATE TABLE IF NOT EXISTS public.service_bot_accounts (user_id uuid PRIMARY KEY, label text);
CREATE TABLE IF NOT EXISTS public.notification_test_actors (user_id uuid PRIMARY KEY, reason text);
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- m1, m2 real members · b1 service bot · t1 registered test actor · e1 e2e address
INSERT INTO public.profiles (user_id) VALUES
  ('00000000-0000-0000-0000-0000000000c1'), ('00000000-0000-0000-0000-0000000000c2'),
  ('00000000-0000-0000-0000-0000000000b1'), ('00000000-0000-0000-0000-0000000000d1'),
  ('00000000-0000-0000-0000-0000000000e1');
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'one@example.com'),
  ('00000000-0000-0000-0000-0000000000c2', 'two@example.com'),
  ('00000000-0000-0000-0000-0000000000e1', 'e2e-1776584475@vitanatest.exafy.io');
INSERT INTO public.service_bot_accounts (user_id, label) VALUES ('00000000-0000-0000-0000-0000000000b1', 'bot');
INSERT INTO public.notification_test_actors (user_id, reason) VALUES ('00000000-0000-0000-0000-0000000000d1', 'e2e');

-- Tables the sweep's candidate queries read (live columns, 2026-10-05).
CREATE TABLE public.user_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, user_id uuid, is_primary boolean
);
CREATE TABLE public.live_room_attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, live_room_id uuid, user_id uuid,
  joined_at timestamptz, left_at timestamptz,
  duration_minutes integer GENERATED ALWAYS AS (
    CASE WHEN left_at IS NOT NULL THEN EXTRACT(EPOCH FROM (left_at - joined_at)) / 60::numeric ELSE NULL END
  ) STORED,
  created_at timestamptz DEFAULT now(), session_id uuid, role text, lobby_status text,
  is_banned boolean DEFAULT false, disconnected_at timestamptz
);
CREATE TABLE public.vitana_index_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, user_id uuid, date date,
  score_total integer, created_at timestamptz DEFAULT now()
);
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

\set t '''aaaaaaaa-0000-0000-0000-000000000000'''
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES
  (:t, '00000000-0000-0000-0000-0000000000c1', true), (:t, '00000000-0000-0000-0000-0000000000c2', true),
  (:t, '00000000-0000-0000-0000-0000000000b1', true), (:t, '00000000-0000-0000-0000-0000000000d1', true),
  (:t, '00000000-0000-0000-0000-0000000000e1', true), (:t, '00000000-0000-0000-0000-0000000000c1', false);

-- Room R1: m1 30 min with m2 present (qualifies); m2 14:59 (does not).
-- Room R2: m1 alone for 40 min (does not). Room R3: bot 30 min with m1 (bot excluded).
INSERT INTO public.live_room_attendance (id, tenant_id, live_room_id, user_id, joined_at, left_at) VALUES
  ('10000000-0000-0000-0000-000000000001', :t, '20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', now() - interval '2 hours', now() - interval '90 minutes'),
  ('10000000-0000-0000-0000-000000000002', :t, '20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c2', now() - interval '2 hours', now() - interval '2 hours' + interval '14 minutes 59 seconds'),
  ('10000000-0000-0000-0000-000000000003', :t, '20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000c1', now() - interval '5 hours', now() - interval '4 hours 20 minutes'),
  ('10000000-0000-0000-0000-000000000004', :t, '20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000b1', now() - interval '3 hours', now() - interval '150 minutes'),
  ('10000000-0000-0000-0000-000000000005', :t, '20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000c1', now() - interval '3 hours', NULL);

-- Index: m1 best 80 then 95 today (+15, qualifies); m2 best 80 then 89 (+9, no);
-- e1 (e2e) 50 then 90 (excluded); c2 has only... see above.
INSERT INTO public.vitana_index_scores (tenant_id, user_id, date, score_total) VALUES
  (:t, '00000000-0000-0000-0000-0000000000c1', current_date - 20, 80),
  (:t, '00000000-0000-0000-0000-0000000000c1', current_date, 95),
  (:t, '00000000-0000-0000-0000-0000000000c2', current_date - 20, 80),
  (:t, '00000000-0000-0000-0000-0000000000c2', current_date, 89),
  (:t, '00000000-0000-0000-0000-0000000000e1', current_date - 20, 50),
  (:t, '00000000-0000-0000-0000-0000000000e1', current_date, 90);
