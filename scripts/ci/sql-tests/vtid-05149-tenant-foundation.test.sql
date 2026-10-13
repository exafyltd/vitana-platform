-- VTID-05149: fixture for the tenant-foundation harness. Loaded into a fresh
-- throwaway database per case by run-tenant-foundation-test.sh, which holds the
-- cases and assertions. Never run against a shared or production database.
--
-- Supabase shapes the signup triggers write to, with the live columns they use,
-- the live unique keys/FKs, the real membership_side_effects_suppressed(), and
-- the four user_tenants AFTER INSERT side-effect triggers (live names, live WHEN
-- clause) bound to stubs that log (trigger, user_id, tenant_id) in firing order.
-- The tenants rows are NOT created here: each case inserts them in the physical
-- order it needs.
\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text,
  raw_user_meta_data jsonb,
  raw_app_meta_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE public.tenant_role AS ENUM
  ('community', 'patient', 'professional', 'reseller', 'staff', 'admin', 'backoffice', 'developer', 'infra');

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

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  full_name text,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  tenant_id uuid,
  display_name text,
  handle text,
  vitana_id text NOT NULL,
  vitana_id_locked boolean NOT NULL DEFAULT false,
  registration_seq bigint
);

CREATE TABLE public.global_community_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  display_name text,
  is_visible boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  role public.tenant_role NOT NULL DEFAULT 'community',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'pending')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id)
);

CREATE TABLE public.role_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  role text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id)
);

CREATE TABLE public.app_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  email text UNIQUE,
  display_name text,
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE public.user_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  active_role text NOT NULL DEFAULT 'community',
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE public.user_permitted_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  role text NOT NULL,
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id, role)
);

-- Stub: deterministic vitana_id + registration_seq per database.
CREATE SEQUENCE public.vitana_id_seq;
CREATE FUNCTION public.allocate_vitana_id(p_display_name text, p_full_name text, p_email text)
RETURNS TABLE (vitana_id text, registration_seq bigint)
LANGUAGE plpgsql AS $$
DECLARE v bigint := nextval('public.vitana_id_seq');
BEGIN
  RETURN QUERY SELECT '@' || coalesce(p_display_name, 'user') || v::text, v;
END $$;

-- Real (live definition, VTID-05043).
CREATE FUNCTION public.membership_side_effects_suppressed()
RETURNS boolean LANGUAGE sql STABLE AS $function$
  SELECT coalesce(current_setting('vitana.suppress_membership_side_effects', true), '') = 'on'
$function$;

CREATE TABLE public.side_effect_log (
  seq serial PRIMARY KEY,
  trigger_name text NOT NULL,
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL
);
CREATE FUNCTION public.log_side_effect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.side_effect_log (trigger_name, user_id, tenant_id) VALUES (TG_NAME, NEW.user_id, NEW.tenant_id);
  RETURN NULL;
END $$;
CREATE TRIGGER founding_seat_on_primary_membership AFTER INSERT ON public.user_tenants FOR EACH ROW
  WHEN (((new.is_primary = true) AND (NOT public.membership_side_effects_suppressed()))) EXECUTE FUNCTION public.log_side_effect();
CREATE TRIGGER seed_onboarding_autopilot_on_primary_membership AFTER INSERT ON public.user_tenants FOR EACH ROW
  WHEN (((new.is_primary = true) AND (NOT public.membership_side_effects_suppressed()))) EXECUTE FUNCTION public.log_side_effect();
CREATE TRIGGER trg_create_user_live_room AFTER INSERT ON public.user_tenants FOR EACH ROW
  WHEN (((new.is_primary = true) AND (NOT public.membership_side_effects_suppressed()))) EXECUTE FUNCTION public.log_side_effect();
CREATE TRIGGER welcome_chat_on_primary_membership AFTER INSERT ON public.user_tenants FOR EACH ROW
  WHEN (((new.is_primary = true) AND (NOT public.membership_side_effects_suppressed()))) EXECUTE FUNCTION public.log_side_effect();

-- Placeholders so the live trigger names on auth.users exist from the start;
-- functions-before.sql (or M2) replaces the bodies. Trigger order is by name,
-- as live: on_auth_user_created (handle_new_user) fires before
-- on_auth_user_platform_provision (provision_platform_user).
CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION public.provision_platform_user() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
CREATE TRIGGER on_auth_user_platform_provision AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.provision_platform_user();

-- Members can read tenants as on the live project (RLS open for this harness).
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON public.tenants TO anon, authenticated, service_role;
