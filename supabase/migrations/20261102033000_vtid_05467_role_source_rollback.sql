-- VTID-05467 (mt-identity-r2 / role-source-and-bootstrap, R3): rollback of
-- 20261102033000_vtid_05467_single_role_source.sql and 20261102033100_vtid_05467_fix_bootstrap_admin_user.sql.
-- Pre-approved by the plan (owner approval still needed before any RUN-MIGRATION dispatch, collaboration.md §7d).
--
-- Replay order: this file sorts before the forward files ("..._role_source_rollback" < "..._single_role_source"), so a
-- full replay runs it first. On a database without this lane it is a no-op: the three bodies it restores are the bodies
-- already live, the trigger and the snapshot tables do not exist (IF EXISTS), and no row changes.
--
-- Restores, verbatim from their last definitions:
--   * bootstrap_admin_user: vitana-v1 supabase/migrations/20250915132930_57b924d9-8a27-470e-ad21-6d2ac5be7a37.sql:166-265;
--   * me_set_active_role: 20260926150000_vtid_04655_me_set_active_role_writes_role_preferences.sql;
--   * set_role_preference: 20261013233000_vtid_05147_s_m_membership_role_lockdown.sql (section 5).
-- Then: drops the derivation trigger and function (before any data is restored, so the restore cannot re-derive
-- role_preferences), restores user_tenants.active_role from the apply-time snapshot for the memberships that still exist,
-- and drops the three legacy_archive.bak_05467_* snapshots.
-- role_preferences is not restored. After the lane it holds the current selection that the community app and the ORB read.
-- Rows the derivation created stay for the same reason.
--
-- impact-allow-solo-migration: rollback of DB-only objects. No gateway, worker or frontend code reads them by name.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. Previous bodies (CREATE OR REPLACE keeps the existing owner and ACLs).
CREATE OR REPLACE FUNCTION public.bootstrap_admin_user(p_user_id uuid, p_user_email text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  current_admin_id uuid;
  user_exists boolean;
BEGIN
  -- Get the current user performing the bootstrap
  current_admin_id := auth.uid();
  
  -- Validate that the current user is an exafy_admin
  IF NOT COALESCE((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean, false) THEN
    RAISE EXCEPTION 'Only exafy_admin can bootstrap admin users';
  END IF;
  
  -- Check if target user exists
  SELECT EXISTS(SELECT 1 FROM auth.users WHERE id = p_user_id) INTO user_exists;
  IF NOT user_exists THEN
    RAISE EXCEPTION 'Target user does not exist: %', p_user_email;
  END IF;
  
  -- Prevent bootstrapping if user is already an admin
  IF COALESCE((
    SELECT (raw_app_meta_data ->> 'exafy_admin')::boolean 
    FROM auth.users 
    WHERE id = p_user_id
  ), false) THEN
    -- Log attempted duplicate bootstrap
    INSERT INTO public.audit_events (user_id, tenant_id, event_type, event_data)
    VALUES (
      current_admin_id,
      (SELECT id FROM public.tenants WHERE name = 'Maxina' LIMIT 1),
      'admin_bootstrap_duplicate_attempt',
      jsonb_build_object(
        'target_user_id', p_user_id,
        'target_email', p_user_email,
        'timestamp', now(),
        'reason', 'User already has admin privileges'
      )
    );
    
    RAISE EXCEPTION 'User % is already an admin', p_user_email;
  END IF;
  
  -- Log bootstrap attempt before execution
  INSERT INTO public.audit_events (user_id, tenant_id, event_type, event_data)
  VALUES (
    current_admin_id,
    (SELECT id FROM public.tenants WHERE name = 'Maxina' LIMIT 1),
    'admin_bootstrap_attempt',
    jsonb_build_object(
      'target_user_id', p_user_id,
      'target_email', p_user_email,
      'bootstrap_initiated_by', current_admin_id,
      'timestamp', now()
    )
  );
  
  -- Update user's raw_app_meta_data to make them exafy_admin
  UPDATE auth.users 
  SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('exafy_admin', true)
  WHERE id = p_user_id;
  
  -- Create memberships for all workspaces as admin (only if they don't exist)
  INSERT INTO public.memberships (user_id, tenant_id, role, status)
  SELECT p_user_id, t.id, 'admin'::tenant_role, 'active'
  FROM public.tenants t
  WHERE t.name IN ('Maxina', 'Alkalma', 'Earthlings')
  ON CONFLICT (user_id, tenant_id) DO UPDATE SET
    role = EXCLUDED.role,
    status = EXCLUDED.status,
    updated_at = now();
    
  -- Set the first tenant as active
  UPDATE auth.users 
  SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || 
    jsonb_build_object('active_tenant_id', (
      SELECT id FROM public.tenants WHERE name = 'Maxina' LIMIT 1
    ))
  WHERE id = p_user_id;
  
  -- Log successful bootstrap completion
  INSERT INTO public.audit_events (user_id, tenant_id, event_type, event_data)
  VALUES (
    current_admin_id,
    (SELECT id FROM public.tenants WHERE name = 'Maxina' LIMIT 1),
    'admin_bootstrap_success',
    jsonb_build_object(
      'target_user_id', p_user_id,
      'target_email', p_user_email,
      'bootstrap_completed_by', current_admin_id,
      'timestamp', now(),
      'tenants_assigned', ARRAY['Maxina', 'Alkalma', 'Earthlings']
    )
  );
END;
$function$;

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
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  is_exafy_admin := COALESCE((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean, false);
  -- VTID-05147: only a tenant the caller is a member of.
  IF NOT is_exafy_admin AND NOT EXISTS (
    SELECT 1 FROM public.user_tenants ut
     WHERE ut.user_id = auth.uid() AND ut.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'Not a member of this tenant' USING ERRCODE = '42501';
  END IF;
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

-- 2. Remove the derivation before any data is restored.
DROP TRIGGER IF EXISTS user_tenants_derive_role_preference ON public.user_tenants;
DROP FUNCTION IF EXISTS public.user_tenants_derive_role_preference();

-- 3. Restore the apply-time selected role of each membership that still exists.
DO $restore$
BEGIN
  IF to_regclass('legacy_archive.bak_05467_user_tenants') IS NOT NULL THEN
    UPDATE public.user_tenants ut
       SET active_role = b.active_role
      FROM "legacy_archive".bak_05467_user_tenants b
     WHERE b.id = ut.id
       AND ut.active_role IS DISTINCT FROM b.active_role;
  END IF;
END
$restore$;

-- 4. Snapshots.
DROP TABLE IF EXISTS "legacy_archive".bak_05467_user_tenants;
DROP TABLE IF EXISTS "legacy_archive".bak_05467_role_preferences;
DROP TABLE IF EXISTS "legacy_archive".bak_05467_user_active_roles;

COMMIT;
