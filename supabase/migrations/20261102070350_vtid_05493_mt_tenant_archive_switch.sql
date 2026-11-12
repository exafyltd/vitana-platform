-- VTID-05493 (mt-tenant-admin-r2 / tenant-lifecycle-db, L2): archive_tenant(slug) and the closing switch change.
--
-- 1. tenants.archived_at timestamptz NULL (expand only: nullable, no default, metadata-only change).
-- 2. archive_tenant(slug): sets is_active = false and archived_at = now() (kept if already set). Idempotent; the same
--    guards and return shape as deactivate_tenant (INVALID_SLUG, TENANT_NOT_FOUND, DEFAULT_TENANT_PROTECTED,
--    PLATFORM_TENANT_PROTECTED). An already-deactivated tenant can be archived. service_role only.
-- 3. switch_to_tenant_by_slug(): CO-OWNED with exafyltd/vitana-v1 (see 20261010180200_vtid_05043_...; a vitana-v1 Vitest
--    guard fails if a body lacks the open_signup check, so this body keeps it). The body is the VTID-05043 one plus one
--    rule: when the requested tenant is not active (deactivated or archived),
--      * an exafy_admin still switches to it (the console must keep reading it);
--      * a member does not get a hard lockout: the call resolves to the default tenant (tenants.is_default and active)
--        and the rest of the function runs against that tenant (a member of it switches; anyone else joins only if it is
--        open_signup, else TENANT_NOT_JOINABLE as before). Their membership rows in the deactivated tenant are untouched;
--      * a non-member cannot reach a deactivated tenant (TENANT_NOT_JOINABLE).
--    No active default tenant -> NO_DEFAULT_TENANT (P0001); VTID-05149 guarantees exactly one default.
--    The audit row names the tenant actually entered plus requested_slug and fallback:true when the fallback was used.
--    Write-free steady state is preserved (a repeat call writes nothing).
--    Not changed here: current_tenant_id() (used by about 50 RLS policies). The claim the gateway reads is set by this
--    function, so the switch is the resolution point named in the spec; widening to the helper is a separate decision.
--
-- Depends on: 20261102070300 (snapshot table + deactivate_tenant) and 20261010180200 (VTID-05043 switch body).
-- Rollback: docs/validation/VTID-05493/rollback-070350-tenant-archive-switch.sql (restores the VTID-05043 body and grants,
-- restores is_active of archived tenants from the snapshot, drops archive_tenant and archived_at).
-- Apply: owner approval of the file and the target database first (collaboration.md section 7d); one RUN-MIGRATION dispatch.

-- impact-allow-solo-migration: lands dark; the gateway routes ship in the tenant-admin-api lane after this is applied.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
BEGIN
  IF to_regprocedure('public.deactivate_tenant(text)') IS NULL
     OR to_regclass('public.bak_vtid_05493_tenant_lifecycle') IS NULL THEN
    RAISE EXCEPTION 'VTID-05493: apply 20261102070300_vtid_05493_mt_tenant_deactivate first';
  END IF;
  IF pg_get_functiondef('public.switch_to_tenant_by_slug(text)'::regprocedure) NOT LIKE '%open_signup%' THEN
    RAISE EXCEPTION 'VTID-05493: switch_to_tenant_by_slug lacks the VTID-05043 open_signup rule - apply 20261010180200 first';
  END IF;
END
$guard$;

-- The ALTER takes ACCESS EXCLUSIVE on tenants: short lock_timeout, retried with back-off, never a long wait.
DO $mig$
DECLARE
  v_try int := 0;
BEGIN
  LOOP
    v_try := v_try + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';
      ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS archived_at timestamptz;
      COMMENT ON COLUMN public.tenants.archived_at IS 'VTID-05493: set by archive_tenant(); an archived tenant is also is_active=false.';
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF v_try >= 5 THEN RAISE; END IF;
      RAISE NOTICE 'VTID-05493 L2: lock timeout, retry % of 5', v_try;
      PERFORM pg_sleep(v_try);
    END;
  END LOOP;
END
$mig$;

CREATE OR REPLACE FUNCTION public.archive_tenant(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_t    record;
  v_rows int;
BEGIN
  IF v_slug = '' THEN
    RAISE EXCEPTION 'INVALID_SLUG' USING ERRCODE = '22023';
  END IF;

  SELECT t.tenant_id, t.slug, t.is_default, t.is_platform INTO v_t
    FROM public.tenants t WHERE t.slug = v_slug FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TENANT_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF v_t.is_default THEN
    RAISE EXCEPTION 'DEFAULT_TENANT_PROTECTED' USING ERRCODE = '22023';
  END IF;
  IF v_t.is_platform THEN
    RAISE EXCEPTION 'PLATFORM_TENANT_PROTECTED' USING ERRCODE = '22023';
  END IF;

  UPDATE public.tenants
     SET is_active = false, archived_at = coalesce(archived_at, now())
   WHERE tenant_id = v_t.tenant_id AND (is_active OR archived_at IS NULL);
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RETURN jsonb_build_object('tenant_id', v_t.tenant_id, 'slug', v_t.slug, 'changed', v_rows > 0);
END;
$fn$;

COMMENT ON FUNCTION public.archive_tenant(text) IS
  'VTID-05493: sets tenants.is_active=false and archived_at (idempotent). Refuses the default and platform tenants. service_role only.';
REVOKE ALL ON FUNCTION public.archive_tenant(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_tenant(text) TO service_role;

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
  v_fallback boolean := false;
  v_rows int;
  v_created int := 0;
  v_switched int := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT t.tenant_id, t.slug, t.open_signup, coalesce(t.is_active, true) AS is_active INTO tenant_record
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

  -- VTID-05493: a deactivated / archived tenant. An exafy_admin keeps reading it; a member resolves to the default
  -- tenant instead of being locked out; anyone else cannot reach it.
  IF NOT tenant_record.is_active AND NOT v_is_exafy THEN
    IF NOT v_is_member THEN
      RAISE EXCEPTION 'TENANT_NOT_JOINABLE' USING ERRCODE = '42501';
    END IF;
    SELECT d.tenant_id, d.slug, d.open_signup, true AS is_active INTO tenant_record
      FROM public.tenants d
     WHERE d.is_default AND coalesce(d.is_active, true)
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'NO_DEFAULT_TENANT';
    END IF;
    v_fallback := true;
    v_is_member := EXISTS (
      SELECT 1 FROM public.user_tenants ut
       WHERE ut.tenant_id = tenant_record.tenant_id AND ut.user_id = v_uid
    );
  END IF;

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
      jsonb_build_object('tenant_slug', tenant_record.slug, 'timestamp', now())
        || CASE WHEN v_fallback
                THEN jsonb_build_object('requested_slug', p_tenant_slug, 'fallback', true)
                ELSE '{}'::jsonb END
    );
  END IF;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.switch_to_tenant_by_slug(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.switch_to_tenant_by_slug(text) TO authenticated;

COMMIT;
