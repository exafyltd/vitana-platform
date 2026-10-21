-- BOOTSTRAP-LLM-ROUTER-SEED: extend providers + models + activate flagship-only policy
--
-- Phase B of the LLM provider routing plan.
-- Phase A (PR #951) shipped the router code + flagship-only defaults in
-- constants/llm-defaults.ts. This migration aligns the database state with
-- those defaults so the deployed gateway reads them as the active policy
-- instead of falling back to LLM_SAFE_DEFAULTS hardcoded in the binary.
--
-- Operations (idempotent, ON CONFLICT UPDATE):
--   1. Add `tier` column to llm_allowed_models (flagship | mid | light) so
--      the Command Hub dropdown can sort + visually mark flagships.
--   2. Insert/update llm_allowed_providers for the new providers
--      (deepseek, claude_subscription).
--   3. Insert/update llm_allowed_models with current-generation flagship +
--      mid + light entries per provider, including the new providers.
--   4. Deactivate any existing active DEV policy and insert a new active
--      version with the flagship-only policy across 8 stages
--      (planner, worker, validator, operator, memory, triage, vision,
--      classifier).
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. tier column for sorting / flagship-marking
-- =============================================================================
ALTER TABLE llm_allowed_models
  ADD COLUMN IF NOT EXISTS tier TEXT
    NOT NULL DEFAULT 'mid'
    CHECK (tier IN ('flagship', 'mid', 'light'));

-- =============================================================================
-- 2. Extend llm_allowed_providers
-- =============================================================================
INSERT INTO llm_allowed_providers (provider_key, display_name, is_active, config)
VALUES
  -- Existing four refreshed for the extended stage list
  ('anthropic', 'Anthropic', true,
   '{"api_base": "https://api.anthropic.com",
     "supported_stages": ["planner","worker","validator","operator","memory","triage","vision","classifier"]}'::jsonb),
  ('vertex', 'Google Vertex AI', true,
   '{"project": "lovable-vitana-vers1", "location": "us-central1",
     "supported_stages": ["planner","worker","validator","operator","memory","triage","vision","classifier"]}'::jsonb),
  ('openai', 'OpenAI', true,
   '{"api_base": "https://api.openai.com",
     "supported_stages": ["planner","worker","validator","operator","memory","triage","vision","classifier"]}'::jsonb),
  -- New
  ('deepseek', 'DeepSeek', true,
   '{"api_base": "https://api.deepseek.com",
     "supported_stages": ["planner","worker","validator","operator","memory","triage","classifier"],
     "note": "OpenAI-compatible REST API; does NOT support vision."}'::jsonb),
  ('claude_subscription', 'Claude Subscription (free, via worker)', true,
   '{"transport": "local-worker-queue",
     "supported_stages": ["planner","worker"],
     "note": "Pseudo-provider that routes through the local autopilot-worker -> claude -p against Pro/Max plan. No per-token billing."}'::jsonb)
ON CONFLICT (provider_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  is_active = EXCLUDED.is_active,
  config = EXCLUDED.config,
  updated_at = NOW();

-- =============================================================================
-- 3. Refresh llm_allowed_models (flagship + mid + light per provider)
-- =============================================================================

-- Anthropic
INSERT INTO llm_allowed_models
  (provider_key, model_id, display_name, is_active, is_recommended, applicable_stages, cost_per_1m_input, cost_per_1m_output, max_context_tokens, notes, tier)
VALUES
  ('anthropic', 'claude-opus-4-7', 'Claude Opus 4.7 (flagship)', true, true,
   ARRAY['planner','worker','validator','operator','memory','triage','vision'],
   15.00, 75.00, 200000, 'Anthropic flagship (default)', 'flagship'),
  ('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', true, false,
   ARRAY['planner','worker','validator','operator','memory','triage','vision','classifier'],
   3.00, 15.00, 200000, 'Mid-tier — selectable but not default', 'mid'),
  ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', true, false,
   ARRAY['classifier','memory','worker'],
   0.80, 4.00, 200000, 'Light — selectable but not default', 'light')
ON CONFLICT (provider_key, model_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  is_active = EXCLUDED.is_active,
  is_recommended = EXCLUDED.is_recommended,
  applicable_stages = EXCLUDED.applicable_stages,
  cost_per_1m_input = EXCLUDED.cost_per_1m_input,
  cost_per_1m_output = EXCLUDED.cost_per_1m_output,
  max_context_tokens = EXCLUDED.max_context_tokens,
  notes = EXCLUDED.notes,
  tier = EXCLUDED.tier,
  updated_at = NOW();

-- Vertex (Google) — gemini-3.1-pro is the flagship
INSERT INTO llm_allowed_models
  (provider_key, model_id, display_name, is_active, is_recommended, applicable_stages, cost_per_1m_input, cost_per_1m_output, max_context_tokens, notes, tier)
VALUES
  ('vertex', 'gemini-3.1-pro', 'Gemini 3.1 Pro (flagship)', true, true,
   ARRAY['planner','worker','validator','operator','memory','triage','vision','classifier'],
   1.25, 5.00, 1000000, 'Google flagship (default)', 'flagship'),
  ('vertex', 'gemini-2.5-pro', 'Gemini 2.5 Pro', true, false,
   ARRAY['planner','worker','validator','operator','memory','triage','vision','classifier'],
   1.25, 5.00, 2000000, 'Mid-tier', 'mid'),
  ('vertex', 'gemini-2.5-flash', 'Gemini 2.5 Flash', true, false,
   ARRAY['worker','classifier','memory'],
   0.075, 0.30, 1000000, 'Light — selectable but not default', 'light')
ON CONFLICT (provider_key, model_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  is_active = EXCLUDED.is_active,
  is_recommended = EXCLUDED.is_recommended,
  applicable_stages = EXCLUDED.applicable_stages,
  cost_per_1m_input = EXCLUDED.cost_per_1m_input,
  cost_per_1m_output = EXCLUDED.cost_per_1m_output,
  max_context_tokens = EXCLUDED.max_context_tokens,
  notes = EXCLUDED.notes,
  tier = EXCLUDED.tier,
  updated_at = NOW();

-- OpenAI
INSERT INTO llm_allowed_models
  (provider_key, model_id, display_name, is_active, is_recommended, applicable_stages, cost_per_1m_input, cost_per_1m_output, max_context_tokens, notes, tier)
VALUES
  ('openai', 'gpt-5', 'GPT-5 (flagship)', true, true,
   ARRAY['planner','worker','validator','operator','memory','triage','vision','classifier'],
   5.00, 15.00, 200000, 'OpenAI flagship (default). Pricing TBD; estimate based on gpt-4o.', 'flagship'),
  ('openai', 'gpt-4o', 'GPT-4o', true, false,
   ARRAY['planner','worker','validator','operator','memory','triage','vision','classifier'],
   5.00, 15.00, 128000, 'Mid-tier', 'mid'),
  ('openai', 'gpt-4o-mini', 'GPT-4o Mini', true, false,
   ARRAY['classifier','worker'],
   0.15, 0.60, 128000, 'Light', 'light')
ON CONFLICT (provider_key, model_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  is_active = EXCLUDED.is_active,
  is_recommended = EXCLUDED.is_recommended,
  applicable_stages = EXCLUDED.applicable_stages,
  cost_per_1m_input = EXCLUDED.cost_per_1m_input,
  cost_per_1m_output = EXCLUDED.cost_per_1m_output,
  max_context_tokens = EXCLUDED.max_context_tokens,
  notes = EXCLUDED.notes,
  tier = EXCLUDED.tier,
  updated_at = NOW();

-- DeepSeek
INSERT INTO llm_allowed_models
  (provider_key, model_id, display_name, is_active, is_recommended, applicable_stages, cost_per_1m_input, cost_per_1m_output, max_context_tokens, notes, tier)
VALUES
  ('deepseek', 'deepseek-reasoner', 'DeepSeek Reasoner (R1, flagship)', true, true,
   ARRAY['planner','worker','validator','operator','memory','triage','classifier'],
   0.55, 2.19, 64000, 'DeepSeek flagship (default). Strongest reasoning model in DeepSeek catalog.', 'flagship'),
  ('deepseek', 'deepseek-chat', 'DeepSeek Chat (V3)', true, false,
   ARRAY['classifier','memory','worker'],
   0.14, 0.28, 64000, 'Mid-tier — fastest path for high-volume classification', 'mid')
ON CONFLICT (provider_key, model_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  is_active = EXCLUDED.is_active,
  is_recommended = EXCLUDED.is_recommended,
  applicable_stages = EXCLUDED.applicable_stages,
  cost_per_1m_input = EXCLUDED.cost_per_1m_input,
  cost_per_1m_output = EXCLUDED.cost_per_1m_output,
  max_context_tokens = EXCLUDED.max_context_tokens,
  notes = EXCLUDED.notes,
  tier = EXCLUDED.tier,
  updated_at = NOW();

-- claude_subscription pseudo-provider — single "model" entry; the actual
-- model used is whatever the local Claude Code subscription resolves to
-- (typically Opus on Pro/Max). Cost is zero (subscription-billed).
INSERT INTO llm_allowed_models
  (provider_key, model_id, display_name, is_active, is_recommended, applicable_stages, cost_per_1m_input, cost_per_1m_output, max_context_tokens, notes, tier)
VALUES
  ('claude_subscription', 'claude-opus-4-7', 'Claude Subscription (Opus 4.7, free)', true, true,
   ARRAY['planner','worker'],
   0.00, 0.00, 200000,
   'Routed through local autopilot-worker daemon -> claude -p (Pro/Max plan). No per-token cost.',
   'flagship')
ON CONFLICT (provider_key, model_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  is_active = EXCLUDED.is_active,
  is_recommended = EXCLUDED.is_recommended,
  applicable_stages = EXCLUDED.applicable_stages,
  cost_per_1m_input = EXCLUDED.cost_per_1m_input,
  cost_per_1m_output = EXCLUDED.cost_per_1m_output,
  max_context_tokens = EXCLUDED.max_context_tokens,
  notes = EXCLUDED.notes,
  tier = EXCLUDED.tier,
  updated_at = NOW();

-- =============================================================================
-- 4. Activate flagship-only routing policy for DEV
-- =============================================================================

-- Deactivate any currently-active DEV policy
UPDATE llm_routing_policy
SET is_active = false,
    deactivated_at = NOW()
WHERE environment = 'DEV' AND is_active = true;

-- Insert new active flagship-only policy
INSERT INTO llm_routing_policy (environment, version, is_active, policy, created_by, activated_at)
VALUES (
  'DEV',
  COALESCE((SELECT MAX(version) FROM llm_routing_policy WHERE environment = 'DEV'), 0) + 1,
  true,
  jsonb_build_object(
    'planner', jsonb_build_object(
      'primary_provider', 'vertex',
      'primary_model', 'gemini-3.1-pro',
      'fallback_provider', 'anthropic',
      'fallback_model', 'claude-opus-4-7'
    ),
    'worker', jsonb_build_object(
      'primary_provider', 'claude_subscription',
      'primary_model', 'claude-opus-4-7',
      'fallback_provider', 'vertex',
      'fallback_model', 'gemini-3.1-pro'
    ),
    'validator', jsonb_build_object(
      'primary_provider', 'vertex',
      'primary_model', 'gemini-3.1-pro',
      'fallback_provider', 'anthropic',
      'fallback_model', 'claude-opus-4-7'
    ),
    'operator', jsonb_build_object(
      'primary_provider', 'vertex',
      'primary_model', 'gemini-3.1-pro',
      'fallback_provider', 'anthropic',
      'fallback_model', 'claude-opus-4-7'
    ),
    'memory', jsonb_build_object(
      'primary_provider', 'vertex',
      'primary_model', 'gemini-3.1-pro',
      'fallback_provider', 'deepseek',
      'fallback_model', 'deepseek-reasoner'
    ),
    'triage', jsonb_build_object(
      'primary_provider', 'vertex',
      'primary_model', 'gemini-3.1-pro',
      'fallback_provider', 'anthropic',
      'fallback_model', 'claude-opus-4-7'
    ),
    'vision', jsonb_build_object(
      'primary_provider', 'vertex',
      'primary_model', 'gemini-3.1-pro',
      'fallback_provider', 'anthropic',
      'fallback_model', 'claude-opus-4-7'
    ),
    'classifier', jsonb_build_object(
      'primary_provider', 'deepseek',
      'primary_model', 'deepseek-reasoner',
      'fallback_provider', 'vertex',
      'fallback_model', 'gemini-3.1-pro'
    )
  ),
  'system',
  NOW()
);

COMMIT;

-- Verification: SELECT to surface what's now active so the migration runner
-- prints something useful in its log.
SELECT
  'llm_routing_policy' AS table_name,
  environment, version, is_active, jsonb_object_keys(policy) AS stage
FROM llm_routing_policy
WHERE environment = 'DEV' AND is_active = true
ORDER BY stage;

SELECT
  'llm_allowed_models' AS table_name,
  provider_key, model_id, tier, is_recommended
FROM llm_allowed_models
WHERE tier = 'flagship'
ORDER BY provider_key;
