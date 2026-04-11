-- =============================================================================
-- Agents Registry — single source of truth for every LLM-powered workload
-- =============================================================================
-- Replaces the hardcoded array in worker-orchestrator.ts with a real, queryable
-- registry that every agent service self-registers into. Seeded with the full
-- inventory across the codebase (services, embedded LLM workloads in the
-- gateway, scheduled jobs).
--
-- Tiers:
--   service   — dedicated agent process / Cloud Run service
--   embedded  — LLM workload running inside the gateway process
--   scheduled — recurring background job that calls an LLM
--
-- Status is updated by self-registration heartbeats. Seed rows start as
-- 'unknown' and get upgraded by the first heartbeat from each service.
-- =============================================================================

CREATE TABLE IF NOT EXISTS agents_registry (
  agent_id          TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL,
  description       TEXT,

  tier              TEXT NOT NULL CHECK (tier IN ('service', 'embedded', 'scheduled')),
  role              TEXT,
  llm_provider      TEXT CHECK (llm_provider IN ('claude', 'gemini', 'conductor', 'none', 'unknown')),
  llm_model         TEXT,

  source_path       TEXT NOT NULL,
  entry_endpoint    TEXT,
  health_endpoint   TEXT,

  status            TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (status IN ('healthy', 'degraded', 'down', 'unknown')),
  last_heartbeat_at TIMESTAMPTZ,
  last_error        TEXT,

  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_registry_tier
  ON agents_registry(tier);
CREATE INDEX IF NOT EXISTS idx_agents_registry_status
  ON agents_registry(status);
CREATE INDEX IF NOT EXISTS idx_agents_registry_provider
  ON agents_registry(llm_provider);
CREATE INDEX IF NOT EXISTS idx_agents_registry_heartbeat
  ON agents_registry(last_heartbeat_at);

-- =============================================================================
-- Seed: Tier 1 — dedicated agent services
-- =============================================================================
INSERT INTO agents_registry
  (agent_id, display_name, description, tier, role, llm_provider, llm_model, source_path, health_endpoint, metadata)
VALUES
  ('cognee-extractor',
   'Cognee Extractor',
   'Extracts entities and relationships from ORB voice transcripts; writes to memory_facts.',
   'service', 'extraction', 'none', NULL,
   'services/agents/cognee-extractor/', '/health',
   jsonb_build_object('language', 'python', 'framework', 'fastapi', 'vtid', 'VTID-01225')),

  ('conductor',
   'Conductor',
   'Central LLM router proxy. Role-based primary/fallback model dispatch as an HTTP service.',
   'service', 'router', 'conductor', NULL,
   'services/agents/conductor/', '/health',
   jsonb_build_object('language', 'python', 'framework', 'fastapi', 'vtid', 'VTID-01230')),

  ('crewai-gcp',
   'CrewAI GCP',
   'CrewAI prompt-synthesis crew stub with /execute and kb_executor.',
   'service', 'synthesis', 'conductor', NULL,
   'services/agents/crewai-gcp/', '/health',
   jsonb_build_object('language', 'python', 'framework', 'fastapi')),

  ('memory-indexer',
   'Memory Indexer',
   'Mem0 + Qdrant memory service for ORB. Endpoints: /memory/write, /memory/search, /memory/context.',
   'service', 'memory', 'claude', NULL,
   'services/agents/memory-indexer/', '/health',
   jsonb_build_object('language', 'python', 'framework', 'fastapi', 'vtid', 'VTID-01152')),

  ('validator-core',
   'Validator Core',
   'Governance validator stub with /run endpoint, wired to llm_router.',
   'service', 'validation', 'conductor', NULL,
   'services/agents/validator-core/', '/health',
   jsonb_build_object('language', 'python', 'framework', 'fastapi')),

  ('vitana-orchestrator',
   'Vitana Verification Engine',
   'Verification stage gate (VTID-01175). Verifies worker output before task completion.',
   'service', 'verification', 'claude', 'claude-3-5-sonnet-20241022',
   'services/agents/vitana-orchestrator/', '/health',
   jsonb_build_object('language', 'python', 'framework', 'fastapi', 'vtid', 'VTID-01175', 'fallback_provider', 'gemini')),

  ('worker-runner',
   'Worker Runner',
   'Autonomous VTID execution plane (VTID-01200). Polls, claims, executes via LLM, terminalizes.',
   'service', 'executor', 'gemini', 'gemini-3.1-pro-preview',
   'services/worker-runner/', '/alive',
   jsonb_build_object('language', 'typescript', 'framework', 'node', 'vtid', 'VTID-01200')),

  ('oasis-projector',
   'OASIS Projector',
   'Streams OASIS events to Supabase / Prisma. Not an agent — listed for completeness.',
   'service', 'projector', 'none', NULL,
   'services/oasis-projector/', '/health',
   jsonb_build_object('language', 'typescript', 'vtid', 'VTID-0521')),

  ('oasis-operator',
   'OASIS Operator',
   'Cloud Run / K8s deploy operator. LLM calls were removed; kept for completeness.',
   'service', 'operator', 'none', NULL,
   'services/oasis-operator/', '/health',
   jsonb_build_object('language', 'python')),

  ('mcp-server',
   'MCP Server',
   'MCP tool server surface. Provider TBD — confirm during Phase 3.',
   'service', 'tool-server', 'unknown', NULL,
   'services/mcp/', '/health',
   jsonb_build_object('confirm_required', true)),

  ('mcp-gateway',
   'MCP Gateway',
   'MCP gateway surface. Provider TBD — confirm during Phase 3.',
   'service', 'tool-server', 'unknown', NULL,
   'services/mcp-gateway/', '/health',
   jsonb_build_object('confirm_required', true)),

  ('openclaw-bridge',
   'OpenClaw Bridge',
   'External LLM bridge. Provider TBD — confirm during Phase 3.',
   'service', 'bridge', 'unknown', NULL,
   'services/openclaw-bridge/', '/health',
   jsonb_build_object('confirm_required', true))
ON CONFLICT (agent_id) DO NOTHING;

-- =============================================================================
-- Seed: Tier 2 — embedded LLM workloads inside the gateway process
-- =============================================================================
INSERT INTO agents_registry
  (agent_id, display_name, description, tier, role, llm_provider, llm_model, source_path, entry_endpoint, metadata)
VALUES
  ('conversation-intelligence',
   'Conversation Intelligence',
   'Main ORB + Operator conversation endpoint. SSE streaming chat (VTID-01216).',
   'embedded', 'conversation', 'gemini', 'gemini-3.1-pro-preview',
   'services/gateway/src/routes/conversation.ts', 'POST /api/v1/conversation',
   jsonb_build_object('vtid', 'VTID-01216')),

  ('orb-live',
   'ORB Live',
   'Real-time voice pipeline. Audio chunk ingestion, SSE/WS streaming, intent detection.',
   'embedded', 'voice', 'gemini', 'gemini-3.1-pro-preview',
   'services/gateway/src/routes/orb-live.ts', 'POST /api/v1/orb/live',
   jsonb_build_object('vtid', 'VTID-01113', 'realtime', true)),

  ('gemini-operator',
   'Gemini Operator',
   'Core Gemini wrapper with function-calling tools. ALL ORB and Operator chat flows route through here.',
   'embedded', 'llm-wrapper', 'gemini', 'gemini-3.1-pro-preview',
   'services/gateway/src/services/gemini-operator.ts', NULL,
   jsonb_build_object('vtid', 'VTID-0536', 'shared', true)),

  ('inline-fact-extractor',
   'Inline Fact Extractor',
   'Fallback fact extractor that runs inside the gateway when Cognee service is down.',
   'embedded', 'extraction', 'gemini', 'gemini-3.1-pro-preview',
   'services/gateway/src/services/inline-fact-extractor.ts', NULL,
   jsonb_build_object('vtid', 'VTID-01225', 'role', 'fallback')),

  ('llm-analyzer',
   'LLM Analyzer',
   'Analyzes OASIS error patterns, stalled VTIDs, and architectural improvements (VTID-01185).',
   'embedded', 'analyzer', 'gemini', 'gemini-3.1-pro-preview',
   'services/gateway/src/services/recommendation-engine/analyzers/llm-analyzer.ts', NULL,
   jsonb_build_object('vtid', 'VTID-01185')),

  ('recommendation-generator',
   'Recommendation Generator',
   'Autopilot brain. Orchestrates 6 analyzers and generates / scores user-facing recommendations.',
   'embedded', 'autopilot', 'claude', NULL,
   'services/gateway/src/services/recommendation-engine/recommendation-generator.ts', NULL,
   jsonb_build_object('vtid', 'VTID-01180', 'analyzers', 6)),

  ('embedding-service',
   'Embedding Service',
   'Embedding generation for semantic search.',
   'embedded', 'embeddings', 'unknown', NULL,
   'services/gateway/src/services/embedding-service.ts', NULL,
   jsonb_build_object())
ON CONFLICT (agent_id) DO NOTHING;

-- =============================================================================
-- Seed: Tier 3 — scheduled / background jobs
-- =============================================================================
INSERT INTO agents_registry
  (agent_id, display_name, description, tier, role, llm_provider, llm_model, source_path, metadata)
VALUES
  ('recommendation-engine-scheduler',
   'Recommendation Engine Scheduler',
   '4 cadences: 5min signals, 6hr OASIS analysis, daily 2 AM full scan, 10min feedback loop.',
   'scheduled', 'scheduler', 'gemini', 'gemini-3.1-pro-preview',
   'services/gateway/src/services/recommendation-engine/scheduler.ts',
   jsonb_build_object('vtid', 'VTID-01185', 'cadences', jsonb_build_array('5m', '6h', 'daily-02:00-utc', '10m'))),

  ('daily-recompute',
   'Daily Recompute',
   'POST-triggered batch recompute pipeline (VTID-01095).',
   'scheduled', 'batch', 'unknown', NULL,
   'services/gateway/src/services/daily-recompute-service.ts',
   jsonb_build_object('vtid', 'VTID-01095'))
ON CONFLICT (agent_id) DO NOTHING;

-- =============================================================================
-- updated_at trigger
-- =============================================================================
CREATE OR REPLACE FUNCTION agents_registry_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agents_registry_updated_at ON agents_registry;
CREATE TRIGGER trg_agents_registry_updated_at
  BEFORE UPDATE ON agents_registry
  FOR EACH ROW
  EXECUTE FUNCTION agents_registry_set_updated_at();

-- =============================================================================
-- RLS: service role only (matches worker_registry pattern)
-- =============================================================================
ALTER TABLE agents_registry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to agents_registry" ON agents_registry;
CREATE POLICY "Service role full access to agents_registry"
  ON agents_registry FOR ALL
  USING (auth.role() = 'service_role');

GRANT ALL ON agents_registry TO service_role;
