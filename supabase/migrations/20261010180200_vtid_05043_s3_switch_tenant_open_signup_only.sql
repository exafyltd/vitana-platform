-- VTID-05043 (Track S / S3, Migration C of 3): switch_to_tenant_by_slug joins open-signup tenants only.
--
-- CO-OWNERSHIP: this function originated in exafyltd/vitana-v1
-- (supabase/migrations/20250909092110_250b18a4-830a-429b-8957-83fb97c292ab.sql) and is now
-- co-owned with this repo, because RUN-MIGRATION applies this repo's migrations. A Vitest guard
-- in vitana-v1 (VTID-05043) fails that build if a vitana-v1 migration creates or replaces this
-- function without the open_signup check. Change both sides together.
--
-- Requires Migration A (tenants.open_signup) and B (backfill) to be applied first.
--
-- Two problems, one rewrite:
-- 1. Self-enrolment (S-E1): the 2025 body let any signed-in user join any tenant by slug and
--    pointed their active_tenant_id claim at it. Now: a member of the tenant (user_tenants) or
--    an exafy_admin only switches; anyone else may join only a tenant with open_signup = true
--    (maxina, alkalma); every other tenant raises TENANT_NOT_JOINABLE (42501).
-- 2. The live body reads tenant_record.id, but public.tenants has no `id` column (its key is
--    tenant_id), so every call has raised since ~2025-12-28 and the join/switch path
--    (AlkalmaPortal, useTenant.setTenantBySlug on every Maxina login) has been broken. This body
--    uses tenant_id, so those calls succeed again.
--
-- Joining now also writes user_tenants (the table the gateway reads), primary only when the
-- user has no primary yet. A first primary membership fires the four primary-membership triggers
-- on purpose — that is a real new member (welcome chat idempotent via app_users.welcome_chat_sent).
--
-- Write-free steady state: an existing member re-entering the same tenant updates nothing
-- (IS DISTINCT FROM guard), inserts nothing (ON CONFLICT DO NOTHING) and writes no audit row.
-- A tenant_switch audit row is written only when the claim actually changed or a membership
-- row was created.
--
-- Rollback: docs/validation/VTID-05043/rollback-s3-switch-tenant.sql (restores the live body
-- captured read-only before apply, docs/validation/VTID-05043/live-before.sql, and its grants).

-- impact-allow-solo-migration: lands dark; the gateway code that relies on it ships in the
-- separate VTID-05043 PR3, merged only after this is applied.

BEGIN;

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

COMMIT;
