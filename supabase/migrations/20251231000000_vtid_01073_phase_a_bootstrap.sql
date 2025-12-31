-- Migration: 20251231000000_vtid_01073_phase_a_bootstrap.sql
-- Purpose: VTID-01073 Phase A-Fix: Multi-Tenant + User Bootstrap for Memory (DB only)
-- Date: 2025-12-31
--
-- This migration establishes the canonical bootstrap primitives for multi-tenant
-- isolation in Vitana's memory/health layer:
--   - tenants: Registry of all tenants (Maxina, Alkalma, Earthlings, etc.)
--   - app_users: Registry of application users (mirrors auth.users for RLS)
--   - user_tenants: M:N mapping of users to tenants with active_role per membership
--   - current_user_id(): Deterministic helper to get user_id from context
--   - dev_set_request_context(): Dev helper to set full context (tenant, user, role)
--
-- Non-goals: No Gateway changes. No UI. No breaking changes. Additive only.
--
-- OASIS Registration Commands (run manually if gateway accessible):
--   curl -sS -X POST "$GATEWAY_URL/api/v1/events/ingest" -H "Content-Type: application/json" -d '{
--     "vtid":"VTID-01073",
--     "type":"vtid.lifecycle.start",
--     "source":"claude.worker",
--     "status":"in_progress",
--     "message":"Phase A-Fix: DB bootstrap primitives for tenants/users/roles + deterministic context helper functions (DB-only).",
--     "payload":{"scope":"supabase_only","phase":"A-Fix"}
--   }'

-- ===========================================================================
-- 1. TENANTS TABLE
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for slug lookups
CREATE INDEX IF NOT EXISTS idx_tenants_slug ON public.tenants (slug);

-- Enable RLS (service_role bypass, authenticated read)
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_select_authenticated ON public.tenants;
CREATE POLICY tenants_select_authenticated ON public.tenants
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS tenants_all_service_role ON public.tenants;
CREATE POLICY tenants_all_service_role ON public.tenants
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.tenants IS 'VTID-01073: Registry of all tenants in the Vitana platform';

-- ===========================================================================
-- 2. APP_USERS TABLE
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.app_users (
    user_id UUID PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    display_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Note: user_id intentionally does NOT reference auth.users(id) directly
-- to allow pre-provisioning users before they sign up via auth.

-- Index for email lookups
CREATE INDEX IF NOT EXISTS idx_app_users_email ON public.app_users (email);

-- Enable RLS
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;

-- Users can read their own row
DROP POLICY IF EXISTS app_users_select_own ON public.app_users;
CREATE POLICY app_users_select_own ON public.app_users
    FOR SELECT TO authenticated USING (user_id = auth.uid());

-- Service role can do all
DROP POLICY IF EXISTS app_users_all_service_role ON public.app_users;
CREATE POLICY app_users_all_service_role ON public.app_users
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.app_users IS 'VTID-01073: Registry of application users (mirrors or pre-provisions auth.users)';

-- ===========================================================================
-- 3. USER_TENANTS TABLE (M:N with active_role)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.user_tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,
    active_role TEXT NOT NULL DEFAULT 'community',
    is_primary BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id)
);

-- Indexes for lookups
CREATE INDEX IF NOT EXISTS idx_user_tenants_tenant ON public.user_tenants (tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_tenants_user ON public.user_tenants (user_id);
CREATE INDEX IF NOT EXISTS idx_user_tenants_role ON public.user_tenants (active_role);

-- Enable RLS with strict tenant isolation
ALTER TABLE public.user_tenants ENABLE ROW LEVEL SECURITY;

-- Users can only see their own memberships
DROP POLICY IF EXISTS user_tenants_select_own ON public.user_tenants;
CREATE POLICY user_tenants_select_own ON public.user_tenants
    FOR SELECT TO authenticated USING (user_id = auth.uid());

-- Users can update their own membership (e.g., switch active_role)
DROP POLICY IF EXISTS user_tenants_update_own ON public.user_tenants;
CREATE POLICY user_tenants_update_own ON public.user_tenants
    FOR UPDATE TO authenticated USING (user_id = auth.uid());

-- Service role can do all
DROP POLICY IF EXISTS user_tenants_all_service_role ON public.user_tenants;
CREATE POLICY user_tenants_all_service_role ON public.user_tenants
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.user_tenants IS 'VTID-01073: M:N mapping of users to tenants with active_role per membership';

-- ===========================================================================
-- 4. DETERMINISTIC CONTEXT HELPER: current_user_id()
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_user_id UUID;
    v_jwt_claims JSONB;
BEGIN
    -- Priority 1: Try request context (set by dev_set_request_context or backend)
    BEGIN
        v_user_id := current_setting('request.user_id', true)::UUID;
        IF v_user_id IS NOT NULL THEN
            RETURN v_user_id;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        -- Ignore errors from invalid UUID or missing setting
        NULL;
    END;

    -- Priority 2: Try auth.uid() (Supabase authenticated user)
    BEGIN
        v_user_id := auth.uid();
        IF v_user_id IS NOT NULL THEN
            RETURN v_user_id;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    -- Priority 3: Try JWT claims user_id/sub
    BEGIN
        v_jwt_claims := current_setting('request.jwt.claims', true)::JSONB;
        IF v_jwt_claims IS NOT NULL THEN
            -- Try user_id claim
            v_user_id := (v_jwt_claims->>'user_id')::UUID;
            IF v_user_id IS NOT NULL THEN
                RETURN v_user_id;
            END IF;
            -- Try sub claim
            v_user_id := (v_jwt_claims->>'sub')::UUID;
            IF v_user_id IS NOT NULL THEN
                RETURN v_user_id;
            END IF;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    -- Return NULL if no user found (caller must handle)
    RETURN NULL;
END;
$$;

-- Grant to authenticated and service_role
GRANT EXECUTE ON FUNCTION public.current_user_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_id() TO service_role;

COMMENT ON FUNCTION public.current_user_id IS 'VTID-01073: Get user_id from request context, auth.uid(), or JWT claims';

-- ===========================================================================
-- 5. DEV HELPER: dev_set_request_context (SQL Editor / testing)
-- ===========================================================================
-- Sets all three context GUCs in one call. Only for SQL Editor sanity checks.
-- Production code should use the backend to set context appropriately.

CREATE OR REPLACE FUNCTION public.dev_set_request_context(
    p_tenant_id UUID,
    p_user_id UUID,
    p_active_role TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_allowed_roles TEXT[] := ARRAY['community', 'patient', 'professional', 'staff', 'admin', 'developer'];
BEGIN
    -- Gate 1: Validate tenant_id is not null
    IF p_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_TENANT_ID',
            'message', 'tenant_id cannot be null'
        );
    END IF;

    -- Gate 2: Validate user_id is not null
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_USER_ID',
            'message', 'user_id cannot be null'
        );
    END IF;

    -- Gate 3: Validate active_role is one of the allowed roles
    IF p_active_role IS NULL OR NOT (p_active_role = ANY(v_allowed_roles)) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_ROLE',
            'message', 'active_role must be one of: community, patient, professional, staff, admin, developer'
        );
    END IF;

    -- Set all request context GUCs (transaction-local, true = local to transaction)
    PERFORM set_config('request.tenant_id', p_tenant_id::TEXT, true);
    PERFORM set_config('request.user_id', p_user_id::TEXT, true);
    PERFORM set_config('request.active_role', p_active_role, true);

    -- Return success with all context values
    RETURN jsonb_build_object(
        'ok', true,
        'tenant_id', p_tenant_id::TEXT,
        'user_id', p_user_id::TEXT,
        'active_role', p_active_role,
        'context', jsonb_build_object(
            'current_tenant_id', public.current_tenant_id(),
            'current_user_id', public.current_user_id(),
            'current_active_role', public.current_active_role()
        )
    );
END;
$$;

-- Security: Only service_role can execute this function
REVOKE ALL ON FUNCTION public.dev_set_request_context(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.dev_set_request_context(UUID, UUID, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.dev_set_request_context(UUID, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.dev_set_request_context(UUID, UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.dev_set_request_context IS 'VTID-01073: Dev helper to set full request context (tenant_id, user_id, active_role). Only callable by service_role.';

-- ===========================================================================
-- 6. SEED DATA: Canonical Tenants
-- ===========================================================================

INSERT INTO public.tenants (id, slug, name)
VALUES
    ('11111111-1111-1111-1111-111111111111', 'maxina', 'Maxina'),
    ('22222222-2222-2222-2222-222222222222', 'alkalma', 'Alkalma'),
    ('33333333-3333-3333-3333-333333333333', 'earthlings', 'Earthlings')
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name,
    updated_at = NOW();

-- ===========================================================================
-- 7. SEED DATA: Bootstrap User (Dragan - platform admin)
-- ===========================================================================
-- Note: If Dragan's auth user_id is known, insert it here.
-- Using a deterministic UUID based on email for pre-provisioning.

DO $$
DECLARE
    v_dragan_email TEXT := 'dragan@vitana.ai';
    v_dragan_user_id UUID;
    v_maxina_tenant_id UUID := '11111111-1111-1111-1111-111111111111';
BEGIN
    -- Try to get Dragan's user_id from auth.users if exists
    SELECT id INTO v_dragan_user_id
    FROM auth.users
    WHERE email = v_dragan_email
    LIMIT 1;

    -- If not found, generate deterministic UUID from email
    IF v_dragan_user_id IS NULL THEN
        v_dragan_user_id := uuid_generate_v5(
            uuid_generate_v4(), -- namespace (fallback to random if uuid_ns_url not available)
            v_dragan_email
        );
        -- Use a deterministic fallback
        v_dragan_user_id := 'dddddddd-dddd-dddd-dddd-dddddddddddd'::UUID;
    END IF;

    -- Insert/update app_users
    INSERT INTO public.app_users (user_id, email, display_name)
    VALUES (v_dragan_user_id, v_dragan_email, 'Dragan')
    ON CONFLICT (email) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        updated_at = NOW();

    -- Re-fetch user_id in case ON CONFLICT triggered
    SELECT user_id INTO v_dragan_user_id
    FROM public.app_users
    WHERE email = v_dragan_email;

    -- Insert user_tenants membership with developer role
    INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
    VALUES (v_maxina_tenant_id, v_dragan_user_id, 'developer', true)
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET
        active_role = EXCLUDED.active_role,
        is_primary = EXCLUDED.is_primary,
        updated_at = NOW();

    RAISE NOTICE 'Bootstrap user created: % (user_id: %) with developer role in Maxina', v_dragan_email, v_dragan_user_id;
END $$;

-- ===========================================================================
-- 8. VERIFICATION QUERIES
-- ===========================================================================
-- Run these in SQL Editor to verify the migration succeeded.

-- 8.1 Verify tenants exist
DO $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count FROM public.tenants WHERE slug IN ('maxina', 'alkalma', 'earthlings');
    IF v_count = 3 THEN
        RAISE NOTICE 'VERIFY OK: All 3 canonical tenants exist (Maxina, Alkalma, Earthlings)';
    ELSE
        RAISE WARNING 'VERIFY FAIL: Expected 3 tenants, found %', v_count;
    END IF;
END $$;

-- 8.2 Verify Dragan user exists
DO $$
DECLARE
    v_email TEXT;
    v_user_id UUID;
BEGIN
    SELECT email, user_id INTO v_email, v_user_id
    FROM public.app_users
    WHERE email = 'dragan@vitana.ai';

    IF v_email IS NOT NULL THEN
        RAISE NOTICE 'VERIFY OK: Dragan user exists (user_id: %)', v_user_id;
    ELSE
        RAISE WARNING 'VERIFY FAIL: Dragan user not found';
    END IF;
END $$;

-- 8.3 Verify dev_set_request_context makes current_* helpers return non-null
DO $$
DECLARE
    v_result JSONB;
    v_tenant_id UUID;
    v_user_id UUID;
    v_active_role TEXT;
BEGIN
    -- Set context
    v_result := public.dev_set_request_context(
        '11111111-1111-1111-1111-111111111111'::UUID,
        'dddddddd-dddd-dddd-dddd-dddddddddddd'::UUID,
        'developer'
    );

    IF (v_result->>'ok')::BOOLEAN THEN
        v_tenant_id := public.current_tenant_id();
        v_user_id := public.current_user_id();
        v_active_role := public.current_active_role();

        IF v_tenant_id IS NOT NULL AND v_user_id IS NOT NULL AND v_active_role IS NOT NULL THEN
            RAISE NOTICE 'VERIFY OK: dev_set_request_context works. tenant=%, user=%, role=%', v_tenant_id, v_user_id, v_active_role;
        ELSE
            RAISE WARNING 'VERIFY FAIL: current_* helpers returned NULL after setting context';
        END IF;
    ELSE
        RAISE WARNING 'VERIFY FAIL: dev_set_request_context returned error: %', v_result->>'message';
    END IF;
END $$;

-- ===========================================================================
-- 9. OASIS SUCCESS EVENT (run manually if gateway accessible)
-- ===========================================================================
-- curl -sS -X POST "$GATEWAY_URL/api/v1/events/ingest" -H "Content-Type: application/json" -d '{
--   "vtid":"VTID-01073",
--   "type":"vtid.stage.worker.success",
--   "source":"claude.worker",
--   "status":"success",
--   "message":"Phase A-Fix complete: bootstrap tables + deterministic current_* context helpers committed (DB-only).",
--   "payload":{"deliverables":["VTID-01073 migration SQL committed","current_tenant_id/current_user_id/current_active_role helpers","dev_set_request_context helper"]}
-- }'

-- ===========================================================================
-- Migration Complete
-- ===========================================================================
