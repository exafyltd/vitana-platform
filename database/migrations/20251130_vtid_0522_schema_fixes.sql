-- Migration: VTID-0522 - Fix VTID Auto-Ledger Writer Schema
-- IDEMPOTENT: Safe to run multiple times
-- Purpose: Add missing columns to oasis_events and vtid_ledger tables

-- ============================================================
-- PART 1: Add missing columns to oasis_events table
-- ============================================================

-- Add vtid column for VTID reference
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'oasis_events' AND column_name = 'vtid'
  ) THEN
    ALTER TABLE oasis_events ADD COLUMN vtid TEXT;
    COMMENT ON COLUMN oasis_events.vtid IS 'VTID reference (e.g., VTID-0521-TEST-0001)';
  END IF;
END $$;

-- Add topic column for event type
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'oasis_events' AND column_name = 'topic'
  ) THEN
    ALTER TABLE oasis_events ADD COLUMN topic TEXT;
    COMMENT ON COLUMN oasis_events.topic IS 'Event type (e.g., deployment_succeeded)';
  END IF;
END $$;

-- Add message column for event message
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'oasis_events' AND column_name = 'message'
  ) THEN
    ALTER TABLE oasis_events ADD COLUMN message TEXT;
    COMMENT ON COLUMN oasis_events.message IS 'Event message';
  END IF;
END $$;

-- Add role column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'oasis_events' AND column_name = 'role'
  ) THEN
    ALTER TABLE oasis_events ADD COLUMN role TEXT;
    COMMENT ON COLUMN oasis_events.role IS 'Role (e.g., API, claude)';
  END IF;
END $$;

-- Add model column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'oasis_events' AND column_name = 'model'
  ) THEN
    ALTER TABLE oasis_events ADD COLUMN model TEXT;
    COMMENT ON COLUMN oasis_events.model IS 'Model name (e.g., event-ingestion-api)';
  END IF;
END $$;

-- Add link column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'oasis_events' AND column_name = 'link'
  ) THEN
    ALTER TABLE oasis_events ADD COLUMN link TEXT;
    COMMENT ON COLUMN oasis_events.link IS 'Optional link';
  END IF;
END $$;

-- Add source column (alternative to service)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'oasis_events' AND column_name = 'source'
  ) THEN
    ALTER TABLE oasis_events ADD COLUMN source TEXT;
    COMMENT ON COLUMN oasis_events.source IS 'Event source (alternative to service)';
  END IF;
END $$;

-- Create index on vtid for efficient querying
CREATE INDEX IF NOT EXISTS idx_oasis_events_vtid ON oasis_events(vtid);

-- Add projected column (required by Prisma schema for projection tracking)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'oasis_events' AND column_name = 'projected'
  ) THEN
    ALTER TABLE oasis_events ADD COLUMN projected BOOLEAN DEFAULT false;
    COMMENT ON COLUMN oasis_events.projected IS 'Tracks if event has been projected to downstream systems';
  END IF;
END $$;

-- Create index for efficient querying of unprocessed events
CREATE INDEX IF NOT EXISTS idx_oasis_events_projected_created
  ON oasis_events(projected, created_at)
  WHERE projected = false;

-- ============================================================
-- PART 2: Add missing columns to vtid_ledger table
-- ============================================================

-- Add layer column (high-level category)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vtid_ledger' AND column_name = 'layer'
  ) THEN
    ALTER TABLE vtid_ledger ADD COLUMN layer TEXT;
    COMMENT ON COLUMN vtid_ledger.layer IS 'High-level category (e.g., OASIS, GOVERNANCE)';
  END IF;
END $$;

-- Add module column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vtid_ledger' AND column_name = 'module'
  ) THEN
    ALTER TABLE vtid_ledger ADD COLUMN module TEXT;
    COMMENT ON COLUMN vtid_ledger.module IS 'Module name';
  END IF;
END $$;

-- Add title column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vtid_ledger' AND column_name = 'title'
  ) THEN
    ALTER TABLE vtid_ledger ADD COLUMN title TEXT;
    COMMENT ON COLUMN vtid_ledger.title IS 'Short display title';
  END IF;
END $$;

-- Add summary column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vtid_ledger' AND column_name = 'summary'
  ) THEN
    ALTER TABLE vtid_ledger ADD COLUMN summary TEXT;
    COMMENT ON COLUMN vtid_ledger.summary IS 'Summary text for display';
  END IF;
END $$;

-- ============================================================
-- PART 3: Backfill existing data
-- ============================================================

-- Backfill layer from task_family for existing rows
UPDATE vtid_ledger
SET layer = UPPER(task_family)
WHERE layer IS NULL AND task_family IS NOT NULL;

-- Backfill module from task_type for existing rows
UPDATE vtid_ledger
SET module = task_type
WHERE module IS NULL AND task_type IS NOT NULL;

-- Backfill title from vtid for existing rows
UPDATE vtid_ledger
SET title = vtid
WHERE title IS NULL;

-- Backfill summary from description for existing rows
UPDATE vtid_ledger
SET summary = description
WHERE summary IS NULL AND description IS NOT NULL;

\echo 'VTID-0522 migration completed - schema fixes applied!'
