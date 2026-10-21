-- =============================================================================
-- VTID-01117: Context Window Management & Saturation Control
-- =============================================================================
--
-- This migration creates the infrastructure for tracking context window
-- selection metrics, enabling:
-- - Auditable context composition per turn
-- - Performance tuning insights
-- - Explainability for D59
-- - Debugging context saturation issues
--
-- Position in Intelligence Stack:
--   Memory Scoring (D23) → Confidence (D24) → D25 Context Window Control → Context Assembly (D20)
-- =============================================================================

-- =============================================================================
-- 1. Context Window Logs Table
-- Stores per-turn context selection decisions for traceability
-- =============================================================================

CREATE TABLE IF NOT EXISTS context_window_logs (
  -- Primary key
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Context identification
  log_id TEXT NOT NULL UNIQUE,           -- Unique log identifier (ctx-xxx-xxx)
  turn_id TEXT NOT NULL,                 -- Turn/request identifier
  user_id UUID NOT NULL,                 -- User this context was for
  tenant_id UUID NOT NULL,               -- Tenant context

  -- Selection metrics (from ContextMetrics)
  total_chars INTEGER NOT NULL DEFAULT 0,
  total_items INTEGER NOT NULL DEFAULT 0,
  excluded_count INTEGER NOT NULL DEFAULT 0,
  diversity_score NUMERIC(5, 4) NOT NULL DEFAULT 0,      -- 0.0000 to 1.0000
  budget_utilization NUMERIC(5, 4) NOT NULL DEFAULT 0,   -- 0.0000 to 1.0000
  avg_relevance_score NUMERIC(5, 2) NOT NULL DEFAULT 0,  -- 0.00 to 100.00
  avg_confidence_score NUMERIC(5, 2) NOT NULL DEFAULT 0, -- 0.00 to 100.00
  processing_time_ms INTEGER NOT NULL DEFAULT 0,

  -- Per-domain breakdown (JSONB for flexibility)
  domain_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Example: {"personal": {"itemCount": 3, "charCount": 500, "excludedCount": 1}}

  -- Exclusion details (JSONB array)
  exclusion_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Example: {"domain_cap_exceeded": 5, "redundant_content": 2}

  -- Configuration snapshot for reproducibility
  config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Timestamps
  selected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Determinism flag (should always be true)
  deterministic BOOLEAN NOT NULL DEFAULT TRUE,

  -- Indexes for common queries
  CONSTRAINT fk_context_logs_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE
);

-- Index for querying by user and time
CREATE INDEX IF NOT EXISTS idx_context_window_logs_user_time
  ON context_window_logs(user_id, selected_at DESC);

-- Index for querying by tenant and time
CREATE INDEX IF NOT EXISTS idx_context_window_logs_tenant_time
  ON context_window_logs(tenant_id, selected_at DESC);

-- Index for querying by turn ID
CREATE INDEX IF NOT EXISTS idx_context_window_logs_turn
  ON context_window_logs(turn_id);

-- Index for diversity analysis
CREATE INDEX IF NOT EXISTS idx_context_window_logs_diversity
  ON context_window_logs(diversity_score);

-- Index for budget utilization analysis
CREATE INDEX IF NOT EXISTS idx_context_window_logs_budget
  ON context_window_logs(budget_utilization);

-- =============================================================================
-- 2. Context Window Config Table
-- Stores configurable budget settings (can be per-tenant in future)
-- =============================================================================

CREATE TABLE IF NOT EXISTS context_window_configs (
  -- Primary key
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Config identification
  config_name TEXT NOT NULL UNIQUE,       -- e.g., 'default', 'high_performance', etc.
  tenant_id UUID,                         -- NULL = global default

  -- Budget configuration (JSONB for full flexibility)
  total_budget_chars INTEGER NOT NULL DEFAULT 6000,
  total_item_limit INTEGER NOT NULL DEFAULT 30,

  -- Domain budgets
  domain_budgets JSONB NOT NULL DEFAULT '{
    "personal": {"maxItems": 5, "maxChars": 1200, "minRelevanceScore": 20, "minConfidenceThreshold": 0},
    "relationships": {"maxItems": 4, "maxChars": 800, "minRelevanceScore": 30, "minConfidenceThreshold": 20},
    "health": {"maxItems": 4, "maxChars": 800, "minRelevanceScore": 40, "minConfidenceThreshold": 40},
    "goals": {"maxItems": 3, "maxChars": 600, "minRelevanceScore": 40, "minConfidenceThreshold": 30},
    "preferences": {"maxItems": 4, "maxChars": 600, "minRelevanceScore": 35, "minConfidenceThreshold": 30},
    "conversation": {"maxItems": 5, "maxChars": 1000, "minRelevanceScore": 30, "minConfidenceThreshold": 20},
    "tasks": {"maxItems": 3, "maxChars": 400, "minRelevanceScore": 50, "minConfidenceThreshold": 40},
    "community": {"maxItems": 2, "maxChars": 300, "minRelevanceScore": 50, "minConfidenceThreshold": 50},
    "events_meetups": {"maxItems": 2, "maxChars": 300, "minRelevanceScore": 50, "minConfidenceThreshold": 50},
    "products_services": {"maxItems": 2, "maxChars": 200, "minRelevanceScore": 60, "minConfidenceThreshold": 50},
    "notes": {"maxItems": 2, "maxChars": 200, "minRelevanceScore": 50, "minConfidenceThreshold": 40}
  }'::jsonb,

  -- Saturation thresholds
  saturation_thresholds JSONB NOT NULL DEFAULT '{
    "redundancySimilarity": 0.75,
    "topicRepetitionLimit": 3,
    "minDiversityScore": 0.4,
    "similarityDownWeight": 0.5
  }'::jsonb,

  -- Memory type weights
  memory_type_weights JSONB NOT NULL DEFAULT '{
    "recent": 0.5,
    "long_term": 0.35,
    "pattern": 0.15
  }'::jsonb,

  -- Status and metadata
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Optional tenant constraint
  CONSTRAINT fk_context_config_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE
);

-- Index for active configs
CREATE INDEX IF NOT EXISTS idx_context_window_configs_active
  ON context_window_configs(is_active, tenant_id);

-- =============================================================================
-- 3. Insert default configuration
-- =============================================================================

INSERT INTO context_window_configs (config_name, description)
VALUES (
  'default',
  'VTID-01117: Default context window configuration. Balanced budget allocation across domains with saturation control.'
)
ON CONFLICT (config_name) DO NOTHING;

-- =============================================================================
-- 4. Context Quality Aggregates View
-- Provides aggregate metrics for monitoring context window performance
-- =============================================================================

CREATE OR REPLACE VIEW context_window_quality_summary AS
SELECT
  tenant_id,
  DATE(selected_at) as date,
  COUNT(*) as total_turns,
  ROUND(AVG(total_items), 2) as avg_items,
  ROUND(AVG(total_chars), 2) as avg_chars,
  ROUND(AVG(excluded_count), 2) as avg_excluded,
  ROUND(AVG(diversity_score), 4) as avg_diversity,
  ROUND(AVG(budget_utilization), 4) as avg_budget_util,
  ROUND(AVG(avg_relevance_score), 2) as avg_relevance,
  ROUND(AVG(avg_confidence_score), 2) as avg_confidence,
  ROUND(AVG(processing_time_ms), 2) as avg_processing_ms,
  MAX(processing_time_ms) as max_processing_ms,
  -- Count turns with low diversity (potential saturation issue)
  SUM(CASE WHEN diversity_score < 0.4 THEN 1 ELSE 0 END) as low_diversity_turns,
  -- Count turns with high exclusions (potential budget pressure)
  SUM(CASE WHEN excluded_count > 10 THEN 1 ELSE 0 END) as high_exclusion_turns
FROM context_window_logs
GROUP BY tenant_id, DATE(selected_at);

-- =============================================================================
-- 5. Helper function: Get context window stats for a user
-- =============================================================================

CREATE OR REPLACE FUNCTION get_context_window_stats(
  p_user_id UUID,
  p_days INTEGER DEFAULT 7
)
RETURNS TABLE (
  total_turns BIGINT,
  avg_items NUMERIC,
  avg_chars NUMERIC,
  avg_diversity NUMERIC,
  avg_budget_util NUMERIC,
  avg_excluded NUMERIC,
  avg_processing_ms NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COUNT(*)::BIGINT as total_turns,
    ROUND(AVG(total_items), 2) as avg_items,
    ROUND(AVG(total_chars), 2) as avg_chars,
    ROUND(AVG(diversity_score), 4) as avg_diversity,
    ROUND(AVG(budget_utilization), 4) as avg_budget_util,
    ROUND(AVG(excluded_count), 2) as avg_excluded,
    ROUND(AVG(processing_time_ms), 2) as avg_processing_ms
  FROM context_window_logs
  WHERE user_id = p_user_id
    AND selected_at >= NOW() - (p_days || ' days')::INTERVAL;
$$;

-- =============================================================================
-- 6. Helper function: Get exclusion breakdown for a user
-- =============================================================================

CREATE OR REPLACE FUNCTION get_context_exclusion_breakdown(
  p_user_id UUID,
  p_days INTEGER DEFAULT 7
)
RETURNS TABLE (
  exclusion_reason TEXT,
  occurrence_count BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    key as exclusion_reason,
    SUM((value::text)::INTEGER)::BIGINT as occurrence_count
  FROM context_window_logs,
    LATERAL jsonb_each(exclusion_summary)
  WHERE user_id = p_user_id
    AND selected_at >= NOW() - (p_days || ' days')::INTERVAL
  GROUP BY key
  ORDER BY occurrence_count DESC;
$$;

-- =============================================================================
-- 7. RLS Policies
-- =============================================================================

ALTER TABLE context_window_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_window_configs ENABLE ROW LEVEL SECURITY;

-- Service role can access all logs
CREATE POLICY context_window_logs_service_all ON context_window_logs
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- Users can read their own logs
CREATE POLICY context_window_logs_user_select ON context_window_logs
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Service role can manage configs
CREATE POLICY context_window_configs_service_all ON context_window_configs
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- Users can read active configs
CREATE POLICY context_window_configs_user_select ON context_window_configs
  FOR SELECT
  TO authenticated
  USING (is_active = TRUE);

-- =============================================================================
-- 8. Grant permissions
-- =============================================================================

GRANT SELECT, INSERT ON context_window_logs TO service_role;
GRANT SELECT ON context_window_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE ON context_window_configs TO service_role;
GRANT SELECT ON context_window_configs TO authenticated;

-- =============================================================================
-- 9. Comments for documentation
-- =============================================================================

COMMENT ON TABLE context_window_logs IS 'VTID-01117: Stores per-turn context window selection decisions for traceability and debugging';
COMMENT ON TABLE context_window_configs IS 'VTID-01117: Configurable context window budget settings';
COMMENT ON VIEW context_window_quality_summary IS 'VTID-01117: Aggregate metrics for monitoring context window performance';
COMMENT ON FUNCTION get_context_window_stats IS 'VTID-01117: Get context window statistics for a user over N days';
COMMENT ON FUNCTION get_context_exclusion_breakdown IS 'VTID-01117: Get breakdown of exclusion reasons for a user over N days';
