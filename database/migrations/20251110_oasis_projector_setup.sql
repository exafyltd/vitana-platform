-- Migration: DEV-OASIS-0010 - VTID Event Projector Setup
-- IDEMPOTENT: Safe to run multiple times

-- Add projected column with explicit default
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'events' AND column_name = 'projected'
  ) THEN
    ALTER TABLE events ADD COLUMN projected BOOLEAN DEFAULT false NOT NULL;
    COMMENT ON COLUMN events.projected IS 'Tracks if event has been projected to downstream systems';
    
    -- Backfill existing rows
    UPDATE events SET projected = false WHERE projected IS NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_events_projected_timestamp 
  ON events(projected, timestamp) 
  WHERE projected = false;

-- Create projection_offsets table
CREATE TABLE IF NOT EXISTS projection_offsets (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  projector_name TEXT UNIQUE NOT NULL,
  last_event_id UUID,
  last_event_time TIMESTAMPTZ,
  last_processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  events_processed INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE projection_offsets IS 'Tracks projection progress for event projectors';

CREATE INDEX IF NOT EXISTS idx_projection_offsets_projector 
  ON projection_offsets(projector_name);

-- RLS Policies
ALTER TABLE projection_offsets ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'projection_offsets' AND policyname = 'Service role full access'
  ) THEN
    CREATE POLICY "Service role full access" ON projection_offsets
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'projection_offsets' AND policyname = 'Authenticated read access'
  ) THEN
    CREATE POLICY "Authenticated read access" ON projection_offsets
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

GRANT ALL ON projection_offsets TO service_role;
GRANT SELECT ON projection_offsets TO authenticated;

-- Initialize projector
INSERT INTO projection_offsets (projector_name, events_processed)
VALUES ('vtid_ledger_sync', 0)
ON CONFLICT (projector_name) DO NOTHING;

\echo 'DEV-OASIS-0010 migration completed!'
