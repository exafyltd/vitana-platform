-- VTID-05043 — live definitions captured read-only before any S3 migration is applied.
-- Captured 2026-10-10 against project inmkhvwdcuyhnxkgfvsb with:
--   SELECT pg_get_functiondef(p.oid), p.proacl FROM pg_proc p ... WHERE proname = 'switch_to_tenant_by_slug';
--   SELECT tgname, tgenabled, pg_get_triggerdef(oid) FROM pg_trigger
--    WHERE tgrelid = 'public.user_tenants'::regclass AND NOT tgisinternal;
-- The rollback files in this folder restore exactly these definitions.
--
-- Note: the live body reads tenant_record.id, but live public.tenants has no `id`
-- column (its key is tenant_id), so every call raises "record has no field id"
-- before any write. Last audit_events tenant_switch row: 2025-12-28 09:37 UTC.
--
-- proacl: {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,
--          service_role=X/postgres,migrate=X/postgres}
-- All four triggers: tgenabled = 'O'.

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

CREATE TRIGGER founding_seat_on_primary_membership AFTER INSERT ON public.user_tenants FOR EACH ROW WHEN ((new.is_primary = true)) EXECUTE FUNCTION claim_founding_seat_on_membership();
CREATE TRIGGER seed_onboarding_autopilot_on_primary_membership AFTER INSERT ON public.user_tenants FOR EACH ROW WHEN ((new.is_primary = true)) EXECUTE FUNCTION seed_onboarding_autopilot_on_membership();
CREATE TRIGGER trg_create_user_live_room AFTER INSERT ON public.user_tenants FOR EACH ROW WHEN ((new.is_primary = true)) EXECUTE FUNCTION create_user_live_room();
CREATE TRIGGER welcome_chat_on_primary_membership AFTER INSERT ON public.user_tenants FOR EACH ROW WHEN ((new.is_primary = true)) EXECUTE FUNCTION fire_welcome_chat_on_membership();
