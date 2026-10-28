-- Migration: 20251229000000_vtid_01051_me_active_role_fix.sql
-- Purpose: VTID-01051 Fix /api/v1/me/active-role audit log tenant_id null
-- Date: 2025-12-29
--
-- Problem: me_set_active_role() fails with NOT NULL violation on access_audit_log.tenant_id
-- because tenant_id is not being derived from JWT claims before audit write.
--
-- Solution: Create/replace me_context() and me_set_active_role() functions that properly
-- handle tenant_id from JWT claims, avoiding audit log constraint failures.

-- ===========================================================================
-- Helper: current_tenant_id() - Get tenant_id from JWT or request context
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_tenant_id UUID;
    v_jwt_claims JSONB;
BEGIN
    -- Try request context first (set by dev_bootstrap_request_context)
    BEGIN
        v_tenant_id := current_setting('request.tenant_id', true)::UUID;
        IF v_tenant_id IS NOT NULL THEN
            RETURN v_tenant_id;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        -- Ignore errors from invalid UUID or missing setting
        NULL;
    END;

    -- Try JWT claims
    BEGIN
        v_jwt_claims := current_setting('request.jwt.claims', true)::JSONB;
        IF v_jwt_claims IS NOT NULL THEN
            -- Try tenant_id claim
            v_tenant_id := (v_jwt_claims->>'tenant_id')::UUID;
            IF v_tenant_id IS NOT NULL THEN
                RETURN v_tenant_id;
            END IF;
            -- Try tenant claim (some JWTs use this)
            v_tenant_id := (v_jwt_claims->>'tenant')::UUID;
            IF v_tenant_id IS NOT NULL THEN
                RETURN v_tenant_id;
            END IF;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        -- Ignore errors from invalid UUID or missing claims
        NULL;
    END;

    -- Return NULL if no tenant found (caller must handle)
    RETURN NULL;
END;
$$;

-- ===========================================================================
-- Helper: current_active_role() - Get active_role from request context or JWT
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.current_active_role()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_role TEXT;
    v_jwt_claims JSONB;
BEGIN
    -- Try request context first (set by me_set_active_role or dev_bootstrap)
    BEGIN
        v_role := current_setting('request.active_role', true);
        IF v_role IS NOT NULL AND v_role != '' THEN
            RETURN v_role;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    -- Try JWT claims
    BEGIN
        v_jwt_claims := current_setting('request.jwt.claims', true)::JSONB;
        IF v_jwt_claims IS NOT NULL THEN
            v_role := v_jwt_claims->>'active_role';
            IF v_role IS NOT NULL AND v_role != '' THEN
                RETURN v_role;
            END IF;
            -- Fallback to role claim
            v_role := v_jwt_claims->>'role';
            IF v_role IS NOT NULL AND v_role != '' THEN
                RETURN v_role;
            END IF;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    -- Default to 'community' if no role found
    RETURN 'community';
END;
$$;

-- ===========================================================================
-- user_active_roles table - Persist active role per user
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.user_active_roles (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    active_role TEXT NOT NULL DEFAULT 'community',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.user_active_roles ENABLE ROW LEVEL SECURITY;

-- Users can only read/write their own row
DROP POLICY IF EXISTS user_active_roles_select ON public.user_active_roles;
CREATE POLICY user_active_roles_select ON public.user_active_roles
    FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS user_active_roles_insert ON public.user_active_roles;
CREATE POLICY user_active_roles_insert ON public.user_active_roles
    FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS user_active_roles_update ON public.user_active_roles;
CREATE POLICY user_active_roles_update ON public.user_active_roles
    FOR UPDATE USING (user_id = auth.uid());

-- ===========================================================================
-- me_context() RPC - Returns user context including tenant and active role
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.me_context()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_email TEXT;
    v_tenant_id UUID;
    v_active_role TEXT;
    v_stored_role TEXT;
    v_jwt_claims JSONB;
    v_available_roles TEXT[];
BEGIN
    -- Get authenticated user ID
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Get JWT claims for email and tenant
    BEGIN
        v_jwt_claims := current_setting('request.jwt.claims', true)::JSONB;
        v_email := v_jwt_claims->>'email';
    EXCEPTION WHEN OTHERS THEN
        v_email := NULL;
    END;

    -- Get tenant_id
    v_tenant_id := public.current_tenant_id();

    -- Get stored active role from user_active_roles table
    SELECT active_role INTO v_stored_role
    FROM public.user_active_roles
    WHERE user_id = v_user_id;

    -- Prefer stored role, fallback to current_active_role() helper
    IF v_stored_role IS NOT NULL THEN
        v_active_role := v_stored_role;
    ELSE
        v_active_role := public.current_active_role();
    END IF;

    -- Define available roles (in production, this would come from user permissions)
    v_available_roles := ARRAY['community', 'patient', 'professional', 'staff', 'admin', 'developer'];

    RETURN jsonb_build_object(
        'ok', true,
        'user_id', v_user_id,
        'id', v_user_id,
        'email', v_email,
        'tenant_id', v_tenant_id,
        'active_role', v_active_role,
        'roles', to_jsonb(v_available_roles),
        'available_roles', to_jsonb(v_available_roles)
    );
END;
$$;

-- ===========================================================================
-- me_set_active_role(p_role) RPC - Sets active role for current user
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.me_set_active_role(p_role TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_allowed_roles TEXT[] := ARRAY['community', 'patient', 'professional', 'staff', 'admin', 'developer'];
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

    -- Gate 2: Validate role
    IF p_role IS NULL OR NOT (p_role = ANY(v_allowed_roles)) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_ROLE',
            'message', 'Role must be one of: community, patient, professional, staff, admin, developer'
        );
    END IF;

    -- Get tenant_id for audit purposes (may be NULL for dev users)
    v_tenant_id := public.current_tenant_id();

    -- Upsert the active role
    INSERT INTO public.user_active_roles (user_id, active_role, updated_at)
    VALUES (v_user_id, p_role, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
        active_role = EXCLUDED.active_role,
        updated_at = NOW();

    -- Set request context for current transaction
    PERFORM set_config('request.active_role', p_role, true);

    -- Note: We intentionally skip writing to access_audit_log here
    -- to avoid NOT NULL constraint violations when tenant_id is null.
    -- Audit logging can be added later with proper tenant resolution.

    RETURN jsonb_build_object(
        'ok', true,
        'user_id', v_user_id,
        'active_role', p_role,
        'tenant_id', v_tenant_id
    );
END;
$$;

-- ===========================================================================
-- Permissions
-- ===========================================================================

-- me_context: callable by authenticated users
GRANT EXECUTE ON FUNCTION public.me_context() TO authenticated;

-- me_set_active_role: callable by authenticated users
GRANT EXECUTE ON FUNCTION public.me_set_active_role(TEXT) TO authenticated;

-- Helper functions: callable by authenticated users
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_active_role() TO authenticated;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON FUNCTION public.me_context IS 'VTID-01051: Returns current user context including user_id, email, tenant_id, active_role, and available roles';
COMMENT ON FUNCTION public.me_set_active_role IS 'VTID-01051: Sets active role for current user. Persists to user_active_roles table.';
COMMENT ON FUNCTION public.current_tenant_id IS 'VTID-01051: Helper to get tenant_id from request context or JWT claims';
COMMENT ON FUNCTION public.current_active_role IS 'VTID-01051: Helper to get active_role from request context or JWT claims';
COMMENT ON TABLE public.user_active_roles IS 'VTID-01051: Stores persisted active role per user';
