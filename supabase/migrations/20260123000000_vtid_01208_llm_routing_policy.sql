-- VTID-01208: LLM Telemetry + Model Provenance + Runtime Routing Control
-- Migration: LLM Routing Policy Tables
--
-- Creates tables for:
-- 1. LLM routing policy (environment-scoped, versioned)
-- 2. Allowed providers registry
-- 3. Allowed models registry
-- 4. Policy audit log
--
-- This establishes the governed LLM control plane for Vitana DEV.

-- =============================================================================
-- 1. Allowed Providers Table
-- =============================================================================
CREATE TABLE IF NOT EXISTS llm_allowed_providers (
  provider_key TEXT PRIMARY KEY,                    -- 'anthropic', 'vertex', 'openai'
  display_name TEXT NOT NULL,                       -- 'Anthropic', 'Google Vertex AI', 'OpenAI'
  is_active BOOLEAN NOT NULL DEFAULT true,          -- Can be disabled without deletion
  config JSONB DEFAULT '{}'::jsonb,                 -- API base URLs, rate limits, etc.
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed initial providers
INSERT INTO llm_allowed_providers (provider_key, display_name, is_active, config)
VALUES
  ('anthropic', 'Anthropic', true, '{"api_base": "https://api.anthropic.com", "supported_stages": ["planner", "worker", "validator", "operator", "memory"]}'::jsonb),
  ('vertex', 'Google Vertex AI', true, '{"project": "lovable-vitana-vers1", "location": "us-central1", "supported_stages": ["planner", "worker", "validator", "operator", "memory"]}'::jsonb),
  ('openai', 'OpenAI', false, '{"api_base": "https://api.openai.com", "supported_stages": ["planner", "worker", "validator", "operator"], "note": "Future support - not yet enabled"}'::jsonb)
ON CONFLICT (provider_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  config = EXCLUDED.config,
  updated_at = NOW();

-- =============================================================================
-- 2. Allowed Models Table
-- =============================================================================
CREATE TABLE IF NOT EXISTS llm_allowed_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key TEXT NOT NULL REFERENCES llm_allowed_providers(provider_key) ON DELETE CASCADE,
  model_id TEXT NOT NULL,                           -- 'claude-3-5-sonnet-20241022'
  display_name TEXT NOT NULL,                       -- 'Claude 3.5 Sonnet'
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_recommended BOOLEAN NOT NULL DEFAULT false,    -- Recommended for this stage
  applicable_stages TEXT[] NOT NULL DEFAULT ARRAY['planner','worker','validator','operator','memory'],
  cost_per_1m_input NUMERIC(10,4),                  -- Cost per 1M input tokens (USD)
  cost_per_1m_output NUMERIC(10,4),                 -- Cost per 1M output tokens (USD)
  max_context_tokens INTEGER,                       -- Max context window
  notes TEXT,                                       -- Usage notes
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(provider_key, model_id)
);

-- Seed Anthropic models
INSERT INTO llm_allowed_models (provider_key, model_id, display_name, is_active, is_recommended, applicable_stages, cost_per_1m_input, cost_per_1m_output, max_context_tokens, notes)
VALUES
  ('anthropic', 'claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet', true, true,
   ARRAY['planner', 'validator', 'memory'], 3.00, 15.00, 200000,
   'Best for reasoning, planning, and validation tasks'),
  ('anthropic', 'claude-3-opus-20240229', 'Claude 3 Opus', true, false,
   ARRAY['planner', 'validator'], 15.00, 75.00, 200000,
   'Most capable, use for complex reasoning only'),
  ('anthropic', 'claude-3-haiku-20240307', 'Claude 3 Haiku', true, false,
   ARRAY['worker', 'memory'], 0.25, 1.25, 200000,
   'Fast and cost-efficient for simple tasks')
ON CONFLICT (provider_key, model_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  is_recommended = EXCLUDED.is_recommended,
  applicable_stages = EXCLUDED.applicable_stages,
  cost_per_1m_input = EXCLUDED.cost_per_1m_input,
  cost_per_1m_output = EXCLUDED.cost_per_1m_output,
  max_context_tokens = EXCLUDED.max_context_tokens,
  notes = EXCLUDED.notes,
  updated_at = NOW();

-- Seed Google Vertex AI models
INSERT INTO llm_allowed_models (provider_key, model_id, display_name, is_active, is_recommended, applicable_stages, cost_per_1m_input, cost_per_1m_output, max_context_tokens, notes)
VALUES
  ('vertex', 'gemini-2.5-pro', 'Gemini 2.5 Pro', true, true,
   ARRAY['operator'], 1.25, 5.00, 1000000,
   'Best for multimodal conversational operator'),
  ('vertex', 'gemini-1.5-pro', 'Gemini 1.5 Pro', true, false,
   ARRAY['planner', 'worker', 'validator', 'memory'], 1.25, 5.00, 2000000,
   'Large context fallback for all stages'),
  ('vertex', 'gemini-1.5-flash', 'Gemini 1.5 Flash', true, true,
   ARRAY['worker'], 0.075, 0.30, 1000000,
   'Fast and cost-efficient for worker execution')
ON CONFLICT (provider_key, model_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  is_recommended = EXCLUDED.is_recommended,
  applicable_stages = EXCLUDED.applicable_stages,
  cost_per_1m_input = EXCLUDED.cost_per_1m_input,
  cost_per_1m_output = EXCLUDED.cost_per_1m_output,
  max_context_tokens = EXCLUDED.max_context_tokens,
  notes = EXCLUDED.notes,
  updated_at = NOW();

-- Seed OpenAI models (inactive by default)
INSERT INTO llm_allowed_models (provider_key, model_id, display_name, is_active, is_recommended, applicable_stages, cost_per_1m_input, cost_per_1m_output, max_context_tokens, notes)
VALUES
  ('openai', 'gpt-4o', 'GPT-4o', false, false,
   ARRAY['planner', 'worker', 'validator', 'operator'], 5.00, 15.00, 128000,
   'Future support - not yet enabled'),
  ('openai', 'gpt-4o-mini', 'GPT-4o Mini', false, false,
   ARRAY['worker'], 0.15, 0.60, 128000,
   'Future support - not yet enabled')
ON CONFLICT (provider_key, model_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  is_recommended = EXCLUDED.is_recommended,
  applicable_stages = EXCLUDED.applicable_stages,
  cost_per_1m_input = EXCLUDED.cost_per_1m_input,
  cost_per_1m_output = EXCLUDED.cost_per_1m_output,
  max_context_tokens = EXCLUDED.max_context_tokens,
  notes = EXCLUDED.notes,
  updated_at = NOW();

-- =============================================================================
-- 3. LLM Routing Policy Table
-- =============================================================================
CREATE TABLE IF NOT EXISTS llm_routing_policy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment TEXT NOT NULL DEFAULT 'DEV',          -- DEV, STAGING, PROD
  version INTEGER NOT NULL,                         -- Incrementing version number
  is_active BOOLEAN NOT NULL DEFAULT false,         -- Only one active per environment

  -- Policy document (JSONB for flexibility)
  policy JSONB NOT NULL,
  /*
    Expected structure:
    {
      "planner": {
        "primary_provider": "anthropic",
        "primary_model": "claude-3-5-sonnet-20241022",
        "fallback_provider": "vertex",
        "fallback_model": "gemini-1.5-pro"
      },
      "worker": { ... },
      "validator": { ... },
      "operator": { ... },
      "memory": { ... }
    }
  */

  -- Metadata
  created_by TEXT NOT NULL,                         -- User ID or 'system'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,                         -- When this version was activated
  deactivated_at TIMESTAMPTZ,                       -- When this version was deactivated

  UNIQUE(environment, version)
);

-- Create index for fast lookup of active policy
CREATE INDEX IF NOT EXISTS idx_llm_routing_policy_active
  ON llm_routing_policy(environment, is_active)
  WHERE is_active = true;

-- Seed initial DEV policy (v1, active)
INSERT INTO llm_routing_policy (environment, version, is_active, policy, created_by, activated_at)
VALUES (
  'DEV',
  1,
  true,
  '{
    "planner": {
      "primary_provider": "anthropic",
      "primary_model": "claude-3-5-sonnet-20241022",
      "fallback_provider": "vertex",
      "fallback_model": "gemini-1.5-pro"
    },
    "worker": {
      "primary_provider": "vertex",
      "primary_model": "gemini-1.5-flash",
      "fallback_provider": "vertex",
      "fallback_model": "gemini-1.5-pro"
    },
    "validator": {
      "primary_provider": "anthropic",
      "primary_model": "claude-3-5-sonnet-20241022",
      "fallback_provider": "vertex",
      "fallback_model": "gemini-1.5-pro"
    },
    "operator": {
      "primary_provider": "vertex",
      "primary_model": "gemini-2.5-pro",
      "fallback_provider": "anthropic",
      "fallback_model": "claude-3-5-sonnet-20241022"
    },
    "memory": {
      "primary_provider": "anthropic",
      "primary_model": "claude-3-5-sonnet-20241022",
      "fallback_provider": "vertex",
      "fallback_model": "gemini-1.5-flash"
    }
  }'::jsonb,
  'system',
  NOW()
)
ON CONFLICT (environment, version) DO NOTHING;

-- =============================================================================
-- 4. LLM Routing Policy Audit Table
-- =============================================================================
CREATE TABLE IF NOT EXISTS llm_routing_policy_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID REFERENCES llm_routing_policy(id) ON DELETE SET NULL,
  action TEXT NOT NULL,                             -- 'created', 'activated', 'deactivated', 'updated'
  actor_id TEXT NOT NULL,                           -- User ID or 'system'
  actor_role TEXT NOT NULL DEFAULT 'system',        -- 'developer', 'infra', 'admin', 'system'
  before_state JSONB,                               -- Previous policy state (null for creates)
  after_state JSONB,                                -- New policy state
  reason TEXT,                                      -- Optional reason for change
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create index for audit queries
CREATE INDEX IF NOT EXISTS idx_llm_routing_policy_audit_policy
  ON llm_routing_policy_audit(policy_id);
CREATE INDEX IF NOT EXISTS idx_llm_routing_policy_audit_created
  ON llm_routing_policy_audit(created_at DESC);

-- Seed initial audit record
INSERT INTO llm_routing_policy_audit (policy_id, action, actor_id, actor_role, after_state, reason)
SELECT
  id,
  'created',
  'system',
  'system',
  policy,
  'VTID-01208: Initial LLM routing policy setup'
FROM llm_routing_policy
WHERE environment = 'DEV' AND version = 1
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 5. VTID Execution Policy Snapshot (for policy locking)
-- =============================================================================
-- This table stores the policy snapshot when a VTID starts execution
-- to ensure in-flight VTIDs are not affected by policy changes.
CREATE TABLE IF NOT EXISTS llm_vtid_policy_snapshot (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vtid TEXT NOT NULL,                               -- VTID being executed
  policy_version INTEGER NOT NULL,                  -- Locked policy version
  policy_snapshot JSONB NOT NULL,                   -- Full policy copy at execution start
  environment TEXT NOT NULL DEFAULT 'DEV',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(vtid)                                      -- One snapshot per VTID
);

-- Index for fast VTID lookups
CREATE INDEX IF NOT EXISTS idx_llm_vtid_policy_snapshot_vtid
  ON llm_vtid_policy_snapshot(vtid);

-- =============================================================================
-- 6. Row Level Security (RLS)
-- =============================================================================

-- Enable RLS on all tables
ALTER TABLE llm_allowed_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_allowed_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_routing_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_routing_policy_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_vtid_policy_snapshot ENABLE ROW LEVEL SECURITY;

-- Read policies: all authenticated users can read
CREATE POLICY "llm_allowed_providers_read_all" ON llm_allowed_providers
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "llm_allowed_models_read_all" ON llm_allowed_models
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "llm_routing_policy_read_all" ON llm_routing_policy
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "llm_routing_policy_audit_read_all" ON llm_routing_policy_audit
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "llm_vtid_policy_snapshot_read_all" ON llm_vtid_policy_snapshot
  FOR SELECT TO authenticated USING (true);

-- Write policies: service role only (backend operations)
-- Note: In production, you would add role checks like:
-- auth.jwt() ->> 'role' IN ('developer', 'infra', 'admin')

CREATE POLICY "llm_allowed_providers_write_service" ON llm_allowed_providers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "llm_allowed_models_write_service" ON llm_allowed_models
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "llm_routing_policy_write_service" ON llm_routing_policy
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "llm_routing_policy_audit_write_service" ON llm_routing_policy_audit
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "llm_vtid_policy_snapshot_write_service" ON llm_vtid_policy_snapshot
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =============================================================================
-- 7. Helper Functions
-- =============================================================================

-- Function to get the active policy for an environment
CREATE OR REPLACE FUNCTION get_active_llm_policy(p_environment TEXT DEFAULT 'DEV')
RETURNS TABLE (
  id UUID,
  environment TEXT,
  version INTEGER,
  policy JSONB,
  activated_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    lrp.id,
    lrp.environment,
    lrp.version,
    lrp.policy,
    lrp.activated_at
  FROM llm_routing_policy lrp
  WHERE lrp.environment = p_environment
    AND lrp.is_active = true
  LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get locked policy for a VTID (or create snapshot if not exists)
CREATE OR REPLACE FUNCTION get_or_create_vtid_policy_snapshot(
  p_vtid TEXT,
  p_environment TEXT DEFAULT 'DEV'
)
RETURNS TABLE (
  vtid TEXT,
  policy_version INTEGER,
  policy_snapshot JSONB,
  is_new BOOLEAN
) AS $$
DECLARE
  v_existing RECORD;
  v_active_policy RECORD;
BEGIN
  -- Check if snapshot already exists
  SELECT * INTO v_existing
  FROM llm_vtid_policy_snapshot
  WHERE llm_vtid_policy_snapshot.vtid = p_vtid;

  IF FOUND THEN
    RETURN QUERY SELECT
      v_existing.vtid,
      v_existing.policy_version,
      v_existing.policy_snapshot,
      false AS is_new;
  ELSE
    -- Get active policy and create snapshot
    SELECT lrp.version, lrp.policy INTO v_active_policy
    FROM llm_routing_policy lrp
    WHERE lrp.environment = p_environment AND lrp.is_active = true
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'No active LLM routing policy found for environment %', p_environment;
    END IF;

    -- Insert snapshot
    INSERT INTO llm_vtid_policy_snapshot (vtid, policy_version, policy_snapshot, environment)
    VALUES (p_vtid, v_active_policy.version, v_active_policy.policy, p_environment);

    RETURN QUERY SELECT
      p_vtid,
      v_active_policy.version,
      v_active_policy.policy,
      true AS is_new;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- VTID-01208: LLM Routing Policy tables created successfully
--
-- Tables created:
-- - llm_allowed_providers: Registry of allowed LLM providers
-- - llm_allowed_models: Registry of allowed models per provider
-- - llm_routing_policy: Environment-scoped routing policies
-- - llm_routing_policy_audit: Audit log for policy changes
-- - llm_vtid_policy_snapshot: Policy snapshots for in-flight VTIDs
--
-- Functions created:
-- - get_active_llm_policy(environment): Get active policy
-- - get_or_create_vtid_policy_snapshot(vtid, environment): Lock policy for VTID
