-- =============================================================================
-- VTID-01192: Infinite Memory v2 - Unified Thread Contract & Immutable Facts
-- =============================================================================
--
-- This migration implements:
-- 1. memory_facts - Immutable facts with provenance tracking
-- 2. active_threads - Thread ID resolution per user
-- 3. thread_summaries - Rolling summaries for context compression
--
-- GOVERNANCE:
-- - Facts are append-only (immutable)
-- - All tables enforce tenant isolation via RLS
-- - Provenance is mandatory for all facts
-- =============================================================================

-- =============================================================================
-- 1. MEMORY_FACTS TABLE - Immutable Facts with Provenance
-- =============================================================================

CREATE TABLE IF NOT EXISTS memory_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ISOLATION (REQUIRED)
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,

  -- OPTIONAL: Thread association (facts can be thread-independent)
  thread_id UUID,

  -- ENTITY SCOPE
  -- 'self' = fact about the user themselves
  -- 'disclosed' = fact the user disclosed about someone else
  entity TEXT NOT NULL DEFAULT 'self' CHECK (entity IN ('self', 'disclosed')),

  -- FACT CONTENT
  -- key = semantic key (e.g., 'birthday', 'residence', 'spouse_name')
  -- value = the actual value (stored as text, can be JSON for complex values)
  fact_key TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  fact_value_type TEXT NOT NULL DEFAULT 'text' CHECK (fact_value_type IN ('text', 'date', 'number', 'json')),

  -- PROVENANCE (REQUIRED)
  provenance_source TEXT NOT NULL CHECK (provenance_source IN ('user_stated', 'assistant_inferred', 'system_observed')),
  provenance_utterance_id UUID, -- Links to the original message/turn
  provenance_confidence NUMERIC(3,2) NOT NULL DEFAULT 0.90 CHECK (provenance_confidence >= 0 AND provenance_confidence <= 1),

  -- CONFLICT TRACKING
  -- When a newer fact supersedes this one, record the superseding fact ID
  superseded_by UUID REFERENCES memory_facts(id),
  superseded_at TIMESTAMPTZ,

  -- METADATA
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- VTID tracking
  vtid TEXT DEFAULT 'VTID-01192'
);

-- Indexes for memory_facts
CREATE INDEX IF NOT EXISTS idx_memory_facts_tenant_user
  ON memory_facts(tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_memory_facts_key
  ON memory_facts(user_id, fact_key);

CREATE INDEX IF NOT EXISTS idx_memory_facts_entity
  ON memory_facts(user_id, entity);

CREATE INDEX IF NOT EXISTS idx_memory_facts_not_superseded
  ON memory_facts(user_id, fact_key)
  WHERE superseded_by IS NULL;

-- RLS for memory_facts
ALTER TABLE memory_facts ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own facts within their tenant
CREATE POLICY memory_facts_tenant_user_isolation ON memory_facts
  FOR ALL
  USING (
    tenant_id = COALESCE(
      current_setting('app.tenant_id', true)::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
    AND user_id = COALESCE(
      current_setting('app.user_id', true)::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  );

-- =============================================================================
-- 2. ACTIVE_THREADS TABLE - Thread ID Resolution per User
-- =============================================================================

CREATE TABLE IF NOT EXISTS active_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ISOLATION (REQUIRED)
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,

  -- CONTEXT
  -- role helps disambiguate threads (user might have different active threads for different roles)
  active_role TEXT NOT NULL DEFAULT 'user',

  -- THREAD STATE
  thread_id UUID NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  turn_count INTEGER NOT NULL DEFAULT 0,

  -- METADATA
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- UNIQUE constraint: one active thread per (tenant, user, role)
  CONSTRAINT active_threads_unique_per_user_role
    UNIQUE (tenant_id, user_id, active_role),

  -- VTID tracking
  vtid TEXT DEFAULT 'VTID-01192'
);

-- Indexes for active_threads
CREATE INDEX IF NOT EXISTS idx_active_threads_lookup
  ON active_threads(tenant_id, user_id, active_role);

CREATE INDEX IF NOT EXISTS idx_active_threads_activity
  ON active_threads(last_activity_at);

-- RLS for active_threads
ALTER TABLE active_threads ENABLE ROW LEVEL SECURITY;

CREATE POLICY active_threads_tenant_user_isolation ON active_threads
  FOR ALL
  USING (
    tenant_id = COALESCE(
      current_setting('app.tenant_id', true)::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
    AND user_id = COALESCE(
      current_setting('app.user_id', true)::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  );

-- =============================================================================
-- 3. THREAD_SUMMARIES TABLE - Rolling Summaries
-- =============================================================================

CREATE TABLE IF NOT EXISTS thread_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ISOLATION (REQUIRED)
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  thread_id UUID NOT NULL,

  -- SUMMARY CONTENT
  summary_type TEXT NOT NULL CHECK (summary_type IN ('short', 'long')),
  summary_text TEXT NOT NULL,

  -- VERSIONING
  version INTEGER NOT NULL DEFAULT 1,
  covers_turns_from INTEGER NOT NULL DEFAULT 1,
  covers_turns_to INTEGER NOT NULL,

  -- GENERATION METADATA
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  generation_model TEXT, -- Which model generated this summary

  -- HASH for idempotency (same input = same summary)
  content_hash TEXT NOT NULL,

  -- VTID tracking
  vtid TEXT DEFAULT 'VTID-01192',

  -- UNIQUE constraint: one summary per (thread, type, version)
  CONSTRAINT thread_summaries_unique_version
    UNIQUE (thread_id, summary_type, version)
);

-- Indexes for thread_summaries
CREATE INDEX IF NOT EXISTS idx_thread_summaries_thread
  ON thread_summaries(thread_id, summary_type);

CREATE INDEX IF NOT EXISTS idx_thread_summaries_latest
  ON thread_summaries(thread_id, summary_type, version DESC);

-- RLS for thread_summaries
ALTER TABLE thread_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY thread_summaries_tenant_user_isolation ON thread_summaries
  FOR ALL
  USING (
    tenant_id = COALESCE(
      current_setting('app.tenant_id', true)::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
    AND user_id = COALESCE(
      current_setting('app.user_id', true)::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  );

-- =============================================================================
-- 4. RPC FUNCTIONS
-- =============================================================================

-- Function: Get current facts for a user (excluding superseded)
CREATE OR REPLACE FUNCTION get_current_facts(
  p_tenant_id UUID,
  p_user_id UUID,
  p_entity TEXT DEFAULT NULL,
  p_fact_keys TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  entity TEXT,
  fact_key TEXT,
  fact_value TEXT,
  fact_value_type TEXT,
  provenance_source TEXT,
  provenance_confidence NUMERIC,
  extracted_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    mf.id,
    mf.entity,
    mf.fact_key,
    mf.fact_value,
    mf.fact_value_type,
    mf.provenance_source,
    mf.provenance_confidence,
    mf.extracted_at
  FROM memory_facts mf
  WHERE mf.tenant_id = p_tenant_id
    AND mf.user_id = p_user_id
    AND mf.superseded_by IS NULL  -- Only current facts
    AND (p_entity IS NULL OR mf.entity = p_entity)
    AND (p_fact_keys IS NULL OR mf.fact_key = ANY(p_fact_keys))
  ORDER BY mf.extracted_at DESC;
END;
$$;

-- Function: Write a new fact (handles supersession)
CREATE OR REPLACE FUNCTION write_fact(
  p_tenant_id UUID,
  p_user_id UUID,
  p_fact_key TEXT,
  p_fact_value TEXT,
  p_entity TEXT DEFAULT 'self',
  p_fact_value_type TEXT DEFAULT 'text',
  p_provenance_source TEXT DEFAULT 'user_stated',
  p_provenance_utterance_id UUID DEFAULT NULL,
  p_provenance_confidence NUMERIC DEFAULT 0.90,
  p_thread_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_fact_id UUID;
  v_old_fact_id UUID;
BEGIN
  -- Generate new fact ID
  v_new_fact_id := gen_random_uuid();

  -- Find existing fact with same key (if any)
  SELECT id INTO v_old_fact_id
  FROM memory_facts
  WHERE tenant_id = p_tenant_id
    AND user_id = p_user_id
    AND fact_key = p_fact_key
    AND entity = p_entity
    AND superseded_by IS NULL
  LIMIT 1;

  -- Mark old fact as superseded (if exists)
  IF v_old_fact_id IS NOT NULL THEN
    UPDATE memory_facts
    SET superseded_by = v_new_fact_id,
        superseded_at = now()
    WHERE id = v_old_fact_id;
  END IF;

  -- Insert new fact
  INSERT INTO memory_facts (
    id,
    tenant_id,
    user_id,
    thread_id,
    entity,
    fact_key,
    fact_value,
    fact_value_type,
    provenance_source,
    provenance_utterance_id,
    provenance_confidence
  ) VALUES (
    v_new_fact_id,
    p_tenant_id,
    p_user_id,
    p_thread_id,
    p_entity,
    p_fact_key,
    p_fact_value,
    p_fact_value_type,
    p_provenance_source,
    p_provenance_utterance_id,
    p_provenance_confidence
  );

  RETURN v_new_fact_id;
END;
$$;

-- Function: Resolve or create thread ID
CREATE OR REPLACE FUNCTION resolve_thread_id(
  p_tenant_id UUID,
  p_user_id UUID,
  p_active_role TEXT DEFAULT 'user',
  p_provided_thread_id UUID DEFAULT NULL,
  p_session_timeout_hours INTEGER DEFAULT 4
)
RETURNS TABLE (
  thread_id UUID,
  is_new BOOLEAN,
  resumed BOOLEAN,
  turn_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_thread_id UUID;
  v_is_new BOOLEAN := FALSE;
  v_resumed BOOLEAN := FALSE;
  v_turn_count INTEGER := 0;
  v_existing RECORD;
BEGIN
  -- If thread_id provided, use it directly
  IF p_provided_thread_id IS NOT NULL THEN
    -- Check if we have an active_threads entry for this
    SELECT * INTO v_existing
    FROM active_threads
    WHERE tenant_id = p_tenant_id
      AND user_id = p_user_id
      AND active_role = p_active_role
      AND thread_id = p_provided_thread_id;

    IF v_existing IS NOT NULL THEN
      -- Update last activity
      UPDATE active_threads
      SET last_activity_at = now()
      WHERE id = v_existing.id;

      v_thread_id := p_provided_thread_id;
      v_turn_count := v_existing.turn_count;
      v_resumed := TRUE;
    ELSE
      -- Create new active_threads entry for provided thread_id
      INSERT INTO active_threads (tenant_id, user_id, active_role, thread_id)
      VALUES (p_tenant_id, p_user_id, p_active_role, p_provided_thread_id)
      ON CONFLICT (tenant_id, user_id, active_role)
      DO UPDATE SET
        thread_id = p_provided_thread_id,
        last_activity_at = now(),
        turn_count = 0;

      v_thread_id := p_provided_thread_id;
      v_is_new := TRUE;
    END IF;
  ELSE
    -- No thread_id provided, check for active thread within timeout
    SELECT * INTO v_existing
    FROM active_threads
    WHERE tenant_id = p_tenant_id
      AND user_id = p_user_id
      AND active_role = p_active_role
      AND last_activity_at > (now() - (p_session_timeout_hours || ' hours')::interval);

    IF v_existing IS NOT NULL THEN
      -- Resume existing thread
      UPDATE active_threads
      SET last_activity_at = now()
      WHERE id = v_existing.id;

      v_thread_id := v_existing.thread_id;
      v_turn_count := v_existing.turn_count;
      v_resumed := TRUE;
    ELSE
      -- Create new thread
      v_thread_id := gen_random_uuid();
      v_is_new := TRUE;

      INSERT INTO active_threads (tenant_id, user_id, active_role, thread_id)
      VALUES (p_tenant_id, p_user_id, p_active_role, v_thread_id)
      ON CONFLICT (tenant_id, user_id, active_role)
      DO UPDATE SET
        thread_id = v_thread_id,
        last_activity_at = now(),
        turn_count = 0;
    END IF;
  END IF;

  RETURN QUERY SELECT v_thread_id, v_is_new, v_resumed, v_turn_count;
END;
$$;

-- Function: Increment turn count for a thread
CREATE OR REPLACE FUNCTION increment_thread_turn(
  p_tenant_id UUID,
  p_user_id UUID,
  p_thread_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_count INTEGER;
BEGIN
  UPDATE active_threads
  SET turn_count = turn_count + 1,
      last_activity_at = now()
  WHERE tenant_id = p_tenant_id
    AND user_id = p_user_id
    AND thread_id = p_thread_id
  RETURNING turn_count INTO v_new_count;

  RETURN COALESCE(v_new_count, 0);
END;
$$;

-- Function: Get latest thread summary
CREATE OR REPLACE FUNCTION get_thread_summary(
  p_thread_id UUID,
  p_summary_type TEXT DEFAULT 'short'
)
RETURNS TABLE (
  summary_text TEXT,
  version INTEGER,
  covers_turns_to INTEGER,
  generated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ts.summary_text,
    ts.version,
    ts.covers_turns_to,
    ts.generated_at
  FROM thread_summaries ts
  WHERE ts.thread_id = p_thread_id
    AND ts.summary_type = p_summary_type
  ORDER BY ts.version DESC
  LIMIT 1;
END;
$$;

-- =============================================================================
-- 5. COMMENTS FOR DOCUMENTATION
-- =============================================================================

COMMENT ON TABLE memory_facts IS 'VTID-01192: Immutable facts with provenance tracking. Facts are append-only - updates create new facts that supersede old ones.';
COMMENT ON TABLE active_threads IS 'VTID-01192: Thread ID resolution per user. Enables device-switching continuity.';
COMMENT ON TABLE thread_summaries IS 'VTID-01192: Rolling summaries for context compression. Summaries are versioned and regenerated from facts + recent turns.';

COMMENT ON FUNCTION get_current_facts IS 'VTID-01192: Retrieve current (non-superseded) facts for a user.';
COMMENT ON FUNCTION write_fact IS 'VTID-01192: Write a new fact, automatically superseding any existing fact with the same key.';
COMMENT ON FUNCTION resolve_thread_id IS 'VTID-01192: Resolve thread ID for a session. Returns existing thread if within timeout, creates new otherwise.';
COMMENT ON FUNCTION increment_thread_turn IS 'VTID-01192: Increment turn count for a thread.';
COMMENT ON FUNCTION get_thread_summary IS 'VTID-01192: Get the latest summary for a thread.';

-- =============================================================================
-- 6. GRANTS
-- =============================================================================

-- Grant execute permissions on functions (service role)
GRANT EXECUTE ON FUNCTION get_current_facts TO service_role;
GRANT EXECUTE ON FUNCTION write_fact TO service_role;
GRANT EXECUTE ON FUNCTION resolve_thread_id TO service_role;
GRANT EXECUTE ON FUNCTION increment_thread_turn TO service_role;
GRANT EXECUTE ON FUNCTION get_thread_summary TO service_role;

-- Grant table permissions
GRANT SELECT, INSERT, UPDATE ON memory_facts TO service_role;
GRANT SELECT, INSERT, UPDATE ON active_threads TO service_role;
GRANT SELECT, INSERT ON thread_summaries TO service_role;
