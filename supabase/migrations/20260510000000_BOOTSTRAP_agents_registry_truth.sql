-- =============================================================================
-- Agents Registry — fix metadata drift to match what the code actually runs
-- =============================================================================
-- The original seed (20260410000000_agents_registry.sql) recorded aspirational
-- LLM wiring rather than what each service actually invokes. Operators looking
-- at the Command Hub Agents page see the wrong provider/model for several
-- services and a duplicate row for an empty stub directory. This migration
-- updates the rows to reflect ground truth in the code:
--
--   - vitana-orchestrator: deterministic verifier, no LLM call (was claimed
--     claude-3-5-sonnet-20241022, but server.py records that as metadata only;
--     verification.py has no LLM client)
--   - worker-runner:      hardcoded claude-opus-4-6 in execution-service.ts
--                         (was claimed gemini-3.1-pro-preview)
--   - cognee-extractor:   gemini-3.1-pro-preview via litellm (was 'none')
--   - openclaw-bridge:    bridge stub, currently DOWN (was 'unknown')
--   - mcp-server:         empty directory pointing at services/mcp-gateway/;
--                         row is a duplicate of mcp-gateway. Removed.
-- =============================================================================

UPDATE agents_registry
SET
  llm_provider = 'none',
  llm_model    = NULL,
  description  = 'Deterministic verification stage gate (VTID-01175). Runs file/mtime/test/artifact checks before terminalizing worker output. No LLM call.',
  metadata     = metadata
                 || jsonb_build_object('vtid', 'VTID-01175',
                                       'invocation', 'http_only',
                                       'note', 'Cloud Run service deploys deterministic checker; LLM fields previously misset.')
WHERE agent_id = 'vitana-orchestrator';

UPDATE agents_registry
SET
  llm_provider = 'claude',
  llm_model    = 'claude-opus-4-6',
  description  = 'Autonomous VTID execution plane (VTID-01200). Polls, claims, executes via Anthropic SDK (claude-opus-4-6 hardcoded in execution-service.ts), terminalizes. Bypasses llm-router; planned migration to callViaRouter() will make model config-driven.',
  metadata     = metadata
                 || jsonb_build_object('routing', 'hardcoded',
                                       'planned', 'route_via_llm_router')
WHERE agent_id = 'worker-runner';

UPDATE agents_registry
SET
  llm_provider = 'gemini',
  llm_model    = 'gemini-3.1-pro-preview',
  description  = 'Extracts entities and relationships from ORB voice transcripts via Cognee + litellm; writes to memory_facts. Configurable via LLM_PROVIDER/LLM_MODEL env (currently gemini/gemini-3.1-pro-preview). Candidate for DeepSeek-V3 swap to reduce cost.',
  metadata     = metadata
                 || jsonb_build_object('runtime_config', 'env_driven',
                                       'env_vars', jsonb_build_array('LLM_PROVIDER', 'LLM_MODEL'),
                                       'swap_candidate', 'deepseek-chat')
WHERE agent_id = 'cognee-extractor';

UPDATE agents_registry
SET
  llm_provider = 'none',
  llm_model    = NULL,
  status       = 'down',
  description  = 'OpenClaw integration bridge stub. Mixed local-Ollama (llama3.1:8b) for health calls + Anthropic Claude for non-health. No active gateway callers found; service has not heartbeated since seed. Confirm before unregistering.',
  metadata     = metadata
                 || jsonb_build_object('confirm_required', true,
                                       'callers_found', 0,
                                       'note', 'Has Ollama integration; keep code, may be repurposed.')
WHERE agent_id = 'openclaw-bridge';

-- mcp-server: services/mcp/ is an empty stub directory whose contents point at
-- services/mcp-gateway/. The registry row is a duplicate. Remove it; mcp-gateway
-- remains as the canonical entry.
DELETE FROM agents_registry WHERE agent_id = 'mcp-server';
