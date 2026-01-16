-- =============================================================================
-- VTID-01183: Worker Agent Connector — Autonomous Task Execution Bridge
-- =============================================================================
-- Connects worker agents to the Autopilot Event Loop so dispatched tasks
-- are automatically picked up and executed.
--
-- Tables:
-- 1. worker_registry - Registered worker agents
-- 2. worker_task_claims - Atomic task claims with expiration
-- =============================================================================

-- =============================================================================
-- Table 1: Worker Registry
-- =============================================================================
CREATE TABLE IF NOT EXISTS worker_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id TEXT UNIQUE NOT NULL,
  capabilities TEXT[] DEFAULT '{}',
  max_concurrent INTEGER DEFAULT 1,
  registered_at TIMESTAMPTZ DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'terminated')),
  current_vtid TEXT,  -- Currently claimed VTID (if any)
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for active workers
CREATE INDEX IF NOT EXISTS idx_worker_registry_status
  ON worker_registry(status) WHERE status = 'active';

-- Index for heartbeat monitoring
CREATE INDEX IF NOT EXISTS idx_worker_registry_heartbeat
  ON worker_registry(last_heartbeat_at) WHERE status = 'active';

-- =============================================================================
-- Table 2: Worker Task Claims
-- =============================================================================
CREATE TABLE IF NOT EXISTS worker_task_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vtid TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  claimed_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  progress_events JSONB DEFAULT '[]',  -- Track progress updates
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unique constraint: only one active claim per VTID
CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_active_vtid
  ON worker_task_claims(vtid) WHERE released_at IS NULL;

-- Index for finding worker's active claims
CREATE INDEX IF NOT EXISTS idx_claims_worker_active
  ON worker_task_claims(worker_id) WHERE released_at IS NULL;

-- Index for expired claims cleanup
CREATE INDEX IF NOT EXISTS idx_claims_expires
  ON worker_task_claims(expires_at) WHERE released_at IS NULL;

-- =============================================================================
-- Table 3: Dispatched Tasks Queue (view of autopilot_run_state)
-- =============================================================================
-- Note: We use autopilot_run_state from VTID-01179 for task state
-- This view shows tasks ready for worker pickup

CREATE OR REPLACE VIEW worker_pending_tasks AS
SELECT
  r.vtid,
  r.state,
  r.run_id,
  r.started_at,
  r.spec_snapshot_id,
  r.updated_at as dispatched_at,
  l.title,
  l.summary as description
FROM autopilot_run_state r
LEFT JOIN vtid_ledger l ON r.vtid = l.vtid
WHERE r.state = 'in_progress'
  AND NOT EXISTS (
    SELECT 1 FROM worker_task_claims c
    WHERE c.vtid = r.vtid AND c.released_at IS NULL
  )
ORDER BY r.started_at ASC;

-- =============================================================================
-- Function: Claim Task Atomically
-- =============================================================================
CREATE OR REPLACE FUNCTION claim_worker_task(
  p_vtid TEXT,
  p_worker_id TEXT,
  p_expires_minutes INTEGER DEFAULT 60
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_claim_id UUID;
  v_expires_at TIMESTAMPTZ;
  v_existing_claim RECORD;
BEGIN
  -- Check for existing active claim
  SELECT * INTO v_existing_claim
  FROM worker_task_claims
  WHERE vtid = p_vtid AND released_at IS NULL
  FOR UPDATE SKIP LOCKED;

  IF FOUND THEN
    -- Check if expired
    IF v_existing_claim.expires_at < NOW() THEN
      -- Release expired claim
      UPDATE worker_task_claims
      SET released_at = NOW(),
          release_reason = 'expired',
          updated_at = NOW()
      WHERE id = v_existing_claim.id;
    ELSE
      -- Already claimed by another worker
      RETURN jsonb_build_object(
        'ok', false,
        'claimed', false,
        'reason', 'Task already claimed',
        'claimed_by', v_existing_claim.worker_id,
        'expires_at', v_existing_claim.expires_at
      );
    END IF;
  END IF;

  -- Verify task is in correct state
  IF NOT EXISTS (
    SELECT 1 FROM autopilot_run_state
    WHERE vtid = p_vtid AND state = 'in_progress'
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'claimed', false,
      'reason', 'Task not in dispatchable state'
    );
  END IF;

  -- Create claim
  v_expires_at := NOW() + (p_expires_minutes || ' minutes')::INTERVAL;

  INSERT INTO worker_task_claims (vtid, worker_id, expires_at)
  VALUES (p_vtid, p_worker_id, v_expires_at)
  RETURNING id INTO v_claim_id;

  -- Update worker's current task
  UPDATE worker_registry
  SET current_vtid = p_vtid,
      last_heartbeat_at = NOW(),
      updated_at = NOW()
  WHERE worker_id = p_worker_id;

  RETURN jsonb_build_object(
    'ok', true,
    'claimed', true,
    'claim_id', v_claim_id,
    'vtid', p_vtid,
    'worker_id', p_worker_id,
    'expires_at', v_expires_at
  );
END;
$$;

-- =============================================================================
-- Function: Release Task Claim
-- =============================================================================
CREATE OR REPLACE FUNCTION release_worker_task(
  p_vtid TEXT,
  p_worker_id TEXT,
  p_reason TEXT DEFAULT 'completed'
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_claim RECORD;
BEGIN
  -- Find active claim
  SELECT * INTO v_claim
  FROM worker_task_claims
  WHERE vtid = p_vtid
    AND worker_id = p_worker_id
    AND released_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'No active claim found'
    );
  END IF;

  -- Release claim
  UPDATE worker_task_claims
  SET released_at = NOW(),
      release_reason = p_reason,
      updated_at = NOW()
  WHERE id = v_claim.id;

  -- Clear worker's current task
  UPDATE worker_registry
  SET current_vtid = NULL,
      updated_at = NOW()
  WHERE worker_id = p_worker_id;

  RETURN jsonb_build_object(
    'ok', true,
    'released', true,
    'vtid', p_vtid,
    'reason', p_reason
  );
END;
$$;

-- =============================================================================
-- Function: Worker Heartbeat
-- =============================================================================
CREATE OR REPLACE FUNCTION worker_heartbeat(
  p_worker_id TEXT,
  p_active_vtid TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_worker RECORD;
BEGIN
  -- Update heartbeat
  UPDATE worker_registry
  SET last_heartbeat_at = NOW(),
      current_vtid = COALESCE(p_active_vtid, current_vtid),
      updated_at = NOW()
  WHERE worker_id = p_worker_id
  RETURNING * INTO v_worker;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'Worker not registered'
    );
  END IF;

  -- Extend claim expiry if actively working
  IF p_active_vtid IS NOT NULL THEN
    UPDATE worker_task_claims
    SET expires_at = NOW() + INTERVAL '60 minutes',
        updated_at = NOW()
    WHERE vtid = p_active_vtid
      AND worker_id = p_worker_id
      AND released_at IS NULL;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'worker_id', p_worker_id,
    'heartbeat_at', NOW(),
    'current_vtid', v_worker.current_vtid
  );
END;
$$;

-- =============================================================================
-- Function: Expire Stale Claims
-- =============================================================================
CREATE OR REPLACE FUNCTION expire_stale_worker_claims()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH expired AS (
    UPDATE worker_task_claims
    SET released_at = NOW(),
        release_reason = 'expired',
        updated_at = NOW()
    WHERE released_at IS NULL
      AND expires_at < NOW()
    RETURNING vtid, worker_id
  )
  SELECT COUNT(*) INTO v_count FROM expired;

  -- Clear current_vtid for workers with expired claims
  UPDATE worker_registry w
  SET current_vtid = NULL,
      updated_at = NOW()
  WHERE EXISTS (
    SELECT 1 FROM worker_task_claims c
    WHERE c.worker_id = w.worker_id
      AND c.release_reason = 'expired'
      AND c.released_at > NOW() - INTERVAL '1 minute'
  );

  RETURN v_count;
END;
$$;

-- =============================================================================
-- Function: Get Worker Stats
-- =============================================================================
CREATE OR REPLACE FUNCTION get_worker_connector_stats()
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'total_workers', (SELECT COUNT(*) FROM worker_registry),
    'active_workers', (SELECT COUNT(*) FROM worker_registry WHERE status = 'active'),
    'workers_with_tasks', (SELECT COUNT(*) FROM worker_registry WHERE current_vtid IS NOT NULL),
    'pending_tasks', (SELECT COUNT(*) FROM worker_pending_tasks),
    'active_claims', (SELECT COUNT(*) FROM worker_task_claims WHERE released_at IS NULL),
    'claims_today', (SELECT COUNT(*) FROM worker_task_claims WHERE created_at > NOW() - INTERVAL '1 day'),
    'completed_today', (SELECT COUNT(*) FROM worker_task_claims WHERE release_reason = 'completed' AND released_at > NOW() - INTERVAL '1 day')
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- =============================================================================
-- RLS Policies
-- =============================================================================
ALTER TABLE worker_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_task_claims ENABLE ROW LEVEL SECURITY;

-- Service role has full access
CREATE POLICY "Service role full access to worker_registry"
  ON worker_registry FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access to worker_task_claims"
  ON worker_task_claims FOR ALL
  USING (auth.role() = 'service_role');

-- =============================================================================
-- Done
-- =============================================================================
