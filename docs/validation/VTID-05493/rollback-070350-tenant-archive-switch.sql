-- VTID-05493 rollback for 20261102070350_vtid_05493_mt_tenant_archive_switch.sql. Run BEFORE rollback-070300.
-- 1. restores the VTID-05043 switch_to_tenant_by_slug body (20261010180200) and its grants;
-- 2. gives archived tenants back the is_active they had at apply (bak_vtid_05493_tenant_lifecycle); a tenant created
--    after apply is left as it is;
-- 3. drops archive_tenant(text) and tenants.archived_at.
-- Note: a tenant that was deactivated (not archived) stays deactivated here; rollback-070300 restores it.
-- Re-appliable: every statement is idempotent.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.switch_to_tenant_by_slug(p_tenant_slug text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  tenant_record RECORD;
  v_is_member boolean;
  v_is_exafy boolean;
  v_rows int;
  v_created int := 0;
  v_switched int := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT t.tenant_id, t.open_signup INTO tenant_record
    FROM public.tenants t
   WHERE t.slug = p_tenant_slug;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tenant not found: %', p_tenant_slug;
  END IF;

  v_is_member := EXISTS (
    SELECT 1 FROM public.user_tenants ut
     WHERE ut.tenant_id = tenant_record.tenant_id AND ut.user_id = v_uid
  );

  SELECT coalesce(u.raw_app_meta_data->>'exafy_admin' = 'true', false) INTO v_is_exafy
    FROM auth.users u
   WHERE u.id = v_uid;
  v_is_exafy := coalesce(v_is_exafy, false);

  IF v_is_member OR v_is_exafy THEN
    NULL; -- switch only
  ELSIF tenant_record.open_signup THEN
    INSERT INTO public.memberships (user_id, tenant_id, role, status)
    VALUES (v_uid, tenant_record.tenant_id, 'community'::public.tenant_role, 'active')
    ON CONFLICT (user_id, tenant_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_created := v_created + v_rows;

    IF v_rows > 0 THEN
      -- Set role preference to community (no self-assignment)
      INSERT INTO public.role_preferences (user_id, tenant_id, role)
      VALUES (v_uid, tenant_record.tenant_id, 'community')
      ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = 'community';
    END IF;

    INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
    VALUES (
      tenant_record.tenant_id,
      v_uid,
      'community',
      NOT EXISTS (SELECT 1 FROM public.user_tenants p WHERE p.user_id = v_uid AND p.is_primary)
    )
    ON CONFLICT (tenant_id, user_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_created := v_created + v_rows;
  ELSE
    RAISE EXCEPTION 'TENANT_NOT_JOINABLE' USING ERRCODE = '42501';
  END IF;

  -- Update active tenant in user metadata, only when it changes
  UPDATE auth.users
     SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) ||
           jsonb_build_object('active_tenant_id', tenant_record.tenant_id)
   WHERE id = v_uid
     AND raw_app_meta_data->>'active_tenant_id' IS DISTINCT FROM tenant_record.tenant_id::text;
  GET DIAGNOSTICS v_switched = ROW_COUNT;

  -- Log the tenant switch for audit purposes, only on a real change
  IF v_switched > 0 OR v_created > 0 THEN
    INSERT INTO public.audit_events (user_id, tenant_id, event_type, event_data)
    VALUES (
      v_uid,
      tenant_record.tenant_id,
      'tenant_switch',
      jsonb_build_object('tenant_slug', p_tenant_slug, 'timestamp', now())
    );
  END IF;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.switch_to_tenant_by_slug(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.switch_to_tenant_by_slug(text) TO authenticated;

DO $restore$
BEGIN
  IF to_regclass('public.bak_vtid_05493_tenant_lifecycle') IS NULL THEN
    RAISE EXCEPTION 'VTID-05493 rollback: snapshot table is missing - restore is_active by hand from live-before.sql';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'archived_at') THEN
    UPDATE public.tenants t
       SET is_active = b.is_active
      FROM public.bak_vtid_05493_tenant_lifecycle b
     WHERE b.tenant_id = t.tenant_id AND t.archived_at IS NOT NULL AND t.is_active IS DISTINCT FROM b.is_active;
  END IF;
END
$restore$;

DROP FUNCTION IF EXISTS public.archive_tenant(text);
DO $drop$
DECLARE
  v_try int := 0;
BEGIN
  LOOP
    v_try := v_try + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';
      ALTER TABLE public.tenants DROP COLUMN IF EXISTS archived_at;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF v_try >= 5 THEN RAISE; END IF;
      PERFORM pg_sleep(v_try);
    END;
  END LOOP;
END
$drop$;

COMMIT;
