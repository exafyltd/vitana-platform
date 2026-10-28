-- VTID-05149 (multi-tenant M0, lane A) M2: signup lands in the default tenant.
--
-- handle_new_user() (trigger on_auth_user_created) and provision_platform_user()
-- (trigger on_auth_user_platform_provision) each resolved the signup tenant as
--   1. raw_user_meta_data->>'tenant_slug', for ANY tenant slug, else
--   2. the oldest tenant: ORDER BY created_at ASC LIMIT 1.
-- maxina and alkalma share the same created_at, so (2) was decided by physical
-- row order, and (1) let a client-supplied slug enrol a new member into a
-- tenant that is closed for signup (VTID-05043 restricted that only for
-- switch_to_tenant_by_slug).
--
-- Both functions are re-created from their live bodies (captured verbatim in
-- docs/validation/VTID-05149/functions-before.sql) with exactly these changes:
--   (a) the slug lookup also requires open_signup AND is_active AND NOT is_platform
--       (the switch_to_tenant_by_slug rule);
--   (b) the fallback is the tenant with is_default (M1), not the oldest one;
--   (c) no tenant at all → RAISE WARNING and RETURN NEW: never an exception, so a
--       broken default cannot block auth.users inserts (every signup).
--       provision_platform_user returns before its app_users insert, which
--       could not succeed anyway (app_users.tenant_id is NOT NULL).
-- Column lists, ON CONFLICT clauses, is_primary = true, the memberships /
-- role_preferences / app_metadata writes and SET search_path are unchanged, so
-- the four user_tenants side-effect triggers see the same inserts as before.
--
-- definer-public: trigger functions; Postgres refuses to call a trigger function
-- directly, and CREATE OR REPLACE keeps the live ACL. Changing their grants is
-- outside a byte-identical signup change.
--
-- Drift guard: the live definitions must still have the md5s captured on
-- 2026-10-13. If they do not, this aborts and changes nothing. Never edit the
-- guard at apply time: re-read both live definitions, rebuild this file and
-- rollback-m2.sql from them, re-run the harness and ship that as a follow-up PR
-- under VTID-05149.
-- Requires M1 (20261014000100). Rollback: docs/validation/VTID-05149/rollback-m2.sql.

BEGIN;
SET LOCAL lock_timeout = '3s';

DO $guard$
DECLARE
  v_defaults int;
BEGIN
  IF md5(pg_get_functiondef('public.handle_new_user()'::regprocedure)) <> '9599cfbfa7d9f8532ea1564df99e430f' THEN
    RAISE EXCEPTION 'VTID-05149 M2: public.handle_new_user() drifted from the captured definition; re-read it and rebuild M2';
  END IF;
  IF md5(pg_get_functiondef('public.provision_platform_user()'::regprocedure)) <> '6254e35b2765d8edd5976ec5b9eec4f3' THEN
    RAISE EXCEPTION 'VTID-05149 M2: public.provision_platform_user() drifted from the captured definition; re-read it and rebuild M2';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'is_default'
  ) THEN
    RAISE EXCEPTION 'VTID-05149 M2: tenants.is_default is missing; apply M1 (20261014000100) first';
  END IF;
  EXECUTE 'SELECT count(*) FROM public.tenants WHERE is_default' INTO v_defaults;
  IF v_defaults <> 1 THEN
    RAISE EXCEPTION 'VTID-05149 M2: expected exactly one default tenant, found %', v_defaults;
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Allocate vitana_id + seq from the new helper. seq is the user's
  -- registration rank and is also written to profiles.registration_seq.
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
       AND t.open_signup AND t.is_active AND NOT t.is_platform
     LIMIT 1;
  END IF;

  IF v_tenant_id IS NULL THEN
    SELECT t.tenant_id INTO v_tenant_id
      FROM public.tenants t
     WHERE t.is_default
     LIMIT 1;
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE WARNING 'VTID-05149: no default tenant for %', NEW.id;
    RETURN NEW;
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
$function$;

CREATE OR REPLACE FUNCTION public.provision_platform_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant_slug TEXT;
    v_tenant_id UUID;
    v_display_name TEXT;
    v_email TEXT;
BEGIN
    v_email := NEW.email;
    v_tenant_slug := NEW.raw_user_meta_data ->> 'tenant_slug';

    -- Derive display name
    v_display_name := COALESCE(
        NEW.raw_user_meta_data ->> 'display_name',
        NEW.raw_user_meta_data ->> 'full_name',
        split_part(v_email, '@', 1)
    );

    -- Resolve tenant by slug
    IF v_tenant_slug IS NOT NULL THEN
        SELECT t.tenant_id INTO v_tenant_id
        FROM public.tenants t
        WHERE t.slug = v_tenant_slug
          AND t.open_signup AND t.is_active AND NOT t.is_platform
        LIMIT 1;
    END IF;

    -- Fallback: the default tenant (VTID-05149)
    IF v_tenant_id IS NULL THEN
        SELECT t.tenant_id INTO v_tenant_id
        FROM public.tenants t
        WHERE t.is_default
        LIMIT 1;
    END IF;

    IF v_tenant_id IS NULL THEN
        RAISE WARNING 'VTID-05149: no default tenant for %', NEW.id;
        RETURN NEW;
    END IF;

    -- Create app_users row (the backend user registry)
    INSERT INTO public.app_users (user_id, email, display_name, tenant_id)
    VALUES (NEW.id, v_email, v_display_name, v_tenant_id)
    ON CONFLICT (user_id) DO UPDATE SET
        email = EXCLUDED.email,
        display_name = COALESCE(EXCLUDED.display_name, public.app_users.display_name),
        tenant_id = COALESCE(EXCLUDED.tenant_id, public.app_users.tenant_id),
        updated_at = NOW();

    -- Create user_tenants row (is_primary=true triggers live room creation)
    IF v_tenant_id IS NOT NULL THEN
        INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
        VALUES (v_tenant_id, NEW.id, 'community', true)
        ON CONFLICT (tenant_id, user_id) DO NOTHING;

        -- VTID-01230: Grant default 'community' role permission
        INSERT INTO public.user_permitted_roles (user_id, tenant_id, role, granted_by)
        VALUES (NEW.id, v_tenant_id, 'community', NULL)
        ON CONFLICT (user_id, tenant_id, role) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$function$;

DO $check$
DECLARE
  v_fn text;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.handle_new_user()', 'public.provision_platform_user()'] LOOP
    v_def := pg_get_functiondef(v_fn::regprocedure);
    IF position('is_default' IN v_def) = 0 OR position('open_signup' IN v_def) = 0 THEN
      RAISE EXCEPTION 'VTID-05149 M2: % does not use is_default/open_signup after the change', v_fn;
    END IF;
    IF position('created_at ASC' IN v_def) > 0 THEN
      RAISE EXCEPTION 'VTID-05149 M2: % still falls back to the oldest tenant', v_fn;
    END IF;
  END LOOP;
END $check$;

COMMIT;
