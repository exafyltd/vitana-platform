-- VTID-04859 test fixture: the live shape (2026-10-03) of the tables the
-- Founding 1000 migration reads and writes, with six members covering every
-- branch. Used by scripts/ci/test-vtid-04859-founding.sh on a throwaway local
-- Postgres; never against a real project.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, created_at timestamptz DEFAULT now());

CREATE TABLE public.user_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid, user_id uuid, active_role text, is_primary boolean,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.app_users (user_id uuid PRIMARY KEY, tenant_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE public.user_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid, user_id uuid, plan_key text, price_key text,
  status text CHECK (status = ANY (ARRAY['trialing','active','past_due','unpaid','canceled','incomplete','incomplete_expired','paused','free'])),
  stripe_customer_id text, stripe_subscription_id text UNIQUE,
  current_period_start timestamptz, current_period_end timestamptz,
  cancel_at_period_end boolean DEFAULT false, trial_end timestamptz, last_payment_error text,
  metadata jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE TABLE public.paywall_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, user_id uuid, feature_key text,
  action text CHECK (action = ANY (ARRAY['shown','upgraded','rejected','credit_paid','deferred_for_vulnerability','degraded','redeemed','soft_counter_reached'])),
  current_plan text, context jsonb, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.redemption_codes (
  code text PRIMARY KEY, campaign text, max_uses int, uses_count int DEFAULT 0, is_active boolean DEFAULT true,
  grants_plan text, grant_duration_days int, metadata jsonb, expires_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), created_by uuid
);
INSERT INTO public.redemption_codes (code, campaign, max_uses, grants_plan, grant_duration_days, metadata)
VALUES ('FOUNDING', 'founding_500', 500, 'premium', 90, '{"visibility":"public"}');
CREATE TABLE public.service_bot_accounts (user_id uuid PRIMARY KEY, label text, reason text, created_at timestamptz DEFAULT now());
CREATE TABLE public.notification_test_actors (user_id uuid PRIMARY KEY, reason text, created_at timestamptz DEFAULT now());

\set t '''aaaaaaaa-0000-0000-0000-000000000000'''
-- u1 launch grant · u2 no subscription · u3 paying (Stripe) · u4 service bot
-- u5 test actor · u6 redemption grant ending in 30 days · u7 e2e address not
-- in any allowlist. Signup order u1..u7.
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'one@example.com'),
  ('00000000-0000-0000-0000-0000000000a2', 'two@example.com'),
  ('00000000-0000-0000-0000-0000000000a7', 'e2e-1776584475@vitanatest.exafy.io');
INSERT INTO public.app_users (user_id, tenant_id, created_at) VALUES
  ('00000000-0000-0000-0000-0000000000a7', :t, now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000000a1', :t, now() - interval '200 days'),
  ('00000000-0000-0000-0000-0000000000a2', :t, now() - interval '150 days'),
  ('00000000-0000-0000-0000-0000000000a3', :t, now() - interval '120 days'),
  ('00000000-0000-0000-0000-0000000000a4', :t, now() - interval '110 days'),
  ('00000000-0000-0000-0000-0000000000a5', :t, now() - interval '100 days'),
  ('00000000-0000-0000-0000-0000000000a6', :t, now() - interval '50 days');
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary)
SELECT :t, user_id, true FROM public.app_users;
INSERT INTO public.service_bot_accounts (user_id, label) VALUES ('00000000-0000-0000-0000-0000000000a4', 'bot');
INSERT INTO public.notification_test_actors (user_id, reason) VALUES ('00000000-0000-0000-0000-0000000000a5', 'e2e');
INSERT INTO public.user_subscriptions (tenant_id, user_id, plan_key, status, current_period_start, current_period_end, metadata, stripe_subscription_id) VALUES
  (:t, '00000000-0000-0000-0000-0000000000a1', 'premium', 'active', now() - interval '125 days', now() + interval '240 days', '{"source":"launch_auto_grant_2026"}', NULL),
  (:t, '00000000-0000-0000-0000-0000000000a3', 'premium', 'active', now() - interval '10 days', now() + interval '20 days', '{"source":"stripe"}', 'sub_live_1'),
  (:t, '00000000-0000-0000-0000-0000000000a6', 'premium', 'active', now() - interval '60 days', now() + interval '30 days', '{"source":"redemption"}', NULL);

-- Live grants: the platform (service_role) reads and writes all of these.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
