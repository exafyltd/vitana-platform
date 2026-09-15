-- VTID-03832 — BackOffice role, step 3 of 3: thread `backoffice` (and `infra`) through the
-- three role RPC layers. Every function below is a CREATE OR REPLACE of the LIVE body read
-- on 2026-09-12 (pg_get_functiondef, read-only) with the minimal change marked "VTID-03832".
-- validate_role_assignment() and set_role_preference() had no definition in this repo
-- before this file — they existed only in the live database.
--
-- Layer 1 — grants shown in the switcher: get_my_permitted_roles() v_all_roles (8 roles).
-- Layer 2 — the actual switch path: set_role_preference() now accepts a role that is
--   permitted in user_permitted_roles (VTID-01230 declared it canonical; the gateway's
--   POST /api/v1/roles/grant writes there) OR carried by an active memberships row (the
--   pre-existing path, kept so nothing that works today stops working). The
--   validate_role_assignment() call is kept for the memberships path only: a self-switch
--   into a role you were explicitly granted is not an "assignment" and the ladder must not
--   veto it. The hard block on non-Exafy users switching to `admin` is UNCHANGED.
-- Layer 2b — validate_role_assignment(): ladder renumbered backoffice 5 / admin 6 /
--   developer 7 / infra 8; the `admin` assigner may now assign `backoffice`
--   (tenant-admin-grantable, decision 4b); `backoffice` itself assigns nothing.
-- Layer 3 — session role: me_set_active_role() v_allowed_roles (8 roles). set_active_role()
--   needs no change: it casts to vitana_role, which step 1 extended.
--
-- Nothing here writes data. Exafy admins pick up `backoffice` through the exafy bypass in
-- get_my_permitted_roles(); no re-seed of user_permitted_roles is performed.

-- ---------------------------------------------------------------------------
-- Layer 1: get_my_permitted_roles()
-- ---------------------------------------------------------------------------
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
    -- VTID-03832: + backoffice (ladder order)
    v_all_roles TEXT[] := ARRAY['community', 'patient', 'professional', 'staff', 'backoffice', 'admin', 'developer', 'infra'];
BEGIN
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED'
        );
    END IF;

    -- Check exafy_admin → return all roles
    SELECT COALESCE(
        (raw_app_meta_data->>'exafy_admin')::BOOLEAN,
        false
    ) INTO v_is_exafy_admin
    FROM auth.users
    WHERE id = v_user_id;

    IF v_is_exafy_admin THEN
        RETURN jsonb_build_object(
            'ok', true,
            'roles', to_jsonb(v_all_roles),
            'is_super_admin', true
        );
    END IF;

    -- Get tenant context
    v_tenant_id := public.current_tenant_id();

    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', true,
            'roles', to_jsonb(ARRAY['community']),
            'is_super_admin', false
        );
    END IF;

    -- Get permitted roles from table
    SELECT ARRAY_AGG(role ORDER BY role) INTO v_roles
    FROM public.user_permitted_roles
    WHERE user_id = v_user_id
      AND tenant_id = v_tenant_id;

    -- Ensure at least 'community' is always present
    IF v_roles IS NULL OR array_length(v_roles, 1) IS NULL THEN
        v_roles := ARRAY['community'];
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'roles', to_jsonb(v_roles),
        'is_super_admin', false
    );
END;
$function$;

-- ---------------------------------------------------------------------------
-- Layer 2b: validate_role_assignment() — ladder + assigner allow-lists
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_role_assignment(p_user_id uuid, p_tenant_id uuid, p_role text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  is_exafy_admin boolean;
  current_user_role text;
  target_user_current_role text;
BEGIN
  -- Check if current user is exafy_admin
  is_exafy_admin := COALESCE((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean, false);

  -- Exafy admins can assign any role
  IF is_exafy_admin THEN
    RETURN true;
  END IF;

  -- Get current user's highest role in the tenant
  -- VTID-03832: ladder is community 1 < patient 2 < professional 3 < staff 4 <
  -- backoffice 5 < admin 6 < developer 7 < infra 8 (was admin 5, no backoffice/developer/infra)
  SELECT m.role::text INTO current_user_role
  FROM public.memberships m
  WHERE m.user_id = auth.uid()
    AND m.tenant_id = p_tenant_id
    AND m.status = 'active'
  ORDER BY
    CASE m.role::text
      WHEN 'infra' THEN 8
      WHEN 'developer' THEN 7
      WHEN 'admin' THEN 6
      WHEN 'backoffice' THEN 5
      WHEN 'staff' THEN 4
      WHEN 'professional' THEN 3
      WHEN 'patient' THEN 2
      WHEN 'community' THEN 1
      ELSE 0
    END DESC
  LIMIT 1;

  -- Get target user's current role
  SELECT m.role::text INTO target_user_current_role
  FROM public.memberships m
  WHERE m.user_id = p_user_id
    AND m.tenant_id = p_tenant_id
    AND m.status = 'active'
  LIMIT 1;

  -- Prevent privilege escalation: users can only assign roles lower than their own
  -- Admin can assign any role except admin (unless they're exafy_admin)
  -- Staff can assign patient/community roles only
  -- Others cannot assign roles
  --
  -- VTID-03832: `backoffice` is tenant-admin-grantable (decision 4b) — added to the admin
  -- list. `backoffice` is NOT an assigner (falls to ELSE → false): it opens the BackOffice
  -- door, it does not manage members. developer/infra assignment stays Exafy-only.

  CASE current_user_role
    WHEN 'admin' THEN
      -- Admins can assign any role except admin (unless target is already admin)
      RETURN p_role IN ('backoffice', 'staff', 'professional', 'patient', 'community') OR
             (p_role = 'admin' AND target_user_current_role = 'admin');
    WHEN 'staff' THEN
      -- Staff can only assign patient and community roles
      RETURN p_role IN ('patient', 'community');
    ELSE
      -- Others cannot assign roles
      RETURN false;
  END CASE;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Layer 2: set_role_preference() — the switch path useRole.setRole() calls
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_role_preference(p_tenant_id uuid, p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  is_exafy_admin boolean;
  is_valid_assignment boolean;
  has_membership_role boolean;
  is_permitted_role boolean;
BEGIN
  -- Check if user is exafy_admin using proper metadata
  is_exafy_admin := COALESCE((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean, false);

  -- For non-admin users, the role must be reachable by ONE of two paths:
  --   (a) VTID-03832: explicitly permitted in user_permitted_roles (VTID-01230 canonical;
  --       the gateway's /api/v1/roles/grant writes here) — check_role_permitted() is the
  --       same predicate me_set_active_role() already uses; or
  --   (b) the pre-existing path: an active memberships row carrying the role AND a valid
  --       assignment per the ladder (unchanged behaviour for everyone who works today).
  IF NOT is_exafy_admin THEN
    is_permitted_role := public.check_role_permitted(auth.uid(), p_tenant_id, p_role);

    IF NOT is_permitted_role THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.memberships m
        WHERE m.user_id = auth.uid()
          AND m.tenant_id = p_tenant_id
          AND m.role::text = p_role
          AND m.status = 'active'
      ) INTO has_membership_role;

      SELECT public.validate_role_assignment(auth.uid(), p_tenant_id, p_role) INTO is_valid_assignment;

      IF NOT has_membership_role OR NOT is_valid_assignment THEN
        RAISE EXCEPTION 'Role not granted for this tenant or invalid role assignment';
      END IF;
    END IF;
  END IF;

  -- Prevent users from switching to admin role unless they're exafy_admin (UNCHANGED)
  IF p_role = 'admin' AND NOT is_exafy_admin THEN
    RAISE EXCEPTION 'Admin role can only be assigned by super administrators';
  END IF;

  -- Insert or update role preference
  INSERT INTO public.role_preferences (user_id, tenant_id, role)
  VALUES (auth.uid(), p_tenant_id, p_role)
  ON CONFLICT (user_id, tenant_id)
  DO UPDATE SET role = EXCLUDED.role, updated_at = now();

  -- Enhanced audit logging for all role switches
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

-- ---------------------------------------------------------------------------
-- Layer 3: me_set_active_role() — session role
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.me_set_active_role(p_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_permitted BOOLEAN;
    -- VTID-03832: + backoffice
    v_allowed_roles TEXT[] := ARRAY['community', 'patient', 'professional', 'staff', 'backoffice', 'admin', 'developer', 'infra'];
BEGIN
    -- Gate 1: Get authenticated user
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Gate 2: Validate role syntax
    IF p_role IS NULL OR NOT (p_role = ANY(v_allowed_roles)) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_ROLE',
            'message', 'Role must be one of: community, patient, professional, staff, backoffice, admin, developer, infra'
        );
    END IF;

    -- Get tenant_id
    v_tenant_id := public.current_tenant_id();

    -- Gate 3: VTID-01230 Permission check
    -- If we have a tenant_id, check user_permitted_roles (exafy_admin bypasses)
    IF v_tenant_id IS NOT NULL THEN
        v_permitted := public.check_role_permitted(v_user_id, v_tenant_id, p_role);

        IF NOT v_permitted THEN
            RETURN jsonb_build_object(
                'ok', false,
                'error', 'ROLE_NOT_PERMITTED',
                'message', 'You do not have permission to use this role. Contact your tenant admin.'
            );
        END IF;
    ELSE
        -- No tenant context: only allow if exafy_admin
        DECLARE
            v_is_exafy_admin BOOLEAN;
        BEGIN
            SELECT COALESCE(
                (raw_app_meta_data->>'exafy_admin')::BOOLEAN,
                false
            ) INTO v_is_exafy_admin
            FROM auth.users
            WHERE id = v_user_id;

            IF NOT v_is_exafy_admin AND p_role != 'community' THEN
                RETURN jsonb_build_object(
                    'ok', false,
                    'error', 'ROLE_NOT_PERMITTED',
                    'message', 'No tenant context available. Contact support.'
                );
            END IF;
        END;
    END IF;

    -- Upsert the active role
    INSERT INTO public.user_active_roles (user_id, active_role, updated_at)
    VALUES (v_user_id, p_role, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
        active_role = EXCLUDED.active_role,
        updated_at = NOW();

    -- Set request context for current transaction
    PERFORM set_config('request.active_role', p_role, true);

    RETURN jsonb_build_object(
        'ok', true,
        'user_id', v_user_id,
        'active_role', p_role,
        'tenant_id', v_tenant_id
    );
END;
$function$;

COMMENT ON FUNCTION public.set_role_preference(uuid, text) IS
  'VTID-03832: accepts a role permitted in user_permitted_roles (canonical, VTID-01230) or carried by an active memberships row; non-Exafy users still cannot switch to admin.';
COMMENT ON FUNCTION public.validate_role_assignment(uuid, uuid, text) IS
  'VTID-03832: ladder community1<patient2<professional3<staff4<backoffice5<admin6<developer7<infra8; admin may assign backoffice.';
