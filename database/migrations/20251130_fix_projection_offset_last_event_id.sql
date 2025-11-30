-- Migration: Fix projection_offsets.last_event_id type
-- IDEMPOTENT: Safe to run multiple times
-- Purpose: Change last_event_id from UUID to TEXT to support CUID format
--
-- Context: OasisEvent uses CUID format (@default(cuid())) which generates
-- strings like 'cm3yz4k...' not UUIDs. The original migration incorrectly
-- set last_event_id as UUID type.

-- Step 1: Alter column type from UUID to TEXT
-- PostgreSQL allows changing UUID to TEXT directly
DO $$
BEGIN
  -- Check if the column is currently UUID type
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projection_offsets'
      AND column_name = 'last_event_id'
      AND data_type = 'uuid'
  ) THEN
    -- Change to TEXT type
    ALTER TABLE projection_offsets
    ALTER COLUMN last_event_id TYPE TEXT USING last_event_id::TEXT;

    RAISE NOTICE 'Changed projection_offsets.last_event_id from UUID to TEXT';
  ELSE
    RAISE NOTICE 'projection_offsets.last_event_id is already TEXT or does not exist';
  END IF;
END $$;

-- Update comment to reflect new type
COMMENT ON COLUMN projection_offsets.last_event_id IS 'ID of the last processed event (CUID format)';

\echo 'Migration completed - projection_offsets.last_event_id is now TEXT type!'
