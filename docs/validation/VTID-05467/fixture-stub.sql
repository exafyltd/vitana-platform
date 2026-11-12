-- VTID-05467 PGlite fixture: the stub schema the lane's checks run on. Not a migration, and never run on a live database.
-- It recreates, with their live columns, constraints and privileges (VTID-05147 state), the objects this lane touches,
-- and it seeds the state the checks need. The three function bodies are copied verbatim from their last migrations
-- (bootstrap_admin_user: vitana-v1 20250915132930; me_set_active_role: 20260926150000; set_role_preference: 20261013233000).
-- @TPK@ is replaced by the runner: tenant_id (the shape the 2026 migrations and fixtures use) or id (the 2025 bootstrap DDL).
-- Not reproduced: auth.users triggers, the four primary-membership side-effect triggers, other RLS policies.

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  aud text,
  role text,
  email text,
  raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb
);
GRANT ALL ON auth.users TO service_role;

CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO anon, authenticated, service_role;

CREATE TYPE public.tenant_role AS ENUM ('community', 'patient', 'professional', 'reseller', 'staff', 'admin', 'backoffice', 'developer', 'infra');

CREATE TABLE public.tenants (
  @TPK@ uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  open_signup boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false,
  is_platform boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_default_not_platform CHECK (NOT (is_default AND is_platform))
);
CREATE UNIQUE INDEX tenants_one_default ON public.tenants ((true)) WHERE is_default;

CREATE TABLE public.app_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  display_name text
);

CREATE TABLE public.memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants(@TPK@) ON DELETE CASCADE,
  role public.tenant_role NOT NULL DEFAULT 'community',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'pending')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id)
);

CREATE TABLE public.user_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(@TPK@) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  active_role text NOT NULL DEFAULT 'community',
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE public.role_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants(@TPK@) ON DELETE CASCADE,
  role text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id),
  CONSTRAINT role_preferences_role_check CHECK (role = ANY (ARRAY['community', 'patient', 'professional', 'staff', 'backoffice', 'admin', 'developer', 'infra']))
);

CREATE TABLE public.user_active_roles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  active_role text NOT NULL DEFAULT 'community',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.user_permitted_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(@TPK@) ON DELETE CASCADE,
  role text NOT NULL,
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id, role)
);

CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  tenant_id uuid,
  event_type text NOT NULL,
  event_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_active_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_permitted_roles ENABLE ROW LEVEL SECURITY;

-- Live policies that the checks depend on (VTID-05147 state; reads only).
CREATE POLICY user_tenants_select_own ON public.user_tenants FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY user_tenants_all_service_role ON public.user_tenants FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY rp_select_self ON public.role_preferences FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY user_active_roles_select ON public.user_active_roles FOR SELECT USING (user_id = auth.uid());
CREATE POLICY upr_select_own ON public.user_permitted_roles FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY upr_all_service_role ON public.user_permitted_roles FOR ALL TO service_role USING (true) WITH CHECK (true);

-- VTID-05147 privileges: no client writes to the four role tables.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON public.user_tenants, public.role_preferences, public.user_active_roles, public.user_permitted_roles FROM anon, authenticated;
GRANT ALL ON public.user_tenants, public.role_preferences, public.user_active_roles, public.user_permitted_roles, public.memberships, public.app_users, public.audit_events, public.tenants TO service_role;

CREATE FUNCTION public.current_tenant_id()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_tenant_id UUID;
    v_jwt_claims JSONB;
BEGIN
    BEGIN
        v_tenant_id := current_setting('request.tenant_id', true)::UUID;
        IF v_tenant_id IS NOT NULL THEN
            RETURN v_tenant_id;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;
    BEGIN
        v_jwt_claims := current_setting('request.jwt.claims', true)::JSONB;
        IF v_jwt_claims IS NOT NULL THEN
            v_tenant_id := (v_jwt_claims->>'tenant_id')::UUID;
            IF v_tenant_id IS NOT NULL THEN
                RETURN v_tenant_id;
            END IF;
            v_tenant_id := (v_jwt_claims->>'tenant')::UUID;
            IF v_tenant_id IS NOT NULL THEN
                RETURN v_tenant_id;
            END IF;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;
    RETURN NULL;
END;
$function$;

CREATE FUNCTION public.check_role_permitted(p_user_id uuid, p_tenant_id uuid, p_role text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_is_exafy_admin BOOLEAN;
    v_permitted BOOLEAN;
BEGIN
    SELECT COALESCE(
        (raw_app_meta_data->>'exafy_admin')::BOOLEAN,
        false
    ) INTO v_is_exafy_admin
    FROM auth.users
    WHERE id = p_user_id;

    IF v_is_exafy_admin THEN
        RETURN true;
    END IF;

    SELECT EXISTS(
        SELECT 1
        FROM public.user_permitted_roles
        WHERE user_id = p_user_id
          AND tenant_id = p_tenant_id
          AND role = p_role
    ) INTO v_permitted;

    RETURN v_permitted;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.check_role_permitted(uuid, uuid, text) TO anon, authenticated, service_role;

-- Previous function bodies (verbatim from their last migrations). Re-created by the rollback file.
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

GRANT EXECUTE ON FUNCTION public.set_role_preference(uuid, text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.set_role_preference(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.me_set_active_role(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.me_set_active_role(text) TO authenticated, service_role;

-- Seeds. Tenants: the default tenant (Maxina) and two others with their 2025 names.
INSERT INTO public.tenants (name, slug, is_default) VALUES
  ('Maxina', 'maxina', true),
  ('Alkalma', 'alkalma', false),
  ('Earthlings', 'earthlings', false);

-- L: a member whose preference (role_preferences) disagrees with active_role. The apply must not change either value.
-- K: a permitted member (grant 'developer') with a consistent selection; it switches after the apply, so the rollback
--    has something to restore.
INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data) VALUES
  ('05467000-0000-4000-8000-0000000000f1', 'authenticated', 'authenticated', 'legacy-05467@example.test', '{}'),
  ('05467000-0000-4000-8000-0000000000f2', 'authenticated', 'authenticated', 'switch-05467@example.test', '{}');
INSERT INTO public.app_users (user_id, email, display_name) VALUES
  ('05467000-0000-4000-8000-0000000000f1', 'legacy-05467@example.test', 'legacy'),
  ('05467000-0000-4000-8000-0000000000f2', 'switch-05467@example.test', 'switch');
INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
  SELECT @TPK@, '05467000-0000-4000-8000-0000000000f1'::uuid, 'community', true FROM public.tenants WHERE is_default
  UNION ALL
  SELECT @TPK@, '05467000-0000-4000-8000-0000000000f2'::uuid, 'community', false FROM public.tenants WHERE is_default;
INSERT INTO public.role_preferences (user_id, tenant_id, role)
  SELECT '05467000-0000-4000-8000-0000000000f1'::uuid, @TPK@, 'professional' FROM public.tenants WHERE is_default
  UNION ALL
  SELECT '05467000-0000-4000-8000-0000000000f2'::uuid, @TPK@, 'community' FROM public.tenants WHERE is_default;
INSERT INTO public.user_active_roles (user_id, active_role) VALUES
  ('05467000-0000-4000-8000-0000000000f2', 'community');
INSERT INTO public.user_permitted_roles (user_id, tenant_id, role)
  SELECT '05467000-0000-4000-8000-0000000000f2'::uuid, @TPK@, 'developer' FROM public.tenants WHERE is_default;
