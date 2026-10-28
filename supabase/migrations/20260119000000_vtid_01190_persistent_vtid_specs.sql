-- Migration: 20260119000000_vtid_01190_persistent_vtid_specs.sql
-- Purpose: VTID-01190 Persistent VTID Specs + Immutable Snapshot Pipeline
-- Date: 2026-01-19
--
-- This migration establishes the persistence layer for VTID specifications:
--   - vtid_specs: Immutable VTID specification snapshots
--   - RLS enforcement by tenant_id
--   - Checksum-based integrity verification
--
-- HARD GOVERNANCE RULES:
--   1. No VTID may execute without a persisted spec
--   2. Spec snapshot is immutable after lock
--   3. Autopilot, Validator, Verification must read from DB
--   4. Checksum mismatch → hard fail
--   5. RLS enforced by tenant
--
-- Non-negotiables: SYS-RULE-DEPLOY-L1, spec immutability, additive-only APIs

-- ===========================================================================
-- 1. VTID_SPECS TABLE
-- ===========================================================================
-- One row per VTID - immutable after locked_at timestamp

CREATE TABLE IF NOT EXISTS public.vtid_specs (
    -- Primary key: VTID identifier
    vtid TEXT PRIMARY KEY,

    -- Tenant isolation (RLS enforced)
    tenant_id TEXT NOT NULL,

    -- Spec versioning (for future schema evolution)
    spec_version INTEGER NOT NULL DEFAULT 1 CHECK (spec_version >= 1),

    -- The actual specification content (immutable after lock)
    spec_content JSONB NOT NULL,

    -- SHA-256 checksum for integrity verification
    -- Format: hex-encoded SHA-256 hash of spec_content JSON
    spec_checksum TEXT NOT NULL CHECK (length(spec_checksum) = 64),

    -- Primary domain classification for routing/validation
    -- E.g., 'frontend', 'backend', 'database', 'infrastructure', 'governance'
    primary_domain TEXT NOT NULL,

    -- System surfaces affected (for impact analysis)
    -- E.g., ['gateway', 'frontend', 'oasis']
    system_surface TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- IMMUTABILITY BOUNDARY: No modifications allowed after this timestamp
    locked_at TIMESTAMPTZ NOT NULL,

    -- Attribution
    created_by TEXT NOT NULL,

    -- Metadata for extensibility (but core fields are NOT optional)
    metadata JSONB DEFAULT '{}'::jsonb
);

-- ===========================================================================
-- 2. INDEXES
-- ===========================================================================

-- Tenant lookup (required for RLS queries)
CREATE INDEX IF NOT EXISTS idx_vtid_specs_tenant_id ON public.vtid_specs (tenant_id);

-- Domain-based queries
CREATE INDEX IF NOT EXISTS idx_vtid_specs_primary_domain ON public.vtid_specs (primary_domain);

-- Checksum lookup for integrity verification
CREATE INDEX IF NOT EXISTS idx_vtid_specs_checksum ON public.vtid_specs (spec_checksum);

-- Time-based queries
CREATE INDEX IF NOT EXISTS idx_vtid_specs_created_at ON public.vtid_specs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vtid_specs_locked_at ON public.vtid_specs (locked_at DESC);

-- System surface queries (GIN for array containment)
CREATE INDEX IF NOT EXISTS idx_vtid_specs_system_surface ON public.vtid_specs USING GIN (system_surface);

-- ===========================================================================
-- 3. ROW LEVEL SECURITY
-- ===========================================================================

ALTER TABLE public.vtid_specs ENABLE ROW LEVEL SECURITY;

-- Service role gets full access (backend only)
DROP POLICY IF EXISTS vtid_specs_service_role ON public.vtid_specs;
CREATE POLICY vtid_specs_service_role ON public.vtid_specs
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- Authenticated users can read specs for their tenant only
DROP POLICY IF EXISTS vtid_specs_tenant_read ON public.vtid_specs;
CREATE POLICY vtid_specs_tenant_read ON public.vtid_specs
    FOR SELECT TO authenticated
    USING (
        tenant_id = COALESCE(
            current_setting('request.jwt.claims', true)::jsonb->>'tenant_id',
            current_setting('app.tenant_id', true)
        )
    );

-- ===========================================================================
-- 4. IMMUTABILITY ENFORCEMENT TRIGGER
-- ===========================================================================
-- Prevents any UPDATE or DELETE operations on locked specs

CREATE OR REPLACE FUNCTION public.enforce_vtid_spec_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Block DELETE operations entirely
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'VTID spec deletion is forbidden - specs are immutable (VTID: %)', OLD.vtid
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Block UPDATE operations on locked specs
    IF TG_OP = 'UPDATE' THEN
        IF OLD.locked_at IS NOT NULL AND OLD.locked_at <= NOW() THEN
            -- Only allow metadata updates (not core fields)
            IF OLD.spec_content IS DISTINCT FROM NEW.spec_content OR
               OLD.spec_checksum IS DISTINCT FROM NEW.spec_checksum OR
               OLD.primary_domain IS DISTINCT FROM NEW.primary_domain OR
               OLD.system_surface IS DISTINCT FROM NEW.system_surface OR
               OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR
               OLD.created_by IS DISTINCT FROM NEW.created_by OR
               OLD.created_at IS DISTINCT FROM NEW.created_at OR
               OLD.locked_at IS DISTINCT FROM NEW.locked_at THEN
                RAISE EXCEPTION 'VTID spec is immutable after lock - cannot modify core fields (VTID: %, locked_at: %)',
                    OLD.vtid, OLD.locked_at
                    USING ERRCODE = 'restrict_violation';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- Create the trigger
DROP TRIGGER IF EXISTS trigger_vtid_spec_immutability ON public.vtid_specs;
CREATE TRIGGER trigger_vtid_spec_immutability
    BEFORE UPDATE OR DELETE ON public.vtid_specs
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_vtid_spec_immutability();

COMMENT ON FUNCTION public.enforce_vtid_spec_immutability IS 'VTID-01190: Enforces immutability of VTID specs after lock timestamp';

-- ===========================================================================
-- 5. HELPER FUNCTION: create_vtid_spec
-- ===========================================================================
-- Creates a new VTID spec with automatic checksum generation and locking

CREATE OR REPLACE FUNCTION public.create_vtid_spec(
    p_vtid TEXT,
    p_tenant_id TEXT,
    p_spec_content JSONB,
    p_primary_domain TEXT,
    p_system_surface TEXT[],
    p_created_by TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS public.vtid_specs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_checksum TEXT;
    v_result public.vtid_specs;
BEGIN
    -- Validate required fields
    IF p_vtid IS NULL OR p_vtid = '' THEN
        RAISE EXCEPTION 'VTID cannot be null or empty';
    END IF;

    IF p_tenant_id IS NULL OR p_tenant_id = '' THEN
        RAISE EXCEPTION 'tenant_id cannot be null or empty';
    END IF;

    IF p_spec_content IS NULL THEN
        RAISE EXCEPTION 'spec_content cannot be null';
    END IF;

    IF p_primary_domain IS NULL OR p_primary_domain = '' THEN
        RAISE EXCEPTION 'primary_domain cannot be null or empty';
    END IF;

    -- Generate SHA-256 checksum of spec_content
    v_checksum := encode(digest(p_spec_content::text, 'sha256'), 'hex');

    -- Check if spec already exists (immutable - no overwrites)
    IF EXISTS (SELECT 1 FROM public.vtid_specs WHERE vtid = p_vtid) THEN
        -- Return existing spec instead of error (idempotent)
        SELECT * INTO v_result FROM public.vtid_specs WHERE vtid = p_vtid;
        RETURN v_result;
    END IF;

    -- Insert new spec (locked immediately)
    INSERT INTO public.vtid_specs (
        vtid,
        tenant_id,
        spec_version,
        spec_content,
        spec_checksum,
        primary_domain,
        system_surface,
        created_at,
        locked_at,
        created_by,
        metadata
    )
    VALUES (
        p_vtid,
        p_tenant_id,
        1,
        p_spec_content,
        v_checksum,
        p_primary_domain,
        COALESCE(p_system_surface, ARRAY[]::TEXT[]),
        NOW(),
        NOW(), -- Locked immediately upon creation
        p_created_by,
        p_metadata
    )
    RETURNING * INTO v_result;

    RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_vtid_spec(TEXT, TEXT, JSONB, TEXT, TEXT[], TEXT, JSONB) TO service_role;

COMMENT ON FUNCTION public.create_vtid_spec IS 'VTID-01190: Creates an immutable VTID spec with automatic checksum and locking';

-- ===========================================================================
-- 6. HELPER FUNCTION: verify_vtid_spec_checksum
-- ===========================================================================
-- Verifies the integrity of a VTID spec by recomputing checksum

CREATE OR REPLACE FUNCTION public.verify_vtid_spec_checksum(
    p_vtid TEXT
)
RETURNS TABLE (
    vtid TEXT,
    valid BOOLEAN,
    stored_checksum TEXT,
    computed_checksum TEXT,
    locked_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_spec public.vtid_specs;
    v_computed_checksum TEXT;
BEGIN
    -- Get the spec
    SELECT * INTO v_spec FROM public.vtid_specs s WHERE s.vtid = p_vtid;

    IF NOT FOUND THEN
        RETURN QUERY SELECT p_vtid, false, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Compute checksum
    v_computed_checksum := encode(digest(v_spec.spec_content::text, 'sha256'), 'hex');

    -- Return verification result
    RETURN QUERY SELECT
        p_vtid,
        v_spec.spec_checksum = v_computed_checksum,
        v_spec.spec_checksum,
        v_computed_checksum,
        v_spec.locked_at;
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_vtid_spec_checksum(TEXT) TO service_role;

COMMENT ON FUNCTION public.verify_vtid_spec_checksum IS 'VTID-01190: Verifies VTID spec integrity by recomputing SHA-256 checksum';

-- ===========================================================================
-- 7. HELPER FUNCTION: get_vtid_spec
-- ===========================================================================
-- Retrieves a VTID spec with optional checksum verification

CREATE OR REPLACE FUNCTION public.get_vtid_spec(
    p_vtid TEXT,
    p_verify_checksum BOOLEAN DEFAULT true
)
RETURNS TABLE (
    vtid TEXT,
    tenant_id TEXT,
    spec_version INTEGER,
    spec_content JSONB,
    spec_checksum TEXT,
    primary_domain TEXT,
    system_surface TEXT[],
    created_at TIMESTAMPTZ,
    locked_at TIMESTAMPTZ,
    created_by TEXT,
    metadata JSONB,
    checksum_valid BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_spec public.vtid_specs;
    v_checksum_valid BOOLEAN := true;
    v_computed_checksum TEXT;
BEGIN
    -- Get the spec
    SELECT * INTO v_spec FROM public.vtid_specs s WHERE s.vtid = p_vtid;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    -- Verify checksum if requested
    IF p_verify_checksum THEN
        v_computed_checksum := encode(digest(v_spec.spec_content::text, 'sha256'), 'hex');
        v_checksum_valid := v_spec.spec_checksum = v_computed_checksum;
    END IF;

    -- Return result
    RETURN QUERY SELECT
        v_spec.vtid,
        v_spec.tenant_id,
        v_spec.spec_version,
        v_spec.spec_content,
        v_spec.spec_checksum,
        v_spec.primary_domain,
        v_spec.system_surface,
        v_spec.created_at,
        v_spec.locked_at,
        v_spec.created_by,
        v_spec.metadata,
        v_checksum_valid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_vtid_spec(TEXT, BOOLEAN) TO service_role;

COMMENT ON FUNCTION public.get_vtid_spec IS 'VTID-01190: Retrieves VTID spec with optional checksum verification';

-- ===========================================================================
-- 8. HELPER FUNCTION: spec_exists
-- ===========================================================================
-- Checks if a VTID spec exists (for enforcement at runtime)

CREATE OR REPLACE FUNCTION public.vtid_spec_exists(
    p_vtid TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (SELECT 1 FROM public.vtid_specs WHERE vtid = p_vtid);
$$;

GRANT EXECUTE ON FUNCTION public.vtid_spec_exists(TEXT) TO service_role;

COMMENT ON FUNCTION public.vtid_spec_exists IS 'VTID-01190: Checks if a VTID spec exists (for runtime enforcement)';

-- ===========================================================================
-- 9. TABLE COMMENTS
-- ===========================================================================

COMMENT ON TABLE public.vtid_specs IS 'VTID-01190: Immutable VTID specifications - execution contracts not documentation';
COMMENT ON COLUMN public.vtid_specs.vtid IS 'VTID identifier - primary key, one spec per VTID';
COMMENT ON COLUMN public.vtid_specs.tenant_id IS 'Tenant ID for RLS isolation';
COMMENT ON COLUMN public.vtid_specs.spec_version IS 'Schema version for future evolution (starts at 1)';
COMMENT ON COLUMN public.vtid_specs.spec_content IS 'Full specification content as JSONB (immutable after lock)';
COMMENT ON COLUMN public.vtid_specs.spec_checksum IS 'SHA-256 hex checksum of spec_content for integrity verification';
COMMENT ON COLUMN public.vtid_specs.primary_domain IS 'Primary domain classification (frontend, backend, database, etc.)';
COMMENT ON COLUMN public.vtid_specs.system_surface IS 'Array of system surfaces affected by this spec';
COMMENT ON COLUMN public.vtid_specs.created_at IS 'Timestamp when spec was created';
COMMENT ON COLUMN public.vtid_specs.locked_at IS 'Immutability boundary - no modifications after this timestamp';
COMMENT ON COLUMN public.vtid_specs.created_by IS 'User/system that created the spec';
COMMENT ON COLUMN public.vtid_specs.metadata IS 'Extensible metadata (only field modifiable after lock)';

-- ===========================================================================
-- 10. VERIFICATION QUERIES
-- ===========================================================================

-- 10.1 Verify table exists with correct structure
DO $$
DECLARE
    v_exists BOOLEAN;
    v_column_count INTEGER;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'vtid_specs'
    ) INTO v_exists;

    SELECT COUNT(*) INTO v_column_count
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'vtid_specs';

    IF v_exists AND v_column_count >= 11 THEN
        RAISE NOTICE 'VERIFY OK: vtid_specs table exists with % columns', v_column_count;
    ELSE
        RAISE WARNING 'VERIFY FAIL: vtid_specs table missing or incomplete. exists=%, columns=%',
            v_exists, v_column_count;
    END IF;
END $$;

-- 10.2 Verify RLS is enabled
DO $$
DECLARE
    v_rls_enabled BOOLEAN;
BEGIN
    SELECT relrowsecurity INTO v_rls_enabled
    FROM pg_class WHERE relname = 'vtid_specs';

    IF v_rls_enabled THEN
        RAISE NOTICE 'VERIFY OK: RLS enabled on vtid_specs';
    ELSE
        RAISE WARNING 'VERIFY FAIL: RLS not enabled on vtid_specs';
    END IF;
END $$;

-- 10.3 Verify functions exist
DO $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname IN (
          'create_vtid_spec',
          'verify_vtid_spec_checksum',
          'get_vtid_spec',
          'vtid_spec_exists',
          'enforce_vtid_spec_immutability'
      );

    IF v_count = 5 THEN
        RAISE NOTICE 'VERIFY OK: All 5 helper functions exist';
    ELSE
        RAISE WARNING 'VERIFY FAIL: Expected 5 functions, found %', v_count;
    END IF;
END $$;

-- 10.4 Verify trigger exists
DO $$
DECLARE
    v_exists BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trigger_vtid_spec_immutability'
    ) INTO v_exists;

    IF v_exists THEN
        RAISE NOTICE 'VERIFY OK: Immutability trigger exists';
    ELSE
        RAISE WARNING 'VERIFY FAIL: Immutability trigger not found';
    END IF;
END $$;

-- 10.5 Verify indexes exist
DO $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM pg_indexes
    WHERE tablename = 'vtid_specs' AND schemaname = 'public';

    IF v_count >= 6 THEN
        RAISE NOTICE 'VERIFY OK: % indexes exist on vtid_specs', v_count;
    ELSE
        RAISE WARNING 'VERIFY FAIL: Expected at least 6 indexes, found %', v_count;
    END IF;
END $$;

-- ===========================================================================
-- Migration Complete: VTID-01190 Persistent VTID Specs + Immutable Snapshot Pipeline
-- ===========================================================================
