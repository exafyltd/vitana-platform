-- VTID-05149 rollback R2: restore the two signup trigger functions exactly as
-- they were before M2 (bodies verbatim from functions-before.sql, captured
-- 2026-10-13). Pre-approved; rehearsed in scripts/ci/sql-tests/run-tenant-foundation-test.sh.
-- Order: revert the gateway first, then R2, then R1 (if needed). R3 is independent.
-- Run as postgres through RUN-MIGRATION.yml (workflow_dispatch).

BEGIN;
SET LOCAL lock_timeout = '3s';

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
        LIMIT 1;
    END IF;

    -- Fallback: oldest tenant
    IF v_tenant_id IS NULL THEN
        SELECT t.tenant_id INTO v_tenant_id
        FROM public.tenants t
        ORDER BY t.created_at ASC
        LIMIT 1;
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
BEGIN
  IF md5(pg_get_functiondef('public.handle_new_user()'::regprocedure)) <> '9599cfbfa7d9f8532ea1564df99e430f'
     OR md5(pg_get_functiondef('public.provision_platform_user()'::regprocedure)) <> '6254e35b2765d8edd5976ec5b9eec4f3' THEN
    RAISE EXCEPTION 'VTID-05149 R2: the restored definitions do not match the captured md5s';
  END IF;
END $check$;

COMMIT;
