-- Migration: 20251217000000_vtid_ledger_and_allocator.sql
-- Purpose: VTID-0542 Create vtid_ledger table and allocate_global_vtid RPC
-- Date: 2025-12-17 (must run before 20251218 which depends on vtid_ledger)
--
-- Creates the allocate_global_vtid RPC function that atomically:
-- 1. Gets next sequence number
-- 2. Formats as VTID-XXXXX (5-digit zero-padded)
-- 3. Inserts shell entry into vtid_ledger
-- 4. Returns allocated VTID info

-- ===========================================================================
-- Ensure vtid_ledger table exists (required for allocator function)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS vtid_ledger (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    vtid TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'scheduled',
    tenant TEXT NOT NULL DEFAULT 'vitana',
    layer TEXT,
    module TEXT,
    task_family TEXT,
    task_type TEXT,
    summary TEXT DEFAULT '',
    description TEXT DEFAULT '',
    is_test BOOLEAN DEFAULT false,
    metadata JSONB DEFAULT '{}',
    assigned_to TEXT,
    parent_vtid TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes if they don't exist
CREATE INDEX IF NOT EXISTS idx_vtid_ledger_vtid ON vtid_ledger(vtid);
CREATE INDEX IF NOT EXISTS idx_vtid_ledger_status ON vtid_ledger(status);
CREATE INDEX IF NOT EXISTS idx_vtid_ledger_created_at ON vtid_ledger(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vtid_ledger_tenant ON vtid_ledger(tenant);

-- Grant permissions
GRANT ALL ON vtid_ledger TO service_role;

-- Enable RLS but allow service_role full access
ALTER TABLE vtid_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vtid_ledger_service_role_all ON vtid_ledger;
CREATE POLICY vtid_ledger_service_role_all ON vtid_ledger FOR ALL TO service_role USING (true);

-- ===========================================================================
-- Ensure global VTID sequence exists (starts at 1000 for VTID-01000 format)
-- ===========================================================================

CREATE SEQUENCE IF NOT EXISTS global_vtid_seq START 1000 INCREMENT 1;
GRANT USAGE, SELECT ON SEQUENCE global_vtid_seq TO service_role;

-- ===========================================================================
-- Atomic VTID Allocation Function
-- ===========================================================================

CREATE OR REPLACE FUNCTION allocate_global_vtid(
    p_source TEXT DEFAULT 'api',
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
    v_layer TEXT;
    v_module TEXT;
BEGIN
    -- Normalize inputs
    v_layer := UPPER(COALESCE(p_layer, 'DEV'));
    v_module := UPPER(COALESCE(p_module, 'TASK'));

    -- Step 1: Get next sequence number atomically
    v_num := nextval('global_vtid_seq');

    -- Step 2: Format as VTID-XXXXX (5-digit zero-padded)
    v_vtid := 'VTID-' || LPAD(v_num::TEXT, 5, '0');

    -- Step 3: Generate UUID for the row
    v_id := gen_random_uuid()::TEXT;

    -- Step 4: Insert shell entry into vtid_ledger
    -- Uses same column names as create_vtid_atomic for consistency
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
        'Allocated - Pending Title',  -- placeholder title
        'allocated',                   -- special status for shell entries
        'vitana',                      -- default tenant
        v_layer,                       -- layer
        v_module,                      -- module
        v_layer,                       -- task_family for backwards compat
        v_module,                      -- task_type for backwards compat
        '',                            -- empty summary
        '',                            -- empty description
        false,                         -- not a test
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

COMMENT ON SEQUENCE global_vtid_seq IS 'VTID-0542: Global VTID sequence for atomic allocation (starts at 1000 for VTID-01000)';
COMMENT ON FUNCTION allocate_global_vtid IS 'VTID-0542: Atomically allocates next VTID and creates shell entry in vtid_ledger';
