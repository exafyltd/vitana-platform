-- =============================================================================
-- VTID-01183: Worker Agent Connector — Autonomous Task Execution Bridge
-- =============================================================================
-- Connects worker agents to the Autopilot Event Loop so dispatched tasks
-- are automatically picked up and executed.
--
-- Design:
-- 1. Claims are embedded in vtid_ledger (single source of truth)
-- 2. worker_registry tracks worker agents (capabilities, health)
-- 3. Atomic claim via DB constraint enforcement
-- =============================================================================

-- =============================================================================
-- Step 1: Add claim fields to vtid_ledger (claims embedded in ledger)
-- =============================================================================

-- Add claim columns to vtid_ledger (if they don't exist)
ALTER TABLE vtid_ledger ADD COLUMN IF NOT EXISTS claimed_by TEXT;
ALTER TABLE vtid_ledger ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;
ALTER TABLE vtid_ledger ADD COLUMN IF NOT EXISTS claim_started_at TIMESTAMPTZ;

-- Index for finding unclaimed tasks in_progress
CREATE INDEX IF NOT EXISTS idx_vtid_ledger_unclaimed
  ON vtid_ledger(status, claimed_by)
  WHERE status = 'in_progress' AND claimed_by IS NULL;

-- Index for finding worker's active claims
CREATE INDEX IF NOT EXISTS idx_vtid_ledger_claimed_by
  ON vtid_ledger(claimed_by) WHERE claimed_by IS NOT NULL;

-- Index for expired claims
CREATE INDEX IF NOT EXISTS idx_vtid_ledger_claim_expires
  ON vtid_ledger(claim_expires_at)
  WHERE claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL;

-- =============================================================================
-- Step 2: Worker Registry Table (capabilities, versioning, health)
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
  version TEXT DEFAULT '1.0.0',
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
-- Step 3: Atomic Task Claim Function (updates vtid_ledger directly)
-- =============================================================================
CREATE OR REPLACE FUNCTION claim_vtid_task(
  p_vtid TEXT,
  p_worker_id TEXT,
  p_expires_minutes INTEGER DEFAULT 60
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_ledger RECORD;
  v_expires_at TIMESTAMPTZ;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  -- Lock the row for update
  SELECT * INTO v_ledger
  FROM vtid_ledger
  WHERE vtid = p_vtid
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'claimed', false,
      'reason', 'VTID not found'
    );
  END IF;

  -- Check if task is in claimable state
  IF v_ledger.status NOT IN ('in_progress', 'allocated') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'claimed', false,
      'reason', format('Task not in claimable state: %s', v_ledger.status)
    );
  END IF;

  -- Check if already claimed by another worker
  IF v_ledger.claimed_by IS NOT NULL THEN
    -- Check if expired
    IF v_ledger.claim_expires_at IS NOT NULL AND v_ledger.claim_expires_at < v_now THEN
      -- Expired claim - release it and let this worker claim
      NULL; -- Will be overwritten below
    ELSIF v_ledger.claimed_by = p_worker_id THEN
      -- Same worker reclaiming - extend the claim
      NULL; -- Will be overwritten below
    ELSE
      -- Another worker has active claim
      RETURN jsonb_build_object(
        'ok', false,
        'claimed', false,
        'reason', 'Task already claimed',
        'claimed_by', v_ledger.claimed_by,
        'expires_at', v_ledger.claim_expires_at
      );
    END IF;
  END IF;

  -- Calculate expiration
  v_expires_at := v_now + (p_expires_minutes || ' minutes')::INTERVAL;

  -- Claim the task
  UPDATE vtid_ledger
  SET claimed_by = p_worker_id,
      claim_expires_at = v_expires_at,
      claim_started_at = COALESCE(claim_started_at, v_now),
      updated_at = v_now
  WHERE vtid = p_vtid;

  -- Update worker registry
  UPDATE worker_registry
  SET current_vtid = p_vtid,
      last_heartbeat_at = v_now,
      updated_at = v_now
  WHERE worker_id = p_worker_id;

  RETURN jsonb_build_object(
    'ok', true,
    'claimed', true,
    'vtid', p_vtid,
    'worker_id', p_worker_id,
    'expires_at', v_expires_at,
    'title', v_ledger.title,
    'summary', v_ledger.summary
  );
END;
$$;

-- =============================================================================
-- Step 4: Release Task Claim Function
-- =============================================================================
CREATE OR REPLACE FUNCTION release_vtid_claim(
  p_vtid TEXT,
  p_worker_id TEXT,
  p_reason TEXT DEFAULT 'completed'
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_ledger RECORD;
BEGIN
  -- Lock and get the row
  SELECT * INTO v_ledger
  FROM vtid_ledger
  WHERE vtid = p_vtid
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'VTID not found'
    );
  END IF;

  -- Verify worker owns the claim
  IF v_ledger.claimed_by IS NULL OR v_ledger.claimed_by != p_worker_id THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'Worker does not own this claim'
    );
  END IF;

  -- Release the claim
  UPDATE vtid_ledger
  SET claimed_by = NULL,
      claim_expires_at = NULL,
      updated_at = NOW()
  WHERE vtid = p_vtid;

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
-- Step 5: Worker Heartbeat Function
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
    UPDATE vtid_ledger
    SET claim_expires_at = NOW() + INTERVAL '60 minutes',
        updated_at = NOW()
    WHERE vtid = p_active_vtid
      AND claimed_by = p_worker_id;
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
-- Step 6: Expire Stale Claims Function
-- =============================================================================
CREATE OR REPLACE FUNCTION expire_stale_vtid_claims()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Release expired claims
  WITH expired AS (
    UPDATE vtid_ledger
    SET claimed_by = NULL,
        claim_expires_at = NULL,
        updated_at = NOW()
    WHERE claimed_by IS NOT NULL
      AND claim_expires_at < NOW()
    RETURNING vtid, claimed_by
  )
  SELECT COUNT(*) INTO v_count FROM expired;

  -- Clear current_vtid for workers with expired claims
  UPDATE worker_registry w
  SET current_vtid = NULL,
      updated_at = NOW()
  WHERE current_vtid IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM vtid_ledger l
      WHERE l.vtid = w.current_vtid
        AND l.claimed_by = w.worker_id
    );

  RETURN v_count;
END;
$$;

-- =============================================================================
-- Step 7: Get Pending Tasks (tasks ready for claiming)
-- =============================================================================
CREATE OR REPLACE FUNCTION get_pending_worker_tasks(
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  vtid TEXT,
  title TEXT,
  summary TEXT,
  status TEXT,
  layer TEXT,
  module TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    l.vtid,
    l.title,
    l.summary,
    l.status,
    l.layer,
    l.module,
    l.created_at,
    l.updated_at
  FROM vtid_ledger l
  WHERE l.status = 'in_progress'
    AND (l.claimed_by IS NULL OR l.claim_expires_at < NOW())
  ORDER BY l.updated_at ASC
  LIMIT p_limit;
END;
$$;

-- =============================================================================
-- Step 8: Get Worker Stats
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
    'pending_tasks', (SELECT COUNT(*) FROM vtid_ledger WHERE status = 'in_progress' AND (claimed_by IS NULL OR claim_expires_at < NOW())),
    'active_claims', (SELECT COUNT(*) FROM vtid_ledger WHERE claimed_by IS NOT NULL AND claim_expires_at > NOW()),
    'tasks_today', (SELECT COUNT(*) FROM vtid_ledger WHERE created_at > NOW() - INTERVAL '1 day')
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- =============================================================================
-- RLS Policies
-- =============================================================================
ALTER TABLE worker_registry ENABLE ROW LEVEL SECURITY;

-- Service role has full access
CREATE POLICY IF NOT EXISTS "Service role full access to worker_registry"
  ON worker_registry FOR ALL
  USING (auth.role() = 'service_role');

-- =============================================================================
-- Grants
-- =============================================================================
GRANT ALL ON worker_registry TO service_role;
GRANT EXECUTE ON FUNCTION claim_vtid_task TO service_role;
GRANT EXECUTE ON FUNCTION release_vtid_claim TO service_role;
GRANT EXECUTE ON FUNCTION worker_heartbeat TO service_role;
GRANT EXECUTE ON FUNCTION expire_stale_vtid_claims TO service_role;
GRANT EXECUTE ON FUNCTION get_pending_worker_tasks TO service_role;
GRANT EXECUTE ON FUNCTION get_worker_connector_stats TO service_role;

-- =============================================================================
-- Done
-- =============================================================================
