-- VTID-05150 test fixture: the tables provision_tenant() and the brand-pack
-- migration touch, with the live (2026-10-13, read-only catalog read) columns,
-- defaults and constraints, on a throwaway local Postgres, for
-- scripts/ci/test-vtid-05150-provision-tenant.sh.
--  * two legacy tenants with their live ids and live tenant_settings jsonb;
--  * notification_type_controls: the 16 platform-baseline types in both
--    tenants (one switched off in alkalma, to prove bool_or), plus maxina's 5
--    local rows (3 auto-registered OFF on first send, 2 enabled) that alkalma
--    lacks — the live shape;
--  * identical ai_provider_policies for both (the live rows);
--  * maxina's autopilot row and "Alle Beisammen" system group + bot;
--  * auth.users: an exafy_admin, a plain user, a service bot, a test actor;
--  * the member-facing tables provisioning must never write (user_tenants,
--    memberships, app_users, chat_messages, user_notifications, founding_members).
-- Lane A M1 (tenants.is_default/is_platform) is applied by the harness after
-- this file; the hand-made tenant is added after that (A's M1 expects 2 rows).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA auth;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  email_confirmed_at timestamptz
);

CREATE TABLE public.tenants (
  tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz DEFAULT now(),
  slug text UNIQUE,
  policy_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  branding jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  open_signup boolean NOT NULL DEFAULT false
);

CREATE TABLE public.tenant_settings (
  tenant_id uuid PRIMARY KEY,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  branding jsonb NOT NULL DEFAULT '{}'::jsonb,
  feature_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  integrations jsonb NOT NULL DEFAULT '{}'::jsonb,
  domains jsonb NOT NULL DEFAULT '{}'::jsonb,
  billing jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE public.tenant_settings ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.supported_locales (
  code text PRIMARY KEY,
  english_name text NOT NULL,
  informal_hint text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('ga', 'beta', 'draft', 'legacy')),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.supported_locales (code, english_name, status) VALUES
  ('de','German','ga'), ('en','English','ga'), ('es','Spanish','ga'), ('sr','Serbian','ga'), ('fr','French','ga'),
  ('ru','Russian','ga'), ('pl','Polish','ga'), ('pt','Portuguese','ga'), ('ar','Arabic','ga'), ('zh','Chinese','ga'),
  ('tr','Turkish','ga');

CREATE TABLE public.notification_type_controls (
  tenant_id uuid NOT NULL,
  type text NOT NULL,
  source_key text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT false,
  auto_registered boolean NOT NULL DEFAULT false,
  reason text,
  updated_by uuid,
  updated_by_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, type, source_key)
);

CREATE TABLE public.ai_provider_policies (
  tenant_id uuid NOT NULL,
  provider text NOT NULL,
  allowed boolean NOT NULL DEFAULT true,
  allowed_models text[] NOT NULL DEFAULT '{}'::text[],
  cost_cap_usd_month numeric NOT NULL DEFAULT 50,
  allowed_memory_categories text[] NOT NULL DEFAULT '{}'::text[],
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider)
);

CREATE TABLE public.app_users (user_id uuid PRIMARY KEY, email text, display_name text);

CREATE TABLE public.tenant_autopilot_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  max_recommendations_per_day integer NOT NULL DEFAULT 20,
  max_activations_per_day integer NOT NULL DEFAULT 10,
  allowed_domains text[] NOT NULL DEFAULT ARRAY['health','community','longevity','professional','general'],
  allowed_risk_levels text[] NOT NULL DEFAULT ARRAY['low','medium'],
  auto_activate_threshold numeric CHECK (auto_activate_threshold IS NULL OR (auto_activate_threshold >= 0 AND auto_activate_threshold <= 1)),
  recommendation_retention_days integer NOT NULL DEFAULT 30,
  generation_schedule jsonb NOT NULL DEFAULT '{"cron": "0 2 * * *", "timezone": "UTC"}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.app_users(user_id)
);

CREATE TABLE public.chat_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  created_by uuid,
  is_system boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.chat_group_members (
  group_id uuid NOT NULL REFERENCES public.chat_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'bot')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE public.tenant_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  email text NOT NULL,
  roles text[] NOT NULL DEFAULT ARRAY['community'],
  token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  invited_by uuid NOT NULL,
  message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at timestamptz,
  accepted_by uuid,
  revoked_at timestamptz,
  revoked_by uuid
);

CREATE TABLE public.service_bot_accounts (user_id uuid PRIMARY KEY, label text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.notification_test_actors (user_id uuid PRIMARY KEY, reason text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());

-- Member-facing tables provisioning must never write.
CREATE TABLE public.user_tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL,
  active_role text, is_primary boolean NOT NULL DEFAULT false, UNIQUE (tenant_id, user_id));
CREATE TABLE public.memberships (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, tenant_id uuid NOT NULL, status text NOT NULL DEFAULT 'active');
CREATE TABLE public.chat_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id uuid, tenant_id uuid, body text);
CREATE TABLE public.user_notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, tenant_id uuid, type text);
CREATE TABLE public.founding_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);

-- ── data ──────────────────────────────────────────────────────────────────
INSERT INTO public.tenants (tenant_id, name, slug, created_at, open_signup) VALUES
  ('2e7528b8-472a-4356-88da-0280d4639cce', 'Maxina',  'maxina',  '2025-08-30 16:27:07.760873+00', true),
  ('73cc592f-84ec-457a-b0f7-25a082d7e011', 'Alkalma', 'alkalma', '2025-08-30 16:27:07.760873+00', true);

INSERT INTO public.tenant_settings (tenant_id, profile, branding, feature_flags, domains) VALUES
  ('2e7528b8-472a-4356-88da-0280d4639cce',
   '{"name":"Maxina","description":"Maxina Longevity Community","support_email":"support@vitanaland.com"}',
   '{"brand_bg":"#FFF5F8","brand_fg":"#1a1a2e","brand_accent":"#FF7BAC"}',
   '{"jev":{"planes":["internal","system_autopilot","member"],"enabled":true,"monthly_budget_usd":50},"enable_autopilot":true,"enable_notifications":true}',
   '{"primary_domain":"vitanaland.com"}'),
  ('73cc592f-84ec-457a-b0f7-25a082d7e011', '{}', '{}',
   '{"jev":{"planes":["internal","system_autopilot","member"],"enabled":true,"monthly_budget_usd":10}}', '{}');

-- The 16 platform-baseline types (04674 ×13, 04926 ×2, 05055 ×1), seeded FROM tenants CROSS JOIN.
INSERT INTO public.notification_type_controls (tenant_id, type, enabled)
SELECT t.tenant_id, x.type, true
  FROM public.tenants t
 CROSS JOIN (VALUES ('admin_insight_urgent'), ('chat_mention'), ('comment_like'), ('comment_mention'), ('comment_reply'),
   ('community_post_published'), ('feature_announcement'), ('memory_garden_grew'), ('message_reaction'), ('new_chat_message'),
   ('new_follower'), ('partner_link_request'), ('post_comment'), ('post_like'), ('post_mention'), ('reminder_due')) AS x(type);
-- One alkalma admin switched a baseline type off: the new tenant still gets it ON (bool_or).
UPDATE public.notification_type_controls SET enabled = false
 WHERE tenant_id = '73cc592f-84ec-457a-b0f7-25a082d7e011' AND type = 'reminder_due';
-- Maxina-only local rows: 3 auto-registered OFF on first send, 2 enabled.
INSERT INTO public.notification_type_controls (tenant_id, type, enabled, auto_registered) VALUES
  ('2e7528b8-472a-4356-88da-0280d4639cce', 'live_room_ended_summary', false, true),
  ('2e7528b8-472a-4356-88da-0280d4639cce', 'recommendation_activated', false, true),
  ('2e7528b8-472a-4356-88da-0280d4639cce', 'someone_joined_live_room', false, true),
  ('2e7528b8-472a-4356-88da-0280d4639cce', 'live_room_invite', true, false),
  ('2e7528b8-472a-4356-88da-0280d4639cce', 'live_room_starting', true, false);

INSERT INTO public.ai_provider_policies (tenant_id, provider, allowed, allowed_models, cost_cap_usd_month)
SELECT t.tenant_id, p.provider, true, p.models, 50
  FROM public.tenants t
 CROSS JOIN (VALUES ('chatgpt', ARRAY['gpt-4o','gpt-4o-mini','gpt-4-turbo','o1-mini']),
                    ('claude',  ARRAY['model-a','model-b','model-c'])) AS p(provider, models);

INSERT INTO public.tenant_autopilot_settings (tenant_id) VALUES ('2e7528b8-472a-4356-88da-0280d4639cce');

INSERT INTO public.chat_groups (id, tenant_id, name, description, is_system, metadata) VALUES
  ('49d56b24-da5e-4579-afab-2593cda8efe5', '2e7528b8-472a-4356-88da-0280d4639cce', 'Alle Beisammen', 'Die Gruppe für alle', true,
   '{"cap":null,"seeded_by":"alle-beisammen"}');
INSERT INTO public.chat_group_members (group_id, user_id, tenant_id, role) VALUES
  ('49d56b24-da5e-4579-afab-2593cda8efe5', '00000000-0000-0000-0000-000000000001', '2e7528b8-472a-4356-88da-0280d4639cce', 'bot');

INSERT INTO auth.users (id, email, raw_app_meta_data, email_confirmed_at) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'exafy-admin@example.com', '{"exafy_admin":true}', now()),
  ('a0000000-0000-4000-8000-000000000002', 'plain@example.com', '{}', now()),
  ('a0000000-0000-4000-8000-000000000003', 'service-bot@example.com', '{}', now()),
  ('a0000000-0000-4000-8000-000000000004', 'test-actor@example.com', '{}', now());
INSERT INTO public.service_bot_accounts (user_id, label, reason) VALUES ('a0000000-0000-4000-8000-000000000003', 'bot', 'fixture');
INSERT INTO public.notification_test_actors (user_id, reason) VALUES ('a0000000-0000-4000-8000-000000000004', 'fixture');

-- Live: service_role holds every table privilege in public (and bypasses RLS).
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA auth TO service_role;
