-- =============================================================================
-- agents_registry: extend llm_provider check to allow 'deepseek' (and others
-- that the gateway llm-router already supports)
-- =============================================================================
-- The original constraint (20260410000000) only allowed
-- ('claude', 'gemini', 'conductor', 'none', 'unknown'). This blocked the
-- INSERT in 20260510000100 (architecture-investigator with provider=deepseek).
--
-- Extends the constraint to include 'deepseek', 'openai', and 'embedded'
-- (the latter so embedded gateway agents can declare their actual mode).
-- After dropping/re-adding, replays the architecture-investigator INSERT
-- that failed in the prior migration so the row exists.
-- =============================================================================

ALTER TABLE agents_registry DROP CONSTRAINT IF EXISTS agents_registry_llm_provider_check;
ALTER TABLE agents_registry ADD CONSTRAINT agents_registry_llm_provider_check
  CHECK (llm_provider IN (
    'claude',
    'gemini',
    'conductor',
    'deepseek',
    'openai',
    'embedded',
    'none',
    'unknown'
  ));

-- Replay the architecture-investigator INSERT that the prior migration failed on
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
