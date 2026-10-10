-- VTID-05043 rollback for Migration C (20261010170200_vtid_05043_s3_switch_tenant_open_signup_only.sql).
-- Restores the switch_to_tenant_by_slug body captured read-only from production before apply
-- (live-before.sql, 2026-10-10) and its previous grants (PUBLIC, anon, authenticated).
-- Note: the restored body is the live one, which raises on every call (it reads tenant_record.id,
-- and public.tenants has no `id` column) — that is the pre-S3 behaviour, restored verbatim.
-- Run order for a full rollback: this file, then rollback-s3-backfill.sql, then rollback-s3-guard.sql.

BEGIN;

CREATE OR REPLACE FUNCTION public.switch_to_tenant_by_slug(p_tenant_slug text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  tenant_record RECORD;
  existing_membership RECORD;
BEGIN
  -- Find the tenant by slug
  SELECT * INTO tenant_record FROM public.tenants WHERE slug = p_tenant_slug;

  IF tenant_record.id IS NULL THEN
    RAISE EXCEPTION 'Tenant not found: %', p_tenant_slug;
  END IF;

  -- Check if user already has membership
  SELECT * INTO existing_membership
  FROM public.memberships
  WHERE user_id = auth.uid() AND tenant_id = tenant_record.id;

  -- If no membership exists, create one with community role ONLY
  IF existing_membership.id IS NULL THEN
    INSERT INTO public.memberships (user_id, tenant_id, role, status)
    VALUES (auth.uid(), tenant_record.id, 'community'::public.tenant_role, 'active');

    -- Set role preference to community (no self-assignment)
    INSERT INTO public.role_preferences (user_id, tenant_id, role)
    VALUES (auth.uid(), tenant_record.id, 'community')
    ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = 'community';
  END IF;

  -- Update active tenant in user metadata
  UPDATE auth.users
  SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) ||
    jsonb_build_object('active_tenant_id', tenant_record.id)
  WHERE id = auth.uid();

  -- Log the tenant switch for audit purposes
  INSERT INTO public.audit_events (user_id, tenant_id, event_type, event_data)
  VALUES (
    auth.uid(),
    tenant_record.id,
    'tenant_switch',
    jsonb_build_object('tenant_slug', p_tenant_slug, 'timestamp', now())
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.switch_to_tenant_by_slug(text) TO PUBLIC, anon, authenticated;

COMMIT;
