-- mt-identity-r2 / helpers-and-policy-rewrite (VTID-05465) — throwaway-Postgres fixture: the OLD current_tenant_id().
-- Replaces the 20260218 body from mt_identity_helpers_fixture.sql with the body of
-- 20251229000000_vtid_01051_me_active_role_fix.sql:15-58, verbatim. That body reads only the request.tenant_id setting
-- and the top-level tenant_id / tenant claims, so a browser JWT resolves to NULL.
-- Order: mt_identity_helpers_fixture.sql, then this file, then 20261102030000 (helpers), then 20261102030100 (rewrite),
-- which must REFUSE, then mt_identity_helpers_live_body_guard.test.sql. Local throwaway database only; never a shared
-- or live one.

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
