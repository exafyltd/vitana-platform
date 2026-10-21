-- VTID-04561 — one role truth across the community app and the Command Hub.
--
-- The role whose screens a user is viewing was stored in two places that
-- disagreed:
--   * the community app (vitana-v1 useRole) writes role_preferences through
--     set_role_preference(tenant, role) and reads it back;
--   * the Command Hub writes user_active_roles through me_set_active_role(role);
--   * the ORB / orchestrator read role_preferences, then user_tenants.active_role.
-- So a switch made in the Command Hub was invisible to the community app and
-- to Vitana. Measured 2026-09-25: 5 of the 6 users holding both rows had them
-- disagree.
--
-- Fix: both switch functions now write BOTH tables in the same transaction,
-- so every reader agrees whichever app made the switch. Existing readers are
-- untouched (no table is replaced by a view — that would change RLS and write
-- semantics for callers this migration does not own). A one-off backfill
-- aligns the rows that already disagree to the most recent choice.
--
-- Additive and idempotent: CREATE OR REPLACE with the same signatures and
-- return types; the backfill only touches rows that disagree.

-- 1. set_role_preference (community app) — unchanged checks, + user_active_roles.
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

  -- VTID-04561: the Command Hub reads user_active_roles — keep it in step.
  INSERT INTO public.user_active_roles (user_id, active_role, updated_at)
  VALUES (auth.uid(), p_role, now())
  ON CONFLICT (user_id) DO UPDATE SET
    active_role = EXCLUDED.active_role,
    updated_at = now();

  INSERT INTO public.audit_events (user_id, tenant_id, event_type, event_data)
  VALUES (
    auth.uid(),
    p_tenant_id,
    CASE WHEN is_exafy_admin THEN 'admin_role_switch' ELSE 'user_role_switch' END,
    jsonb_build_object(
      'new_role', p_role,
      'timestamp', now(),
      'is_exafy_admin', is_exafy_admin,
      'source', 'set_role_preference',
      'user_agent', current_setting('request.headers', true)::json->>'user-agent'
    )
  );
END;
$function$;

-- 2. me_set_active_role (Command Hub) — unchanged checks, + role_preferences.
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
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    IF p_role IS NULL OR NOT (p_role = ANY(v_allowed_roles)) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_ROLE',
            'message', 'Role must be one of: community, patient, professional, staff, backoffice, admin, developer, infra'
        );
    END IF;

    v_tenant_id := public.current_tenant_id();

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

    INSERT INTO public.user_active_roles (user_id, active_role, updated_at)
    VALUES (v_user_id, p_role, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
        active_role = EXCLUDED.active_role,
        updated_at = NOW();

    -- VTID-04561: the community app and Vitana read role_preferences — keep
    -- it in step for the tenant the switch was made in.
    IF v_tenant_id IS NOT NULL THEN
        INSERT INTO public.role_preferences (user_id, tenant_id, role)
        VALUES (v_user_id, v_tenant_id, p_role)
        ON CONFLICT (user_id, tenant_id)
        DO UPDATE SET role = EXCLUDED.role, updated_at = now();
    END IF;

    PERFORM set_config('request.active_role', p_role, true);

    RETURN jsonb_build_object(
        'ok', true,
        'user_id', v_user_id,
        'active_role', p_role,
        'tenant_id', v_tenant_id
    );
END;
$function$;

-- 3. Backfill: align rows that already disagree to the most recent choice.
--    (a) user_active_roles newer → copy into that user's role_preferences rows.
UPDATE public.role_preferences rp
   SET role = uar.active_role,
       updated_at = uar.updated_at
  FROM public.user_active_roles uar
 WHERE uar.user_id = rp.user_id
   AND uar.active_role IS DISTINCT FROM rp.role
   AND uar.updated_at > rp.updated_at;

--    (b) role_preferences newer → copy the user's most recent preference into user_active_roles.
UPDATE public.user_active_roles uar
   SET active_role = latest.role,
       updated_at = latest.updated_at
  FROM (
    SELECT DISTINCT ON (user_id) user_id, role, updated_at
      FROM public.role_preferences
     ORDER BY user_id, updated_at DESC
  ) latest
 WHERE latest.user_id = uar.user_id
   AND latest.role IS DISTINCT FROM uar.active_role
   AND latest.updated_at > uar.updated_at;
