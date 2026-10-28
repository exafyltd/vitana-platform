-- Migration: 20251230000000_vtid_01080_terminal_completion.sql
-- Purpose: VTID-01080 Add terminal completion columns for CI/CD hard gate
-- Date: 2025-12-30
--
-- This migration adds columns to support terminal completion tracking:
-- 1. is_terminal - Boolean indicating task has reached terminal state
-- 2. terminal_outcome - The outcome when terminal (success, failed, cancelled)
-- 3. completed_at - When the task was completed via CI/CD gate
--
-- A task is ONLY "done" if the pipeline writes a terminal completion update.

-- ===========================================================================
-- Add terminal completion columns to vtid_ledger
-- ===========================================================================

-- Add is_terminal column if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vtid_ledger' AND column_name = 'is_terminal'
    ) THEN
        ALTER TABLE vtid_ledger ADD COLUMN is_terminal BOOLEAN DEFAULT false;
    END IF;
END $$;

-- Add terminal_outcome column if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vtid_ledger' AND column_name = 'terminal_outcome'
    ) THEN
        ALTER TABLE vtid_ledger ADD COLUMN terminal_outcome TEXT;
    END IF;
END $$;

-- Add completed_at column if not exists (distinct from updated_at for precise tracking)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vtid_ledger' AND column_name = 'completed_at'
    ) THEN
        ALTER TABLE vtid_ledger ADD COLUMN completed_at TIMESTAMPTZ;
    END IF;
END $$;

-- Create index for terminal completion queries
CREATE INDEX IF NOT EXISTS idx_vtid_ledger_is_terminal ON vtid_ledger(is_terminal) WHERE is_terminal = true;
CREATE INDEX IF NOT EXISTS idx_vtid_ledger_terminal_outcome ON vtid_ledger(terminal_outcome) WHERE terminal_outcome IS NOT NULL;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON COLUMN vtid_ledger.is_terminal IS 'VTID-01080: Boolean indicating task has reached terminal state via CI/CD gate';
COMMENT ON COLUMN vtid_ledger.terminal_outcome IS 'VTID-01080: Terminal outcome (success, failed, cancelled) set by CI/CD pipeline';
COMMENT ON COLUMN vtid_ledger.completed_at IS 'VTID-01080: Timestamp when task was marked terminal via CI/CD completion gate';
