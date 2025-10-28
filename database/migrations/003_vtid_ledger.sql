-- Migration: 003_vtid_ledger.sql
-- Purpose: Create VtidLedger table for task numbering and tracking
-- Date: 2025-10-28
-- Task: 4A - VTID Numbering System

-- Create VtidLedger table
CREATE TABLE IF NOT EXISTS "VtidLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vtid" TEXT NOT NULL UNIQUE,
    "task_family" TEXT NOT NULL,
    "task_type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "assigned_to" TEXT,
    "tenant" TEXT NOT NULL,
    "metadata" JSONB,
    "parent_vtid" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS "idx_vtid_created_at" ON "VtidLedger"("created_at");
CREATE INDEX IF NOT EXISTS "idx_vtid_family_created" ON "VtidLedger"("task_family", "created_at");
CREATE INDEX IF NOT EXISTS "idx_vtid_status_created" ON "VtidLedger"("status", "created_at");
CREATE INDEX IF NOT EXISTS "idx_vtid_tenant_created" ON "VtidLedger"("tenant", "created_at");
CREATE INDEX IF NOT EXISTS "idx_vtid_lookup" ON "VtidLedger"("vtid");

-- Create function to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_vtid_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for auto-updating updated_at
DROP TRIGGER IF EXISTS vtid_updated_at_trigger ON "VtidLedger";
CREATE TRIGGER vtid_updated_at_trigger
    BEFORE UPDATE ON "VtidLedger"
    FOR EACH ROW
    EXECUTE FUNCTION update_vtid_updated_at();

-- Grant access to service_role
GRANT ALL ON "VtidLedger" TO service_role;

COMMENT ON TABLE "VtidLedger" IS 'Task numbering ledger for Vitana platform - tracks all tasks with VTID format';
COMMENT ON COLUMN "VtidLedger"."vtid" IS 'Unique task identifier in format: VTID-YYYY-NNNN';
COMMENT ON COLUMN "VtidLedger"."task_family" IS 'High-level task category: governance, deployment, analysis, etc.';
COMMENT ON COLUMN "VtidLedger"."task_type" IS 'Specific task type: migration, test, review, etc.';
COMMENT ON COLUMN "VtidLedger"."status" IS 'Task status: pending, active, complete, blocked, cancelled';
COMMENT ON COLUMN "VtidLedger"."parent_vtid" IS 'Optional parent task VTID for subtask relationships';
