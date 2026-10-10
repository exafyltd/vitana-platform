-- VTID-05023 part 4 test fixture for the "supabase" throwaway database: a
-- stub auth.users and the six provisioning triggers exactly as they run on
-- Supabase today. Function bodies are copied verbatim from the latest
-- migration of each (sources below); the test inserts the same users here and
-- calls ensure_provisioned() on the "aurora" database, then diffs the rows.
--   handle_new_user               vitana-v1 20260503000100_vitana_id_v2_generator.sql:142
--   generate_maxina_discount_code vitana-v1 20260210141933_0d5c2768-22f0-40bb-9c45-a621094bb458.sql:52
--   initialize_user_preferences   vitana-v1 20251013135605_0859f836-d45a-4fb4-85db-6b9764711a62.sql:45
--   provision_wallet_accounts     vitana-platform 20260529000000_VTID_03200_wallet_stripe_deposits.sql:210
--   provision_platform_user       vitana-platform 20260318100000_role_admission_system.sql:200
--   initialize_user_journey       vitana-v1 20251012161057_74d3b565-ad05-4b47-a106-5a62c60edf36.sql:126

CREATE SCHEMA auth;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb, raw_app_meta_data jsonb,
  created_at timestamptz DEFAULT now(), email_confirmed_at timestamptz);

-- memberships.role is the tenant_role enum on Supabase (text on Aurora after DMS).
CREATE TYPE public.tenant_role AS ENUM ('community', 'patient', 'professional', 'staff', 'admin');
ALTER TABLE public.memberships ALTER COLUMN role DROP DEFAULT;
ALTER TABLE public.memberships ALTER COLUMN role TYPE public.tenant_role USING role::public.tenant_role;
ALTER TABLE public.memberships ALTER COLUMN role SET DEFAULT 'community';

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_slug    text;
  v_tenant_id      uuid;
  v_full_name      text;
  v_display_name   text;
  v_email          text;
  v_vitana_id      text;
  v_seq            bigint;
BEGIN
  v_tenant_slug  := NEW.raw_user_meta_data ->> 'tenant_slug';
  v_full_name    := NEW.raw_user_meta_data ->> 'full_name';
  v_email        := NEW.email;
  v_display_name := COALESCE(
    NEW.raw_user_meta_data ->> 'display_name',
    v_full_name,
    split_part(v_email, '@', 1)
  );

  SELECT a.vitana_id, a.registration_seq
    INTO v_vitana_id, v_seq
    FROM public.allocate_vitana_id(v_display_name, v_full_name, v_email) a;

  INSERT INTO public.profiles (
    user_id, full_name, display_name, handle, email,
    vitana_id, vitana_id_locked, registration_seq
  ) VALUES (
    NEW.id,
    v_full_name,
    v_display_name,
    v_vitana_id,
    v_email,
    v_vitana_id,
    false,
    v_seq
  );

  INSERT INTO public.global_community_profiles (user_id, display_name, is_visible)
  VALUES (NEW.id, v_display_name, true)
  ON CONFLICT (user_id) DO NOTHING;

  IF v_tenant_slug IS NOT NULL THEN
    SELECT t.tenant_id INTO v_tenant_id
      FROM public.tenants t
     WHERE t.slug = v_tenant_slug
     LIMIT 1;
  END IF;

  IF v_tenant_id IS NULL THEN
    SELECT t.tenant_id INTO v_tenant_id
      FROM public.tenants t
     ORDER BY t.created_at ASC
     LIMIT 1;
  END IF;

  IF v_tenant_id IS NOT NULL THEN
    INSERT INTO public.memberships (user_id, tenant_id, role, status)
    VALUES (NEW.id, v_tenant_id, 'community'::public.tenant_role, 'active');

    INSERT INTO public.role_preferences (user_id, tenant_id, role)
    VALUES (NEW.id, v_tenant_id, 'community');

    UPDATE auth.users
       SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                            || jsonb_build_object('active_tenant_id', v_tenant_id)
     WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.generate_maxina_discount_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_slug text;
  v_code text;
  v_attempts integer := 0;
BEGIN
  v_tenant_slug := NEW.raw_user_meta_data ->> 'tenant_slug';

  IF v_tenant_slug = 'maxina' THEN
    LOOP
      v_code := generate_discount_code('MAXINA');
      BEGIN
        INSERT INTO public.user_discount_codes (user_id, code, discount_percent, valid_for, tenant_slug)
        VALUES (NEW.id, v_code, 10, 'events', 'maxina');
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        v_attempts := v_attempts + 1;
        IF v_attempts > 5 THEN
          RAISE EXCEPTION 'Could not generate unique discount code after 5 attempts';
        END IF;
      END;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.initialize_user_preferences()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_preferences (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.provision_wallet_accounts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.wallet_accounts (user_id, currency)
  VALUES (NEW.id, 'EUR'), (NEW.id, 'USD')
  ON CONFLICT (user_id, currency) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.provision_platform_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_slug TEXT;
    v_tenant_id UUID;
    v_display_name TEXT;
    v_email TEXT;
BEGIN
    v_email := NEW.email;
    v_tenant_slug := NEW.raw_user_meta_data ->> 'tenant_slug';

    v_display_name := COALESCE(
        NEW.raw_user_meta_data ->> 'display_name',
        NEW.raw_user_meta_data ->> 'full_name',
        split_part(v_email, '@', 1)
    );

    IF v_tenant_slug IS NOT NULL THEN
        SELECT t.tenant_id INTO v_tenant_id
        FROM public.tenants t
        WHERE t.slug = v_tenant_slug
        LIMIT 1;
    END IF;

    IF v_tenant_id IS NULL THEN
        SELECT t.tenant_id INTO v_tenant_id
        FROM public.tenants t
        ORDER BY t.created_at ASC
        LIMIT 1;
    END IF;

    INSERT INTO public.app_users (user_id, email, display_name, tenant_id)
    VALUES (NEW.id, v_email, v_display_name, v_tenant_id)
    ON CONFLICT (user_id) DO UPDATE SET
        email = EXCLUDED.email,
        display_name = COALESCE(EXCLUDED.display_name, public.app_users.display_name),
        tenant_id = COALESCE(EXCLUDED.tenant_id, public.app_users.tenant_id),
        updated_at = NOW();

    IF v_tenant_id IS NOT NULL THEN
        INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
        VALUES (v_tenant_id, NEW.id, 'community', true)
        ON CONFLICT (tenant_id, user_id) DO NOTHING;

        INSERT INTO public.user_permitted_roles (user_id, tenant_id, role, granted_by)
        VALUES (NEW.id, v_tenant_id, 'community', NULL)
        ON CONFLICT (user_id, tenant_id, role) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.initialize_user_journey()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_journey (user_id, onboarding_stage, experience_level, engagement_score, days_active)
  VALUES (NEW.id, 'new', 'beginner', 0, 0)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
CREATE TRIGGER on_auth_user_created_generate_discount AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.generate_maxina_discount_code();
CREATE TRIGGER on_auth_user_created_preferences AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.initialize_user_preferences();
CREATE TRIGGER on_auth_user_created_wallet AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.provision_wallet_accounts();
CREATE TRIGGER on_auth_user_platform_provision AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.provision_platform_user();
CREATE TRIGGER on_user_journey_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.initialize_user_journey();
