-- =============================================================================
-- VTID-01201: Allow claiming scheduled tasks
-- =============================================================================
-- Updates the claim_vtid_task function to accept 'scheduled' status tasks
-- in addition to 'in_progress' and 'allocated' tasks.
--
-- This enables the worker-runner to claim tasks that are:
-- - status = 'scheduled'
-- - spec_status = 'approved' (enforced at API level)
-- - is_terminal = false
-- - claim window is free
-- =============================================================================

-- Update claim_vtid_task function to include 'scheduled' status
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

  -- VTID-01201: Check if task is in claimable state
  -- Now includes 'scheduled' in addition to 'in_progress' and 'allocated'
  IF v_ledger.status NOT IN ('scheduled', 'in_progress', 'allocated') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'claimed', false,
      'reason', format('Task not in claimable state: %s', v_ledger.status)
    );
  END IF;

  -- VTID-01201: For scheduled tasks, verify spec is approved
  IF v_ledger.status = 'scheduled' THEN
    IF v_ledger.spec_status IS NULL OR v_ledger.spec_status != 'approved' THEN
      RETURN jsonb_build_object(
        'ok', false,
        'claimed', false,
        'reason', format('Scheduled task spec not approved: spec_status=%s', COALESCE(v_ledger.spec_status, 'missing'))
      );
    END IF;

    -- Check is_terminal (must be false or null)
    IF v_ledger.is_terminal = true THEN
      RETURN jsonb_build_object(
        'ok', false,
        'claimed', false,
        'reason', 'Task is already terminal'
      );
    END IF;
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
    'summary', v_ledger.summary,
    'status', v_ledger.status
  );
END;
$$;

-- Update get_pending_worker_tasks to return scheduled tasks (keeping for backwards compat)
-- Note: The Gateway now queries vtid_ledger directly, but we update this for consistency
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
  updated_at TIMESTAMPTZ,
  claimed_by TEXT,
  claim_expires_at TIMESTAMPTZ
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
    l.updated_at,
    l.claimed_by,
    l.claim_expires_at
  FROM vtid_ledger l
  WHERE l.status = 'scheduled'
    AND l.spec_status = 'approved'
    AND (l.is_terminal IS NULL OR l.is_terminal = false)
    AND (l.claimed_by IS NULL OR l.claim_expires_at < NOW())
  ORDER BY l.created_at ASC
  LIMIT p_limit;
END;
$$;

-- Update get_worker_connector_stats to reflect scheduled tasks
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
    'pending_tasks', (
      SELECT COUNT(*) FROM vtid_ledger
      WHERE status = 'scheduled'
        AND spec_status = 'approved'
        AND (is_terminal IS NULL OR is_terminal = false)
        AND (claimed_by IS NULL OR claim_expires_at < NOW())
    ),
    'active_claims', (SELECT COUNT(*) FROM vtid_ledger WHERE claimed_by IS NOT NULL AND claim_expires_at > NOW()),
    'tasks_today', (SELECT COUNT(*) FROM vtid_ledger WHERE created_at > NOW() - INTERVAL '1 day')
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- Create index for scheduled + approved tasks query performance
CREATE INDEX IF NOT EXISTS idx_vtid_ledger_scheduled_approved
  ON vtid_ledger(status, spec_status, created_at)
  WHERE status = 'scheduled' AND spec_status = 'approved';

-- =============================================================================
-- Done
-- =============================================================================
