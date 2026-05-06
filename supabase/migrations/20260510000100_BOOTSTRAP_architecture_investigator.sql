-- =============================================================================
-- Architecture Investigator — system-wide root-cause hypothesis generator
-- =============================================================================
-- Generalizes services/gateway/src/services/voice-architecture-investigator.ts
-- (which is voice-scoped, VTID-01963) into a stage-agnostic agent that:
--   1. Subscribes to OASIS incident events across any stage
--   2. Pulls relevant code/commits/events context
--   3. Calls deepseek-reasoner for a root-cause hypothesis + suggested fix
--   4. Persists the report and emits architecture.investigation.completed
--
-- Hypotheses are NEVER auto-executed — they are advisory inputs to
-- self-healing and human review.
-- =============================================================================

CREATE TABLE IF NOT EXISTS architecture_reports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What triggered the investigation
  incident_topic    TEXT NOT NULL,          -- e.g. 'vtid.error.failed', 'self_healing.suggestion_required'
  vtid              TEXT,
  signature         TEXT,                    -- normalized signature (error class fingerprint)
  trigger_reason    TEXT NOT NULL CHECK (trigger_reason IN (
                      'manual', 'self_healing', 'sentinel', 'spec_memory_blocked', 'quality_failure'
                    )),

  -- Hypothesis
  root_cause        TEXT NOT NULL,
  confidence        NUMERIC(3,2) CHECK (confidence >= 0 AND confidence <= 1),
  suggested_fix     TEXT NOT NULL,
  alternative_hypotheses JSONB DEFAULT '[]'::jsonb,

  -- Provenance
  llm_provider      TEXT NOT NULL,
  llm_model         TEXT NOT NULL,
  evidence_summary  JSONB NOT NULL DEFAULT '{}'::jsonb,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  latency_ms        INTEGER,

  -- Lifecycle
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'accepted', 'rejected', 'superseded')),
  reviewed_by       TEXT,
  reviewed_at       TIMESTAMPTZ,
  reviewer_note     TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_architecture_reports_vtid
  ON architecture_reports(vtid) WHERE vtid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_architecture_reports_signature
  ON architecture_reports(signature) WHERE signature IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_architecture_reports_status
  ON architecture_reports(status);
CREATE INDEX IF NOT EXISTS idx_architecture_reports_created
  ON architecture_reports(created_at DESC);

ALTER TABLE architecture_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to architecture_reports" ON architecture_reports;
CREATE POLICY "Service role full access to architecture_reports"
  ON architecture_reports FOR ALL
  USING (auth.role() = 'service_role');

GRANT ALL ON architecture_reports TO service_role;

-- =============================================================================
-- Register the agent in agents_registry
-- =============================================================================
INSERT INTO agents_registry
  (agent_id, display_name, description, tier, role, llm_provider, llm_model,
   source_path, entry_endpoint, metadata)
VALUES
  ('architecture-investigator',
   'Architecture Investigator',
   'System-wide root-cause hypothesis agent. Reads OASIS incident events + code + recent commits, calls deepseek-reasoner for a structured root-cause hypothesis with suggested fix and ≥2 alternatives. Hypotheses are advisory; humans decide whether to execute.',
   'embedded', 'investigation', 'deepseek', 'deepseek-reasoner',
   'services/gateway/src/services/architecture-investigator.ts',
   'POST /api/v1/architecture/investigate',
   jsonb_build_object(
     'vtid', 'BOOTSTRAP-ARCH-INV',
     'generalizes', 'voice-architecture-investigator',
     'auto_execute', false,
     'storage_table', 'architecture_reports'
   ))
ON CONFLICT (agent_id) DO UPDATE SET
  description = EXCLUDED.description,
  llm_provider = EXCLUDED.llm_provider,
  llm_model = EXCLUDED.llm_model,
  source_path = EXCLUDED.source_path,
  entry_endpoint = EXCLUDED.entry_endpoint,
  metadata = agents_registry.metadata || EXCLUDED.metadata;
