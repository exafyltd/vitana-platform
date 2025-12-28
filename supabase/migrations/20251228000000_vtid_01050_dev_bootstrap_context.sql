-- Migration: 20251228000000_vtid_01050_dev_bootstrap_context.sql
-- Purpose: VTID-01050 Dev Auth Bootstrap - Break the NULL-role deadlock
-- Date: 2025-12-28
--
-- Problem: dev_set_request_context requires is_platform_admin() which requires
-- current_active_role() to be non-NULL. But current_active_role() is NULL at
-- bootstrap time, creating a deadlock.
--
-- Solution: Create dev_bootstrap_request_context which bypasses the admin check
-- and is only callable by service_role.

-- ===========================================================================
-- dev_bootstrap_request_context RPC (SECURITY DEFINER)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.dev_bootstrap_request_context(
    p_tenant_id UUID,
    p_active_role TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_allowed_roles TEXT[] := ARRAY['developer', 'admin', 'staff'];
BEGIN
    -- Gate 1: Validate tenant_id is not null
    IF p_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_TENANT_ID',
            'message', 'tenant_id cannot be null'
        );
    END IF;

    -- Gate 2: Validate active_role is one of the allowed dev roles
    IF p_active_role IS NULL OR NOT (p_active_role = ANY(v_allowed_roles)) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_ROLE',
            'message', 'active_role must be one of: developer, admin, staff'
        );
    END IF;

    -- Set request context (transaction-local, true = local to transaction)
    PERFORM set_config('request.tenant_id', p_tenant_id::TEXT, true);
    PERFORM set_config('request.active_role', p_active_role, true);

    -- Return success
    RETURN jsonb_build_object(
        'ok', true,
        'tenant_id', p_tenant_id::TEXT,
        'active_role', p_active_role
    );
END;
$$;

-- ===========================================================================
-- Security: Only service_role can execute this function
-- ===========================================================================

-- First revoke from public (which includes anon and authenticated)
REVOKE ALL ON FUNCTION public.dev_bootstrap_request_context(UUID, TEXT) FROM PUBLIC;

-- Explicitly revoke from anon and authenticated roles
REVOKE EXECUTE ON FUNCTION public.dev_bootstrap_request_context(UUID, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.dev_bootstrap_request_context(UUID, TEXT) FROM authenticated;

-- Grant only to service_role
GRANT EXECUTE ON FUNCTION public.dev_bootstrap_request_context(UUID, TEXT) TO service_role;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON FUNCTION public.dev_bootstrap_request_context IS 'VTID-01050: Bootstrap request context for dev auth. Bypasses is_platform_admin() check. Only callable by service_role.';
