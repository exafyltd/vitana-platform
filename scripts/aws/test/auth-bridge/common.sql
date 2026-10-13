-- VTID-05023 part 4 test fixture, loaded into BOTH throwaway databases
-- ("supabase" and "aurora"): the live shape of the tables the six auth.users
-- provisioning triggers write, reduced to the columns those triggers touch
-- (plus ids/defaults), with the unique constraints their ON CONFLICT clauses
-- need. Never applied to a real project.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN CREATE ROLE authenticator NOLOGIN NOINHERIT; END IF;
END $$;
GRANT anon, authenticated, service_role TO authenticator;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Aurora's default privileges (setup-aurora-postgrest-grants.sh): API roles
-- get everything on new tables and functions; RLS restricts them.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE public.tenants (tenant_id uuid PRIMARY KEY, slug text UNIQUE, created_at timestamptz NOT NULL);
INSERT INTO public.tenants VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'vitana', '2025-01-01'),
  ('00000000-0000-0000-0000-0000000000a2', 'maxina', '2025-06-01'),
  ('00000000-0000-0000-0000-0000000000a3', 'alkalma', '2025-07-01');

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  full_name text, display_name text, handle text, email text,
  vitana_id text, vitana_id_locked boolean, registration_seq bigint,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.handle_aliases (old_handle text PRIMARY KEY);
CREATE SEQUENCE public.vitana_id_seq;

-- Deterministic stand-in for allocate_vitana_id() (same signature/columns);
-- identical in both databases, so both sides allocate the same values.
CREATE FUNCTION public.allocate_vitana_id(p_display_name text, p_full_name text, p_email text)
RETURNS TABLE (vitana_id text, registration_seq bigint) LANGUAGE plpgsql AS $$
DECLARE seq bigint;
BEGIN
  seq := nextval('public.vitana_id_seq');
  vitana_id := lower(regexp_replace(coalesce(p_display_name, p_full_name, split_part(p_email, '@', 1), 'user'), '[^a-zA-Z]', '', 'g')) || seq::text;
  registration_seq := seq;
  RETURN NEXT;
END $$;

CREATE TABLE public.global_community_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  display_name text, is_visible boolean NOT NULL DEFAULT true);

CREATE TABLE public.memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, tenant_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'community', status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, tenant_id));
CREATE TABLE public.role_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, tenant_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('community','patient','professional','staff','admin')),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, tenant_id));

CREATE TABLE public.user_discount_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, code text NOT NULL UNIQUE,
  discount_percent integer NOT NULL DEFAULT 10, valid_for text NOT NULL DEFAULT 'events',
  tenant_slug text NOT NULL DEFAULT 'maxina', expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
-- Verbatim from vitana-v1 20260210141933 (the helper the trigger calls).
CREATE OR REPLACE FUNCTION public.generate_discount_code(prefix text DEFAULT 'MAXINA')
RETURNS text LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  chars text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  result text := prefix || '-';
  i integer;
BEGIN
  FOR i IN 1..6 LOOP
    result := result || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
  END LOOP;
  RETURN result;
END;
$$;

CREATE TABLE public.user_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  theme text NOT NULL DEFAULT 'system', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, currency text NOT NULL,
  balance_cents bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, currency));
CREATE TABLE public.app_users (
  user_id uuid PRIMARY KEY, email text UNIQUE NOT NULL, display_name text, tenant_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.user_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL,
  active_role text NOT NULL DEFAULT 'community', is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, user_id));
CREATE TABLE public.user_permitted_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, tenant_id uuid NOT NULL,
  role text NOT NULL, granted_by uuid, granted_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, tenant_id, role));
CREATE TABLE public.user_journey (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  onboarding_stage text NOT NULL DEFAULT 'new', experience_level text NOT NULL DEFAULT 'beginner',
  engagement_score integer NOT NULL DEFAULT 0, days_active integer NOT NULL DEFAULT 0,
  milestones jsonb DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.service_bot_accounts (user_id uuid PRIMARY KEY, label text NOT NULL, reason text NOT NULL);
CREATE TABLE public.notification_test_actors (user_id uuid PRIMARY KEY, reason text NOT NULL DEFAULT '');
