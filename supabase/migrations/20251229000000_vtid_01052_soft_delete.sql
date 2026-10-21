-- Migration: 20251229000000_vtid_01052_soft_delete.sql
-- Purpose: VTID-01052 Add soft delete columns for scheduled task deletion
-- Date: 2025-12-29
--
-- This migration adds columns to support soft deletion of scheduled tasks:
-- 1. deleted_at - When the task was deleted
-- 2. deleted_by - Who deleted the task
-- 3. delete_reason - Why the task was deleted
-- 4. voided_at - When the VTID was voided (blocked from reuse)
-- 5. voided_reason - Why the VTID was voided

-- ===========================================================================
-- Add soft delete columns to vtid_ledger
-- ===========================================================================

-- Add deleted_at column if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vtid_ledger' AND column_name = 'deleted_at'
    ) THEN
        ALTER TABLE vtid_ledger ADD COLUMN deleted_at TIMESTAMPTZ;
    END IF;
END $$;

-- Add deleted_by column if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vtid_ledger' AND column_name = 'deleted_by'
    ) THEN
        ALTER TABLE vtid_ledger ADD COLUMN deleted_by TEXT;
    END IF;
END $$;

-- Add delete_reason column if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vtid_ledger' AND column_name = 'delete_reason'
    ) THEN
        ALTER TABLE vtid_ledger ADD COLUMN delete_reason TEXT;
    END IF;
END $$;

-- Add voided_at column if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vtid_ledger' AND column_name = 'voided_at'
    ) THEN
        ALTER TABLE vtid_ledger ADD COLUMN voided_at TIMESTAMPTZ;
    END IF;
END $$;

-- Add voided_reason column if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vtid_ledger' AND column_name = 'voided_reason'
    ) THEN
        ALTER TABLE vtid_ledger ADD COLUMN voided_reason TEXT;
    END IF;
END $$;

-- Create index for soft delete queries (exclude deleted records efficiently)
CREATE INDEX IF NOT EXISTS idx_vtid_ledger_deleted_at ON vtid_ledger(deleted_at) WHERE deleted_at IS NOT NULL;

-- Create index for voided VTIDs
CREATE INDEX IF NOT EXISTS idx_vtid_ledger_voided_at ON vtid_ledger(voided_at) WHERE voided_at IS NOT NULL;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON COLUMN vtid_ledger.deleted_at IS 'VTID-01052: Timestamp when the task was soft-deleted';
COMMENT ON COLUMN vtid_ledger.deleted_by IS 'VTID-01052: User/email who deleted the task';
COMMENT ON COLUMN vtid_ledger.delete_reason IS 'VTID-01052: Reason for deletion (e.g., user_cancelled)';
COMMENT ON COLUMN vtid_ledger.voided_at IS 'VTID-01052: Timestamp when the VTID was voided/blocked';
COMMENT ON COLUMN vtid_ledger.voided_reason IS 'VTID-01052: Reason for voiding (e.g., task_deleted)';
