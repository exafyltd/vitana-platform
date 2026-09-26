-- VTID-04655 — me_set_active_role() writes role_preferences for real users.
--
-- VTID-04561 made both role switchers write both role tables. The
-- role_preferences write in me_set_active_role() was keyed on
-- current_tenant_id(), which only reads a top-level `tenant` / `tenant_id`
-- JWT claim that Supabase never issues (the tenant lives at
-- app_metadata.active_tenant_id — see VTID-04044). So for every real caller
-- the tenant was NULL and only user_active_roles moved. Found by the
-- VTID-04560 staging verification (2026-09-26): me_set_active_role('developer')
-- answered {ok:true, tenant_id:null} and role_preferences stayed 'community'.
--
-- Fix, inside this function only: authorization is unchanged (it still uses
-- current_tenant_id() exactly as before, so nobody gains or loses a role),
-- and a separate v_pref_tenant decides which role_preferences row to write:
-- current_tenant_id(), else the token's app_metadata.active_tenant_id, else
-- the caller's primary membership — and only a tenant the caller belongs to.
-- current_tenant_id() itself is deliberately NOT widened: it backs RLS on
-- many tables (VTID-04044).

CREATE OR REPLACE FUNCTION public.me_set_active_role(p_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_pref_tenant UUID;
    v_claim_tenant TEXT;
    v_permitted BOOLEAN;
    v_allowed_roles TEXT[] := ARRAY['community', 'patient', 'professional', 'staff', 'backoffice', 'admin', 'developer', 'infra'];
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED', 'message', 'No authenticated user');
    END IF;
    IF p_role IS NULL OR NOT (p_role = ANY(v_allowed_roles)) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_ROLE',
            'message', 'Role must be one of: community, patient, professional, staff, backoffice, admin, developer, infra');
    END IF;
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NOT NULL THEN
        v_permitted := public.check_role_permitted(v_user_id, v_tenant_id, p_role);
        IF NOT v_permitted THEN
            RETURN jsonb_build_object('ok', false, 'error', 'ROLE_NOT_PERMITTED',
                'message', 'You do not have permission to use this role. Contact your tenant admin.');
        END IF;
    ELSE
        DECLARE
            v_is_exafy_admin BOOLEAN;
        BEGIN
            SELECT COALESCE((raw_app_meta_data->>'exafy_admin')::BOOLEAN, false)
              INTO v_is_exafy_admin FROM auth.users WHERE id = v_user_id;
            IF NOT v_is_exafy_admin AND p_role != 'community' THEN
                RETURN jsonb_build_object('ok', false, 'error', 'ROLE_NOT_PERMITTED',
                    'message', 'No tenant context available. Contact support.');
            END IF;
        END;
    END IF;
    INSERT INTO public.user_active_roles (user_id, active_role, updated_at)
    VALUES (v_user_id, p_role, NOW())
    ON CONFLICT (user_id) DO UPDATE SET active_role = EXCLUDED.active_role, updated_at = NOW();

    -- VTID-04561/04655: the community app and Vitana read role_preferences — keep it in step.
    v_pref_tenant := v_tenant_id;
    IF v_pref_tenant IS NULL THEN
        v_claim_tenant := auth.jwt() -> 'app_metadata' ->> 'active_tenant_id';
        IF v_claim_tenant ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            SELECT ut.tenant_id INTO v_pref_tenant
              FROM public.user_tenants ut
             WHERE ut.user_id = v_user_id AND ut.tenant_id = v_claim_tenant::uuid
             LIMIT 1;
        END IF;
    END IF;
    IF v_pref_tenant IS NULL THEN
        SELECT ut.tenant_id INTO v_pref_tenant
          FROM public.user_tenants ut
         WHERE ut.user_id = v_user_id AND ut.is_primary
         LIMIT 1;
    END IF;
    IF v_pref_tenant IS NOT NULL THEN
        INSERT INTO public.role_preferences (user_id, tenant_id, role)
        VALUES (v_user_id, v_pref_tenant, p_role)
        ON CONFLICT (user_id, tenant_id)
        DO UPDATE SET role = EXCLUDED.role, updated_at = now();
    END IF;
    PERFORM set_config('request.active_role', p_role, true);
    RETURN jsonb_build_object('ok', true, 'user_id', v_user_id, 'active_role', p_role,
                              'tenant_id', v_tenant_id, 'preference_tenant_id', v_pref_tenant);
END;
$function$;

-- Re-align the rows this defect left behind: where a role_preferences row
-- disagrees with a NEWER user_active_roles row, the switch that wrote
-- user_active_roles is the user's latest choice. user_active_roles carries no
-- tenant, so the repair is limited to users with exactly ONE membership —
-- there the tenant the switch was made for is certain. A multi-tenant user is
-- left untouched (their next switch writes the right row).
UPDATE public.role_preferences rp
   SET role = uar.active_role, updated_at = now()
  FROM public.user_active_roles uar
  JOIN public.user_tenants ut ON ut.user_id = uar.user_id
 WHERE rp.user_id = uar.user_id
   AND rp.tenant_id = ut.tenant_id
   AND rp.role IS DISTINCT FROM uar.active_role
   AND uar.updated_at > rp.updated_at
   AND (SELECT count(*) FROM public.user_tenants m WHERE m.user_id = uar.user_id) = 1;
