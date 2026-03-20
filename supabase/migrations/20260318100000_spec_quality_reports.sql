-- Spec Quality Agent: quality report storage
-- Stores the full quality check report for each spec quality-check run.
-- Used for audit trail, trend analysis, and debugging.

CREATE TABLE IF NOT EXISTS oasis_spec_quality_reports (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vtid TEXT NOT NULL,
  spec_id UUID NOT NULL,
  spec_hash TEXT NOT NULL,
  overall_result TEXT NOT NULL CHECK (overall_result IN ('pass', 'fail', 'warning')),
  overall_score INTEGER NOT NULL CHECK (overall_score >= 0 AND overall_score <= 100),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  checks_json JSONB NOT NULL DEFAULT '[]',
  impact_json JSONB NOT NULL DEFAULT '{}',
  conflict_json JSONB NOT NULL DEFAULT '{}',
  governance_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spec_quality_vtid ON oasis_spec_quality_reports(vtid);
CREATE INDEX IF NOT EXISTS idx_spec_quality_result ON oasis_spec_quality_reports(overall_result);

-- RLS: service role has full access (same pattern as other oasis tables)
ALTER TABLE oasis_spec_quality_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on oasis_spec_quality_reports"
  ON oasis_spec_quality_reports
  FOR ALL
  USING (true)
  WITH CHECK (true);
