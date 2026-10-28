-- VTID: DEV-CICDL-0031 Phase 2
-- Schema migration: Add missing columns for live events
-- Idempotent: Safe to run multiple times

-- Add columns if not exists
ALTER TABLE oasis_events
  ADD COLUMN IF NOT EXISTS vtid TEXT,
  ADD COLUMN IF NOT EXISTS layer TEXT,
  ADD COLUMN IF NOT EXISTS module TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS kind TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS ref TEXT,
  ADD COLUMN IF NOT EXISTS link TEXT,
  ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}'::jsonb;

-- Create indexes if not exists
CREATE INDEX IF NOT EXISTS oasis_events_vtid_idx ON oasis_events (vtid);
CREATE INDEX IF NOT EXISTS oasis_events_ts_desc_idx ON oasis_events (created_at DESC);
CREATE INDEX IF NOT EXISTS oasis_events_source_idx ON oasis_events (source);
CREATE INDEX IF NOT EXISTS oasis_events_kind_idx ON oasis_events (kind);
CREATE INDEX IF NOT EXISTS oasis_events_status_idx ON oasis_events (status);
CREATE INDEX IF NOT EXISTS oasis_events_layer_idx ON oasis_events (layer);

-- Add check constraint for status values (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'oasis_events_status_check'
  ) THEN
    ALTER TABLE oasis_events 
    ADD CONSTRAINT oasis_events_status_check 
    CHECK (status IN ('queued', 'in_progress', 'success', 'failure', 'cancelled', 'info', 'warning', 'error'));
  END IF;
END$$;

-- Ensure RLS is enabled
ALTER TABLE oasis_events ENABLE ROW LEVEL SECURITY;

-- Update service role policy (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'oasis_events' 
    AND policyname = 'Service role has full access'
  ) THEN
    CREATE POLICY "Service role has full access" ON oasis_events
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END$$;

-- Grant permissions
GRANT ALL ON oasis_events TO service_role;
GRANT SELECT ON oasis_events TO authenticated;

-- Verification query (run after migration)
-- SELECT column_name, data_type FROM information_schema.columns 
-- WHERE table_name = 'oasis_events' ORDER BY ordinal_position;
