-- =============================================================================
-- VTID-01230: Role Admission System
-- =============================================================================
-- Problem: Any authenticated user can switch to ANY role (developer, admin, etc.)
-- via POST /api/v1/me/active-role — no permission check exists.
--
-- Solution:
--   A. New user_permitted_roles table — tracks which roles each user is allowed
--   B. RLS policies — users read own, exafy_admin + tenant admin manage
--   C. Modify me_set_active_role() to enforce permission check
--   D. Modify provision_platform_user() to grant 'community' on signup
--   E. Seed exafy_admin users with all roles
-- =============================================================================

BEGIN;

-- =============================================================================
-- A. Create user_permitted_roles table
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.user_permitted_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, tenant_id, role)
);

-- Index for fast lookup by user + tenant
CREATE INDEX IF NOT EXISTS idx_upr_user_tenant ON public.user_permitted_roles(user_id, tenant_id);

-- Enable RLS
ALTER TABLE public.user_permitted_roles ENABLE ROW LEVEL SECURITY;

-- Policy: Users can read their own permitted roles
DROP POLICY IF EXISTS upr_select_own ON public.user_permitted_roles;
CREATE POLICY upr_select_own ON public.user_permitted_roles
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

-- Policy: Service role has full access (for triggers, admin operations)
DROP POLICY IF EXISTS upr_all_service_role ON public.user_permitted_roles;
CREATE POLICY upr_all_service_role ON public.user_permitted_roles
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant basic access to authenticated users (RLS enforces row-level)
GRANT SELECT ON public.user_permitted_roles TO authenticated;
GRANT ALL ON public.user_permitted_roles TO service_role;

COMMENT ON TABLE public.user_permitted_roles IS 'VTID-01230: Tracks which roles each user is permitted to use per tenant';

-- =============================================================================
-- B. Helper: check_role_permitted() — used by me_set_active_role
-- =============================================================================

CREATE OR REPLACE FUNCTION public.check_role_permitted(
    p_user_id UUID,
    p_tenant_id UUID,
    p_role TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_exafy_admin BOOLEAN;
    v_permitted BOOLEAN;
BEGIN
    -- Check if user is exafy_admin (super admin bypass)
    SELECT COALESCE(
        (raw_app_meta_data->>'exafy_admin')::BOOLEAN,
        false
    ) INTO v_is_exafy_admin
    FROM auth.users
    WHERE id = p_user_id;

    IF v_is_exafy_admin THEN
        RETURN true;
    END IF;

    -- Check user_permitted_roles table
    SELECT EXISTS(
        SELECT 1
        FROM public.user_permitted_roles
        WHERE user_id = p_user_id
          AND tenant_id = p_tenant_id
          AND role = p_role
    ) INTO v_permitted;

    RETURN v_permitted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_role_permitted(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_role_permitted(UUID, UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.check_role_permitted IS 'VTID-01230: Returns true if user is permitted to use the given role (exafy_admin always true)';

-- =============================================================================
-- C. Modify me_set_active_role() — add permission check
-- =============================================================================

CREATE OR REPLACE FUNCTION public.me_set_active_role(p_role TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_permitted BOOLEAN;
    v_allowed_roles TEXT[] := ARRAY['community', 'patient', 'professional', 'staff', 'admin', 'developer', 'infra'];
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
            'message', 'Role must be one of: community, patient, professional, staff, admin, developer, infra'
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
$$;

-- =============================================================================
-- D. Modify provision_platform_user() — grant 'community' role on signup
-- =============================================================================

CREATE OR REPLACE FUNCTION public.provision_platform_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_slug TEXT;
    v_tenant_id UUID;
    v_display_name TEXT;
    v_email TEXT;
BEGIN
    v_email := NEW.email;
    v_tenant_slug := NEW.raw_user_meta_data ->> 'tenant_slug';

    -- Derive display name
    v_display_name := COALESCE(
        NEW.raw_user_meta_data ->> 'display_name',
        NEW.raw_user_meta_data ->> 'full_name',
        split_part(v_email, '@', 1)
    );

    -- Resolve tenant by slug
    IF v_tenant_slug IS NOT NULL THEN
        SELECT t.tenant_id INTO v_tenant_id
        FROM public.tenants t
        WHERE t.slug = v_tenant_slug
        LIMIT 1;
    END IF;

    -- Fallback: oldest tenant
    IF v_tenant_id IS NULL THEN
        SELECT t.tenant_id INTO v_tenant_id
        FROM public.tenants t
        ORDER BY t.created_at ASC
        LIMIT 1;
    END IF;

    -- Create app_users row (the backend user registry)
    INSERT INTO public.app_users (user_id, email, display_name, tenant_id)
    VALUES (NEW.id, v_email, v_display_name, v_tenant_id)
    ON CONFLICT (user_id) DO UPDATE SET
        email = EXCLUDED.email,
        display_name = COALESCE(EXCLUDED.display_name, public.app_users.display_name),
        tenant_id = COALESCE(EXCLUDED.tenant_id, public.app_users.tenant_id),
        updated_at = NOW();

    -- Create user_tenants row (is_primary=true triggers live room creation)
    IF v_tenant_id IS NOT NULL THEN
        INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
        VALUES (v_tenant_id, NEW.id, 'community', true)
        ON CONFLICT (tenant_id, user_id) DO NOTHING;

        -- VTID-01230: Grant default 'community' role permission
        INSERT INTO public.user_permitted_roles (user_id, tenant_id, role, granted_by)
        VALUES (NEW.id, v_tenant_id, 'community', NULL)
        ON CONFLICT (user_id, tenant_id, role) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

-- Ensure trigger exists (idempotent)
DROP TRIGGER IF EXISTS on_auth_user_platform_provision ON auth.users;
CREATE TRIGGER on_auth_user_platform_provision
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.provision_platform_user();

-- =============================================================================
-- E. Backfill: Grant 'community' to ALL existing users who don't have it
-- =============================================================================

DO $$
DECLARE
    v_user RECORD;
    v_count INT := 0;
BEGIN
    FOR v_user IN
        SELECT ut.user_id, ut.tenant_id
        FROM public.user_tenants ut
        LEFT JOIN public.user_permitted_roles upr
            ON upr.user_id = ut.user_id
            AND upr.tenant_id = ut.tenant_id
            AND upr.role = 'community'
        WHERE upr.id IS NULL
    LOOP
        INSERT INTO public.user_permitted_roles (user_id, tenant_id, role, granted_by)
        VALUES (v_user.user_id, v_user.tenant_id, 'community', NULL)
        ON CONFLICT (user_id, tenant_id, role) DO NOTHING;

        v_count := v_count + 1;
    END LOOP;

    RAISE NOTICE 'VTID-01230: Backfilled community role for % users', v_count;
END;
$$;

-- =============================================================================
-- F. Seed: Grant ALL roles to exafy_admin users
-- =============================================================================

DO $$
DECLARE
    v_admin RECORD;
    v_role TEXT;
    v_all_roles TEXT[] := ARRAY['community', 'patient', 'professional', 'staff', 'admin', 'developer', 'infra'];
    v_count INT := 0;
BEGIN
    FOR v_admin IN
        SELECT au.id AS user_id, ut.tenant_id
        FROM auth.users au
        JOIN public.user_tenants ut ON ut.user_id = au.id
        WHERE COALESCE((au.raw_app_meta_data->>'exafy_admin')::BOOLEAN, false) = true
    LOOP
        FOREACH v_role IN ARRAY v_all_roles LOOP
            INSERT INTO public.user_permitted_roles (user_id, tenant_id, role, granted_by)
            VALUES (v_admin.user_id, v_admin.tenant_id, v_role, v_admin.user_id)
            ON CONFLICT (user_id, tenant_id, role) DO NOTHING;

            v_count := v_count + 1;
        END LOOP;
    END LOOP;

    RAISE NOTICE 'VTID-01230: Seeded % role permissions for exafy_admin users', v_count;
END;
$$;

-- =============================================================================
-- G. RPC: get_my_permitted_roles() — returns caller's permitted roles
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_my_permitted_roles()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_is_exafy_admin BOOLEAN;
    v_roles TEXT[];
    v_all_roles TEXT[] := ARRAY['community', 'patient', 'professional', 'staff', 'admin', 'developer', 'infra'];
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
$$;

GRANT EXECUTE ON FUNCTION public.get_my_permitted_roles() TO authenticated;

COMMENT ON FUNCTION public.get_my_permitted_roles IS 'VTID-01230: Returns the list of roles the current user is permitted to use';

COMMIT;
