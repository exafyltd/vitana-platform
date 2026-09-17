-- VTID-03995 — Role switching for members whose roles come from `memberships`,
-- and Community as the guaranteed way back.
--
-- Found while building the mobile role switcher (vitana-v1 VTID-03993):
--
-- 1. `get_my_permitted_roles()` reads ONLY `user_permitted_roles` (the
--    gateway's /api/v1/roles/grant table). A patient activated by
--    `trg_activate_patient_profile` (VTID-03932) gets `memberships.role`
--    bumped community→patient and no `user_permitted_roles` row, so the
--    switcher never listed Patient for them — on desktop or mobile.
--
-- 2. `set_role_preference()`'s second path ("an active memberships row with
--    the role AND validate_role_assignment()") can never pass for an
--    ordinary member: `validate_role_assignment()` judges whether the CALLER
--    may grant a role to someone else (admin/staff only). So a member whose
--    only grant lives in `memberships` could not switch to it — and, because
--    the patient trigger REPLACES the community membership row rather than
--    adding one, could not switch back to Community either.
--
-- Fix, minimal and additive:
--   * get_my_permitted_roles(): union user_permitted_roles ∪ active
--     memberships.role for the tenant, always including 'community'.
--   * set_role_preference(): 'community' is always allowed (everyone is a
--     community member by definition); a role carried by an ACTIVE memberships
--     row is allowed without the grant-to-others check. The exafy path and
--     the "only exafy may switch to admin" block are unchanged.
--
-- File-only until the platform owner applies it (single shared Supabase
-- project). Staging-first: nothing here deploys anywhere by itself.

CREATE OR REPLACE FUNCTION public.get_my_permitted_roles()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_is_exafy_admin BOOLEAN;
    v_roles TEXT[];
    v_all_roles TEXT[] := ARRAY['community', 'patient', 'professional', 'staff', 'backoffice', 'admin', 'developer', 'infra'];
BEGIN
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    SELECT COALESCE((raw_app_meta_data->>'exafy_admin')::BOOLEAN, false)
      INTO v_is_exafy_admin
      FROM auth.users
     WHERE id = v_user_id;

    IF v_is_exafy_admin THEN
        RETURN jsonb_build_object('ok', true, 'roles', to_jsonb(v_all_roles), 'is_super_admin', true);
    END IF;

    v_tenant_id := public.current_tenant_id();

    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'roles', to_jsonb(ARRAY['community']), 'is_super_admin', false);
    END IF;

    -- VTID-03995: explicit grants ∪ roles held via an active membership ∪ community,
    -- in ladder order.
    SELECT ARRAY_AGG(r.role ORDER BY
             CASE r.role
               WHEN 'community' THEN 1 WHEN 'patient' THEN 2 WHEN 'professional' THEN 3
               WHEN 'staff' THEN 4 WHEN 'backoffice' THEN 5 WHEN 'admin' THEN 6
               WHEN 'developer' THEN 7 WHEN 'infra' THEN 8 ELSE 99 END)
      INTO v_roles
      FROM (
        SELECT DISTINCT role FROM (
          SELECT upr.role::text AS role
            FROM public.user_permitted_roles upr
           WHERE upr.user_id = v_user_id AND upr.tenant_id = v_tenant_id
          UNION
          SELECT m.role::text
            FROM public.memberships m
           WHERE m.user_id = v_user_id AND m.tenant_id = v_tenant_id AND m.status = 'active'
          UNION
          SELECT 'community'
        ) u
        WHERE u.role = ANY (v_all_roles)
      ) r;

    IF v_roles IS NULL OR array_length(v_roles, 1) IS NULL THEN
        v_roles := ARRAY['community'];
    END IF;

    RETURN jsonb_build_object('ok', true, 'roles', to_jsonb(v_roles), 'is_super_admin', false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_role_preference(p_tenant_id uuid, p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  is_exafy_admin boolean;
  has_membership_role boolean;
  is_permitted_role boolean;
BEGIN
  is_exafy_admin := COALESCE((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean, false);

  -- VTID-03995: 'community' is always reachable — it is the baseline every
  -- member has, and the way back from any other mode.
  IF NOT is_exafy_admin AND p_role <> 'community' THEN
    is_permitted_role := public.check_role_permitted(auth.uid(), p_tenant_id, p_role);

    IF NOT is_permitted_role THEN
      -- A role the member actually HOLDS via an active membership (e.g. the
      -- patient bump from trg_activate_patient_profile). The old extra
      -- validate_role_assignment() check was a grant-to-others predicate and
      -- always failed for ordinary members.
      SELECT EXISTS (
        SELECT 1
        FROM public.memberships m
        WHERE m.user_id = auth.uid()
          AND m.tenant_id = p_tenant_id
          AND m.role::text = p_role
          AND m.status = 'active'
      ) INTO has_membership_role;

      IF NOT has_membership_role THEN
        RAISE EXCEPTION 'Role not granted for this tenant';
      END IF;
    END IF;
  END IF;

  -- Prevent users from switching to admin role unless they're exafy_admin (UNCHANGED)
  IF p_role = 'admin' AND NOT is_exafy_admin THEN
    RAISE EXCEPTION 'Admin role can only be assigned by super administrators';
  END IF;

  INSERT INTO public.role_preferences (user_id, tenant_id, role)
  VALUES (auth.uid(), p_tenant_id, p_role)
  ON CONFLICT (user_id, tenant_id)
  DO UPDATE SET role = EXCLUDED.role, updated_at = now();

  INSERT INTO public.audit_events (user_id, tenant_id, event_type, event_data)
  VALUES (
    auth.uid(),
    p_tenant_id,
    CASE WHEN is_exafy_admin THEN 'admin_role_switch' ELSE 'user_role_switch' END,
    jsonb_build_object(
      'new_role', p_role,
      'timestamp', now(),
      'is_exafy_admin', is_exafy_admin,
      'user_agent', current_setting('request.headers', true)::json->>'user-agent'
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.get_my_permitted_roles() IS 'VTID-03995: explicit grants (user_permitted_roles) ∪ roles held via active memberships ∪ community, ladder-ordered. Exafy admins get all eight.';
COMMENT ON FUNCTION public.set_role_preference(uuid, text) IS 'VTID-03995: community always allowed; otherwise the role must be explicitly permitted OR held via an active membership. Admin stays exafy-only.';
