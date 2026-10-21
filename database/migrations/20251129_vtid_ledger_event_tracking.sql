-- Migration: VTID-0521 - Add event tracking columns to VtidLedger
-- IDEMPOTENT: Safe to run multiple times
-- Purpose: Enable automatic VTID ledger updates from OASIS events

-- Add last_event_id column (references the OASIS event that last updated this row)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'VtidLedger' AND column_name = 'last_event_id'
  ) THEN
    ALTER TABLE "VtidLedger" ADD COLUMN last_event_id TEXT;
    COMMENT ON COLUMN "VtidLedger".last_event_id IS 'ID of the last OASIS event that updated this VTID';
  END IF;
END $$;

-- Add last_event_at column (timestamp of the last event that updated this row)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'VtidLedger' AND column_name = 'last_event_at'
  ) THEN
    ALTER TABLE "VtidLedger" ADD COLUMN last_event_at TIMESTAMPTZ;
    COMMENT ON COLUMN "VtidLedger".last_event_at IS 'Timestamp of the last OASIS event that updated this VTID';
  END IF;
END $$;

-- Add service column (which service triggered the last update)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'VtidLedger' AND column_name = 'service'
  ) THEN
    ALTER TABLE "VtidLedger" ADD COLUMN service TEXT;
    COMMENT ON COLUMN "VtidLedger".service IS 'Service that last updated this VTID (e.g., gateway, oasis-projector)';
  END IF;
END $$;

-- Add environment column (dev, staging, prod)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'VtidLedger' AND column_name = 'environment'
  ) THEN
    ALTER TABLE "VtidLedger" ADD COLUMN environment TEXT DEFAULT 'dev';
    COMMENT ON COLUMN "VtidLedger".environment IS 'Environment where the VTID is active (dev, staging, prod)';
  END IF;
END $$;

-- Create index on last_event_at for efficient querying of recently updated VTIDs
CREATE INDEX IF NOT EXISTS idx_vtid_last_event_at
  ON "VtidLedger"(last_event_at DESC NULLS LAST);

-- Create index on service for filtering by service
CREATE INDEX IF NOT EXISTS idx_vtid_service
  ON "VtidLedger"(service);

-- Initialize the vtid_ledger_writer projector in projection_offsets (if not exists)
INSERT INTO projection_offsets (projector_name, events_processed)
VALUES ('vtid_ledger_writer', 0)
ON CONFLICT (projector_name) DO NOTHING;

\echo 'VTID-0521 migration completed - vtid_ledger event tracking columns added!'
