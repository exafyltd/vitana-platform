-- VTID-05147 test fixture: reproduces the live (2026-10-13) role/membership
-- write exposure on a throwaway local Postgres, for
-- scripts/ci/test-vtid-05147-s-m-lockdown.sh.
--  * roles anon / authenticated / service_role (BYPASSRLS), auth.uid() and
--    auth.jwt() over request.jwt.claims as Supabase defines them, a minimal
--    auth.users;
--  * user_tenants, role_preferences, user_active_roles, user_permitted_roles,
--    memberships, app_users with their live columns that matter, constraints,
--    RLS, policies and table grants (information_schema / pg_policies,
--    2026-10-13);
--  * check_role_permitted, current_tenant_id, current_active_role,
--    is_exafy_admin, me_context, me_set_active_role, set_role_preference and
--    switch_to_tenant_by_slug copied from pg_get_functiondef with their live
--    ACLs, plus membership_side_effects_suppressed. The four AFTER INSERT
--    primary-membership triggers are not reproduced (side effects only).
-- Data: tenant T_A (open_signup) and T_B (closed); member M (T_A, community,
-- permitted 'professional'); exafy admin X; new user N (no membership yet);
-- orphan role_preferences row of a deleted user D.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE auth.users (id uuid PRIMARY KEY, raw_app_meta_data jsonb);

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
  tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text,
  open_signup boolean NOT NULL DEFAULT false
);

CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid, event_type text NOT NULL, event_data jsonb, tenant_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.user_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  active_role text NOT NULL DEFAULT 'community',
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE public.role_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  role text NOT NULL CHECK (role = ANY (ARRAY['community', 'patient', 'professional', 'staff', 'backoffice', 'admin', 'developer', 'infra'])),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id)
);

CREATE TABLE public.user_active_roles (
  user_id uuid PRIMARY KEY,
  active_role text NOT NULL DEFAULT 'community',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.user_permitted_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  role text NOT NULL,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id, role)
);

CREATE TABLE public.memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  role public.tenant_role NOT NULL DEFAULT 'community',
  status text NOT NULL DEFAULT 'active' CHECK (status = ANY (ARRAY['active', 'inactive', 'pending'])),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id)
);

CREATE TABLE public.app_users (
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  display_name text,
  stripe_account_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Live table grants (information_schema.role_table_grants, 2026-10-13).
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON
  public.user_tenants, public.role_preferences, public.user_active_roles, public.user_permitted_roles,
  public.memberships, public.app_users TO authenticated, service_role;
GRANT SELECT, TRUNCATE, REFERENCES, TRIGGER ON
  public.user_tenants, public.role_preferences, public.user_active_roles, public.memberships, public.app_users TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.user_permitted_roles TO anon;
GRANT SELECT ON public.tenants TO anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.audit_events TO service_role;

ALTER TABLE public.user_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_active_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_permitted_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.is_exafy_admin(user_id_param uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((
    SELECT (raw_app_meta_data ->> 'exafy_admin')::boolean
    FROM auth.users
    WHERE id = user_id_param
  ), false);
$function$;

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

CREATE FUNCTION public.current_active_role()
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_role TEXT;
    v_jwt_claims JSONB;
BEGIN
    BEGIN
        v_role := current_setting('request.active_role', true);
        IF v_role IS NOT NULL AND v_role != '' THEN
            RETURN v_role;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;
    BEGIN
        v_jwt_claims := current_setting('request.jwt.claims', true)::JSONB;
        IF v_jwt_claims IS NOT NULL THEN
            v_role := v_jwt_claims->>'active_role';
            IF v_role IS NOT NULL AND v_role != '' THEN
                RETURN v_role;
            END IF;
            v_role := v_jwt_claims->>'role';
            IF v_role IS NOT NULL AND v_role != '' THEN
                RETURN v_role;
            END IF;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;
    RETURN 'community';
END;
$function$;

CREATE FUNCTION public.membership_side_effects_suppressed()
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT coalesce(current_setting('vitana.suppress_membership_side_effects', true), '') = 'on'
$function$;

-- Live policies (pg_policies, 2026-10-13).
CREATE POLICY admin_read_all_user_tenants ON public.user_tenants FOR SELECT TO authenticated
  USING ((((auth.jwt() -> 'app_metadata') ->> 'exafy_admin'))::boolean IS TRUE);
CREATE POLICY user_tenants_all_service_role ON public.user_tenants FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY user_tenants_select_own ON public.user_tenants FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY user_tenants_update_own ON public.user_tenants FOR UPDATE TO authenticated USING (user_id = auth.uid());

CREATE POLICY rp_delete_self ON public.role_preferences FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY rp_select_self ON public.role_preferences FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY rp_update_self ON public.role_preferences FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY rp_upsert_self ON public.role_preferences FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY user_active_roles_insert ON public.user_active_roles FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY user_active_roles_select ON public.user_active_roles FOR SELECT USING (user_id = auth.uid());
CREATE POLICY user_active_roles_update ON public.user_active_roles FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY upr_all_service_role ON public.user_permitted_roles FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY upr_select_own ON public.user_permitted_roles FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY memberships_delete_new ON public.memberships FOR DELETE USING (is_exafy_admin(auth.uid()));
CREATE POLICY memberships_insert_new ON public.memberships FOR INSERT WITH CHECK (is_exafy_admin(auth.uid()));
CREATE POLICY memberships_select_new ON public.memberships FOR SELECT USING ((user_id = auth.uid()) OR is_exafy_admin(auth.uid()));
CREATE POLICY memberships_update_new ON public.memberships FOR UPDATE USING (is_exafy_admin(auth.uid())) WITH CHECK (is_exafy_admin(auth.uid()));

CREATE POLICY app_users_all_service_role ON public.app_users FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY app_users_owner_read ON public.app_users FOR SELECT USING ((tenant_id = current_tenant_id()) AND (user_id = auth.uid()));
CREATE POLICY app_users_owner_write ON public.app_users FOR UPDATE
  USING ((tenant_id = current_tenant_id()) AND (user_id = auth.uid()))
  WITH CHECK ((tenant_id = current_tenant_id()) AND (user_id = auth.uid()));
CREATE POLICY app_users_select_own ON public.app_users FOR SELECT TO authenticated USING (user_id = auth.uid());

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

CREATE FUNCTION public.me_context()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user_id UUID;
    v_email TEXT;
    v_tenant_id UUID;
    v_active_role TEXT;
    v_stored_role TEXT;
    v_jwt_claims JSONB;
    v_available_roles TEXT[];
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED', 'message', 'No authenticated user');
    END IF;
    BEGIN
        v_jwt_claims := current_setting('request.jwt.claims', true)::JSONB;
        v_email := v_jwt_claims->>'email';
    EXCEPTION WHEN OTHERS THEN
        v_email := NULL;
    END;
    v_tenant_id := public.current_tenant_id();
    SELECT active_role INTO v_stored_role
    FROM public.user_active_roles
    WHERE user_id = v_user_id;
    IF v_stored_role IS NOT NULL THEN
        v_active_role := v_stored_role;
    ELSE
        v_active_role := public.current_active_role();
    END IF;
    v_available_roles := ARRAY['community', 'patient', 'professional', 'staff', 'admin', 'developer'];
    RETURN jsonb_build_object(
        'ok', true, 'user_id', v_user_id, 'id', v_user_id, 'email', v_email, 'tenant_id', v_tenant_id,
        'active_role', v_active_role, 'roles', to_jsonb(v_available_roles), 'available_roles', to_jsonb(v_available_roles)
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.me_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.me_context() TO authenticated, service_role;

CREATE FUNCTION public.me_set_active_role(p_role text)
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
REVOKE ALL ON FUNCTION public.me_set_active_role(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.me_set_active_role(text) TO authenticated, service_role;

-- set_role_preference as live before VTID-05147 (VTID-04561 body), with its
-- live ACL: PUBLIC and anon keep EXECUTE.
CREATE FUNCTION public.set_role_preference(p_tenant_id uuid, p_role text)
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
GRANT EXECUTE ON FUNCTION public.set_role_preference(uuid, text) TO anon, authenticated, service_role;

CREATE FUNCTION public.switch_to_tenant_by_slug(p_tenant_slug text)
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

  UPDATE auth.users
     SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) ||
           jsonb_build_object('active_tenant_id', tenant_record.tenant_id)
   WHERE id = v_uid
     AND raw_app_meta_data->>'active_tenant_id' IS DISTINCT FROM tenant_record.tenant_id::text;
  GET DIAGNOSTICS v_switched = ROW_COUNT;

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
REVOKE ALL ON FUNCTION public.switch_to_tenant_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.switch_to_tenant_by_slug(text) TO authenticated, service_role;

-- Data.
INSERT INTO public.tenants (tenant_id, name, slug, open_signup) VALUES
  ('0000000a-0000-0000-0000-000000005147', 'Tenant A', 't-a', true),
  ('0000000b-0000-0000-0000-000000005147', 'Tenant B', 't-b', false);

INSERT INTO auth.users (id, raw_app_meta_data) VALUES
  ('00000000-0000-0000-0000-00000000aa01', '{"active_tenant_id":"0000000a-0000-0000-0000-000000005147"}'),  -- M
  ('00000000-0000-0000-0000-00000000aa02', '{"exafy_admin":true}'),                                         -- X
  ('00000000-0000-0000-0000-00000000aa03', '{}');                                                           -- N

INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary) VALUES
  ('0000000a-0000-0000-0000-000000005147', '00000000-0000-0000-0000-00000000aa01', 'community', true);
INSERT INTO public.user_permitted_roles (user_id, tenant_id, role) VALUES
  ('00000000-0000-0000-0000-00000000aa01', '0000000a-0000-0000-0000-000000005147', 'professional');
INSERT INTO public.role_preferences (user_id, tenant_id, role) VALUES
  ('00000000-0000-0000-0000-00000000aa01', '0000000a-0000-0000-0000-000000005147', 'community'),
  -- orphan row of a deleted auth user (live: 12 such rows, inert)
  ('00000000-0000-0000-0000-00000000dd01', '0000000a-0000-0000-0000-000000005147', 'community');
INSERT INTO public.user_active_roles (user_id, active_role) VALUES
  ('00000000-0000-0000-0000-00000000aa01', 'community');
