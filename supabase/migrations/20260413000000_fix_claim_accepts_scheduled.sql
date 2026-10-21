-- =============================================================================
-- Fix: claim_vtid_task must accept 'scheduled' status
-- =============================================================================
-- The self-healing injector sets vtid_ledger.status = 'scheduled', but the
-- claim_vtid_task function only accepted 'in_progress' and 'allocated'.
-- This caused the worker-runner to see pending tasks but never claim them.
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
  -- FIXED: added 'scheduled' to the accepted statuses
  IF v_ledger.status NOT IN ('in_progress', 'allocated', 'scheduled') THEN
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
      NULL; -- Will be overwritten below
    ELSIF v_ledger.claimed_by = p_worker_id THEN
      NULL; -- Same worker reclaiming
    ELSE
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

  -- Claim the task (also transition status to in_progress)
  UPDATE vtid_ledger
  SET claimed_by = p_worker_id,
      claim_expires_at = v_expires_at,
      claim_started_at = COALESCE(claim_started_at, v_now),
      status = 'in_progress',
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
