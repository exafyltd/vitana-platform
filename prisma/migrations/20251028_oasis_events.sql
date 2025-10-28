-- Task 4B Phase 2: OASIS Events Table
-- VTID: VTID-2025-4B02
-- Created: 2025-10-28

CREATE TABLE IF NOT EXISTS oasis_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  vtid TEXT,
  topic TEXT NOT NULL,
  service TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'error', 'warning', 'info')),
  message TEXT NOT NULL,
  link TEXT,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_oasis_events_created_at ON oasis_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oasis_events_service ON oasis_events(service);
CREATE INDEX IF NOT EXISTS idx_oasis_events_topic ON oasis_events(topic);
CREATE INDEX IF NOT EXISTS idx_oasis_events_status ON oasis_events(status);
CREATE INDEX IF NOT EXISTS idx_oasis_events_vtid ON oasis_events(vtid);

-- RLS Policies (service role bypasses these)
ALTER TABLE oasis_events ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role has full access" ON oasis_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Grant permissions
GRANT ALL ON oasis_events TO service_role;
GRANT SELECT ON oasis_events TO authenticated;
