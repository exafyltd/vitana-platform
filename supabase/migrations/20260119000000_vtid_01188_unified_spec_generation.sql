-- Migration: 20260119000000_vtid_01188_unified_spec_generation.sql
-- Purpose: VTID-01188 Unified "Generate Spec" Pipeline for Any Task Source
-- Date: 2026-01-19
--
-- Creates:
-- 1. Extends vtid_ledger with spec status tracking columns
-- 2. oasis_specs table - canonical spec storage
-- 3. oasis_spec_validations table - validation records
-- 4. oasis_spec_approvals table - approval records

-- =============================================================================
-- 1. Extend vtid_ledger with spec status columns (ADDITIVE - no breaking changes)
-- =============================================================================

DO $$
BEGIN
    -- Add spec_status column if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vtid_ledger' AND column_name = 'spec_status'
    ) THEN
        ALTER TABLE vtid_ledger ADD COLUMN spec_status TEXT NOT NULL DEFAULT 'missing';
        RAISE NOTICE 'Added spec_status column to vtid_ledger';
    END IF;

    -- Add spec_current_id column if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vtid_ledger' AND column_name = 'spec_current_id'
    ) THEN
        ALTER TABLE vtid_ledger ADD COLUMN spec_current_id UUID NULL;
        RAISE NOTICE 'Added spec_current_id column to vtid_ledger';
    END IF;

    -- Add spec_current_hash column if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vtid_ledger' AND column_name = 'spec_current_hash'
    ) THEN
        ALTER TABLE vtid_ledger ADD COLUMN spec_current_hash TEXT NULL;
        RAISE NOTICE 'Added spec_current_hash column to vtid_ledger';
    END IF;

    -- Add spec_approved_hash column if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vtid_ledger' AND column_name = 'spec_approved_hash'
    ) THEN
        ALTER TABLE vtid_ledger ADD COLUMN spec_approved_hash TEXT NULL;
        RAISE NOTICE 'Added spec_approved_hash column to vtid_ledger';
    END IF;

    -- Add spec_approved_by column if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vtid_ledger' AND column_name = 'spec_approved_by'
    ) THEN
        ALTER TABLE vtid_ledger ADD COLUMN spec_approved_by TEXT NULL;
        RAISE NOTICE 'Added spec_approved_by column to vtid_ledger';
    END IF;

    -- Add spec_approved_at column if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vtid_ledger' AND column_name = 'spec_approved_at'
    ) THEN
        ALTER TABLE vtid_ledger ADD COLUMN spec_approved_at TIMESTAMPTZ NULL;
        RAISE NOTICE 'Added spec_approved_at column to vtid_ledger';
    END IF;

    -- Add spec_last_error column if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vtid_ledger' AND column_name = 'spec_last_error'
    ) THEN
        ALTER TABLE vtid_ledger ADD COLUMN spec_last_error TEXT NULL;
        RAISE NOTICE 'Added spec_last_error column to vtid_ledger';
    END IF;
END $$;

-- Create index for spec_status queries
CREATE INDEX IF NOT EXISTS idx_vtid_ledger_spec_status ON vtid_ledger(spec_status);

-- Add check constraint for spec_status values
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'vtid_ledger_spec_status_check'
        AND table_name = 'vtid_ledger'
    ) THEN
        ALTER TABLE vtid_ledger ADD CONSTRAINT vtid_ledger_spec_status_check
        CHECK (spec_status IN ('missing', 'generating', 'draft', 'validating', 'validated', 'rejected', 'approved'));
    END IF;
EXCEPTION WHEN duplicate_object THEN
    NULL;
END $$;

-- =============================================================================
-- 2. Create oasis_specs table - Canonical spec storage
-- =============================================================================

CREATE TABLE IF NOT EXISTS oasis_specs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vtid TEXT NOT NULL,
    version INT NOT NULL DEFAULT 1,
    title TEXT NOT NULL DEFAULT '',
    spec_markdown TEXT NOT NULL DEFAULT '',
    spec_hash TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    created_by TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Unique constraints
    CONSTRAINT oasis_specs_vtid_version_unique UNIQUE (vtid, version),

    -- Status check constraint
    CONSTRAINT oasis_specs_status_check CHECK (status IN ('draft', 'validated', 'rejected', 'approved', 'superseded'))
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_oasis_specs_vtid ON oasis_specs(vtid);
CREATE INDEX IF NOT EXISTS idx_oasis_specs_status ON oasis_specs(status);
CREATE INDEX IF NOT EXISTS idx_oasis_specs_created_at ON oasis_specs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oasis_specs_vtid_hash ON oasis_specs(vtid, spec_hash);

-- =============================================================================
-- 3. Create oasis_spec_validations table - Validation records
-- =============================================================================

CREATE TABLE IF NOT EXISTS oasis_spec_validations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vtid TEXT NOT NULL,
    spec_id UUID NOT NULL REFERENCES oasis_specs(id) ON DELETE CASCADE,
    spec_hash TEXT NOT NULL,
    validator_model TEXT NOT NULL DEFAULT 'claude-opus-4-20250514',
    result TEXT NOT NULL DEFAULT 'pending',
    report_json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Result check constraint
    CONSTRAINT oasis_spec_validations_result_check CHECK (result IN ('pending', 'pass', 'fail'))
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_oasis_spec_validations_vtid ON oasis_spec_validations(vtid);
CREATE INDEX IF NOT EXISTS idx_oasis_spec_validations_spec_id ON oasis_spec_validations(spec_id);
CREATE INDEX IF NOT EXISTS idx_oasis_spec_validations_result ON oasis_spec_validations(result);
CREATE INDEX IF NOT EXISTS idx_oasis_spec_validations_created_at ON oasis_spec_validations(created_at DESC);

-- =============================================================================
-- 4. Create oasis_spec_approvals table - Approval records
-- =============================================================================

CREATE TABLE IF NOT EXISTS oasis_spec_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vtid TEXT NOT NULL,
    spec_id UUID NOT NULL REFERENCES oasis_specs(id) ON DELETE CASCADE,
    spec_hash TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    approved_role TEXT NOT NULL DEFAULT 'operator',
    approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_oasis_spec_approvals_vtid ON oasis_spec_approvals(vtid);
CREATE INDEX IF NOT EXISTS idx_oasis_spec_approvals_spec_id ON oasis_spec_approvals(spec_id);
CREATE INDEX IF NOT EXISTS idx_oasis_spec_approvals_approved_at ON oasis_spec_approvals(approved_at DESC);

-- =============================================================================
-- 5. Row Level Security
-- =============================================================================

-- Enable RLS on all new tables
ALTER TABLE oasis_specs ENABLE ROW LEVEL SECURITY;
ALTER TABLE oasis_spec_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE oasis_spec_approvals ENABLE ROW LEVEL SECURITY;

-- Service role gets full access (backend only)
DROP POLICY IF EXISTS "service_role_oasis_specs" ON oasis_specs;
CREATE POLICY "service_role_oasis_specs" ON oasis_specs
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_oasis_spec_validations" ON oasis_spec_validations;
CREATE POLICY "service_role_oasis_spec_validations" ON oasis_spec_validations
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_oasis_spec_approvals" ON oasis_spec_approvals;
CREATE POLICY "service_role_oasis_spec_approvals" ON oasis_spec_approvals
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- Authenticated users can read (UI reads via Gateway API)
DROP POLICY IF EXISTS "authenticated_read_oasis_specs" ON oasis_specs;
CREATE POLICY "authenticated_read_oasis_specs" ON oasis_specs
    FOR SELECT TO authenticated
    USING (true);

DROP POLICY IF EXISTS "authenticated_read_oasis_spec_validations" ON oasis_spec_validations;
CREATE POLICY "authenticated_read_oasis_spec_validations" ON oasis_spec_validations
    FOR SELECT TO authenticated
    USING (true);

DROP POLICY IF EXISTS "authenticated_read_oasis_spec_approvals" ON oasis_spec_approvals;
CREATE POLICY "authenticated_read_oasis_spec_approvals" ON oasis_spec_approvals
    FOR SELECT TO authenticated
    USING (true);

-- Grant permissions
GRANT ALL ON oasis_specs TO service_role;
GRANT ALL ON oasis_spec_validations TO service_role;
GRANT ALL ON oasis_spec_approvals TO service_role;
GRANT SELECT ON oasis_specs TO authenticated;
GRANT SELECT ON oasis_spec_validations TO authenticated;
GRANT SELECT ON oasis_spec_approvals TO authenticated;

-- =============================================================================
-- 6. Helper function to get next spec version for a VTID
-- =============================================================================

CREATE OR REPLACE FUNCTION get_next_spec_version(p_vtid TEXT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_max_version INT;
BEGIN
    SELECT COALESCE(MAX(version), 0) + 1 INTO v_max_version
    FROM oasis_specs
    WHERE vtid = p_vtid;

    RETURN v_max_version;
END;
$$;

GRANT EXECUTE ON FUNCTION get_next_spec_version(TEXT) TO service_role;

-- =============================================================================
-- 7. Comments for documentation
-- =============================================================================

COMMENT ON COLUMN vtid_ledger.spec_status IS 'VTID-01188: Spec pipeline status (missing|generating|draft|validating|validated|rejected|approved)';
COMMENT ON COLUMN vtid_ledger.spec_current_id IS 'VTID-01188: FK to current spec in oasis_specs';
COMMENT ON COLUMN vtid_ledger.spec_current_hash IS 'VTID-01188: SHA-256 hash of current spec content';
COMMENT ON COLUMN vtid_ledger.spec_approved_hash IS 'VTID-01188: SHA-256 hash of approved spec (must match current for activation)';
COMMENT ON COLUMN vtid_ledger.spec_approved_by IS 'VTID-01188: User ID who approved the spec';
COMMENT ON COLUMN vtid_ledger.spec_approved_at IS 'VTID-01188: Timestamp when spec was approved';
COMMENT ON COLUMN vtid_ledger.spec_last_error IS 'VTID-01188: Last validation error message';

COMMENT ON TABLE oasis_specs IS 'VTID-01188: Canonical spec storage for unified spec generation pipeline';
COMMENT ON COLUMN oasis_specs.version IS 'VTID-01188: Spec version number (auto-incremented per VTID)';
COMMENT ON COLUMN oasis_specs.spec_markdown IS 'VTID-01188: Full spec content in markdown format';
COMMENT ON COLUMN oasis_specs.spec_hash IS 'VTID-01188: SHA-256 hash of spec_markdown for integrity verification';
COMMENT ON COLUMN oasis_specs.status IS 'VTID-01188: Spec lifecycle status (draft|validated|rejected|approved|superseded)';

COMMENT ON TABLE oasis_spec_validations IS 'VTID-01188: Validation records with governance traceability report';
COMMENT ON COLUMN oasis_spec_validations.report_json IS 'VTID-01188: Validation report with rule traceability and fix list';

COMMENT ON TABLE oasis_spec_approvals IS 'VTID-01188: Approval records for audit trail';

COMMENT ON FUNCTION get_next_spec_version(TEXT) IS 'VTID-01188: Returns next sequential spec version number for a VTID';
