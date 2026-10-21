-- Migration: 20251216_vtid_0542_global_allocator.sql
-- Purpose: VTID-0542 Global VTID Allocator with atomic sequential numbering
-- Date: 2025-12-16
--
-- This migration creates a global VTID sequence starting at VTID-01000
-- and an atomic allocation function that ensures no split-brain across
-- all three task creation paths (Manual/CTO, Operator Console, Command Hub)

-- ===========================================================================
-- D1: Global VTID Sequence (starting at 1000 for VTID-01000 format)
-- ===========================================================================

-- Create the global VTID sequence if it doesn't exist
-- Starts at 1000 to produce VTID-01000, VTID-01001, etc.
CREATE SEQUENCE IF NOT EXISTS oasis_vtid_seq START 1000 INCREMENT 1;

-- Grant permissions
GRANT USAGE, SELECT ON SEQUENCE oasis_vtid_seq TO service_role;

-- ===========================================================================
-- D1: Atomic VTID Allocation Function
-- ===========================================================================

-- This function atomically:
-- 1. Gets the next sequence number
-- 2. Formats it as VTID-XXXXX (5-digit zero-padded)
-- 3. Inserts a minimal task shell into VtidLedger
-- 4. Returns the VTID and number
--
-- The allocation is atomic - if the insert fails, the sequence number
-- is effectively "burned" but no duplicate VTIDs can ever occur.

CREATE OR REPLACE FUNCTION allocate_global_vtid(
    p_source TEXT DEFAULT 'unknown',
    p_layer TEXT DEFAULT 'DEV',
    p_module TEXT DEFAULT 'TASK'
)
RETURNS TABLE(vtid TEXT, num BIGINT, id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_num BIGINT;
    v_vtid TEXT;
    v_id TEXT;
BEGIN
    -- Step 1: Get next sequence number atomically
    v_num := nextval('oasis_vtid_seq');

    -- Step 2: Format as VTID-XXXXX (5-digit zero-padded)
    v_vtid := 'VTID-' || LPAD(v_num::TEXT, 5, '0');

    -- Step 3: Generate UUID for the row
    v_id := gen_random_uuid()::TEXT;

    -- Step 4: Insert minimal task shell into VtidLedger
    -- This ensures allocated == registered (no orphan allocations)
    INSERT INTO "VtidLedger" (
        id,
        vtid,
        task_family,
        task_type,
        layer,
        module,
        title,
        description,
        status,
        tenant,
        is_test,
        metadata,
        created_at,
        updated_at
    ) VALUES (
        v_id,
        v_vtid,
        p_layer,                          -- task_family
        p_module,                         -- task_type
        UPPER(SUBSTRING(p_layer, 1, 3)),  -- layer (first 3 chars)
        UPPER(p_module),                  -- module
        'Allocated - Pending Title',      -- placeholder title
        '',                               -- empty description
        'allocated',                      -- special status for shell entries
        'vitana',                         -- default tenant
        false,                            -- not a test
        jsonb_build_object(
            'source', p_source,
            'allocated_at', NOW()::TEXT,
            'allocator_version', 'VTID-0542'
        ),
        NOW(),
        NOW()
    );

    -- Return the allocated VTID info
    RETURN QUERY SELECT v_vtid, v_num, v_id;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION allocate_global_vtid(TEXT, TEXT, TEXT) TO service_role;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON SEQUENCE oasis_vtid_seq IS 'VTID-0542: Global VTID sequence for atomic allocation across all task creation paths';
COMMENT ON FUNCTION allocate_global_vtid IS 'VTID-0542: Atomically allocates a VTID and creates the ledger entry in one transaction';
