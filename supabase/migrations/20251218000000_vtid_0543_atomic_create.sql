-- Migration: 20251218000000_vtid_0543_atomic_create.sql
-- Purpose: VTID-0543 Atomic VTID creation to prevent duplicate key collisions
-- Date: 2025-12-18
--
-- This migration creates an atomic create function that:
-- 1. Gets next sequence value
-- 2. Generates VTID in format {family}-{module}-{YYYY}-{seq}
-- 3. Inserts into vtid_ledger atomically
-- 4. Returns the created row
--
-- This replaces the non-atomic next_vtid + separate INSERT pattern

-- ===========================================================================
-- Ensure sequence exists (idempotent)
-- ===========================================================================
CREATE SEQUENCE IF NOT EXISTS vtid_seq START 1 INCREMENT 1;
GRANT USAGE, SELECT ON SEQUENCE vtid_seq TO service_role;

-- ===========================================================================
-- Atomic VTID Creation Function
-- ===========================================================================

CREATE OR REPLACE FUNCTION create_vtid_atomic(
    p_family TEXT,
    p_module TEXT,
    p_title TEXT,
    p_status TEXT DEFAULT 'scheduled',
    p_tenant TEXT DEFAULT 'vitana',
    p_is_test BOOLEAN DEFAULT false,
    p_summary TEXT DEFAULT '',
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE(
    id TEXT,
    vtid TEXT,
    title TEXT,
    status TEXT,
    tenant TEXT,
    layer TEXT,
    module TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_seq BIGINT;
    v_vtid TEXT;
    v_id TEXT;
    v_fam TEXT;
    v_mod TEXT;
    v_now TIMESTAMPTZ;
BEGIN
    -- Step 1: Normalize inputs
    v_fam := UPPER(p_family);
    v_mod := UPPER(p_module);
    v_now := NOW();

    -- Step 2: Get next sequence number atomically
    v_seq := nextval('vtid_seq');

    -- Step 3: Format VTID as {FAMILY}-{MODULE}-{YYYY}-{SEQ}
    -- e.g., DEV-CICDL-2025-0003
    v_vtid := format('%s-%s-%s-%04s', v_fam, v_mod, to_char(v_now, 'YYYY'), v_seq);

    -- Step 4: Generate UUID for the row
    v_id := gen_random_uuid()::TEXT;

    -- Step 5: Insert into vtid_ledger atomically
    -- If this fails (e.g., constraint violation), the whole transaction rolls back
    INSERT INTO vtid_ledger (
        id,
        vtid,
        title,
        status,
        tenant,
        layer,
        module,
        task_family,
        task_type,
        summary,
        description,
        is_test,
        metadata,
        created_at,
        updated_at
    ) VALUES (
        v_id,
        v_vtid,
        p_title,
        p_status,
        p_tenant,
        v_fam,          -- layer = family (DEV, ADM, etc.)
        v_mod,          -- module
        v_fam,          -- task_family for backwards compat
        v_mod,          -- task_type for backwards compat
        COALESCE(NULLIF(p_summary, ''), p_title), -- summary defaults to title
        COALESCE(NULLIF(p_summary, ''), p_title), -- description defaults to title
        p_is_test,
        p_metadata,
        v_now,
        v_now
    );

    -- Step 6: Return the created row
    RETURN QUERY SELECT
        v_id,
        v_vtid,
        p_title,
        p_status,
        p_tenant,
        v_fam,
        v_mod,
        v_now;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION create_vtid_atomic(TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, JSONB) TO service_role;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON FUNCTION create_vtid_atomic IS 'VTID-0543: Atomically creates a VTID and inserts into vtid_ledger in one transaction. Prevents duplicate key collisions.';
