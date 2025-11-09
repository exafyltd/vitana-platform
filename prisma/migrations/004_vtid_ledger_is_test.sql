-- Migration: 004_vtid_ledger_is_test.sql
-- Purpose: Add is_test flag to VtidLedger for filtering test data
-- VTID: DEV-AICOR-VTID-LEDGER-CLEANUP
-- Date: 2025-11-09

-- Add is_test column
ALTER TABLE "VtidLedger" ADD COLUMN IF NOT EXISTS "is_test" BOOLEAN NOT NULL DEFAULT false;

-- Create index for performance
CREATE INDEX IF NOT EXISTS "idx_vtid_is_test" ON "VtidLedger"("is_test", "created_at");

-- Mark obvious test entries
UPDATE "VtidLedger" SET "is_test" = true 
WHERE description ILIKE '%test%' 
   OR description ILIKE '%dummy%'
   OR description ILIKE '%sample%'
   OR description ILIKE '%example%';

COMMENT ON COLUMN "VtidLedger"."is_test" IS 'Flag to mark test/dummy VTIDs for filtering';
