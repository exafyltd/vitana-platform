-- =============================================================================
-- VTID-01194: Autonomous Execution Trigger Semantics
-- =============================================================================
-- "IN_PROGRESS = Explicit Human Approval to Execute"
--
-- Key changes:
-- 1. claim_vtid_task now ONLY allows status = 'in_progress' (not 'allocated')
-- 2. get_pending_worker_tasks already filters to 'in_progress' (no change needed)
--
-- VTID-01194 SEMANTICS:
-- - Moving a task to IN_PROGRESS is the ONLY approval needed for execution
-- - "ACTIVATED" status is DEPRECATED for autonomy purposes
-- - autopilot_execution_enabled is now an EMERGENCY STOP only
-- - No duplicate arming steps after human approval
-- =============================================================================

-- =============================================================================
-- Step 1: Update claim_vtid_task to ONLY allow IN_PROGRESS status
-- VTID-01194: Remove 'allocated' - only 'in_progress' means human approved
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

  -- VTID-01194: Check if task is in claimable state
  -- ONLY 'in_progress' is allowed - this means human has explicitly approved execution
  -- 'allocated' is a shell state and NOT approved for execution
  -- 'scheduled' requires human to move it to 'in_progress' first
  IF v_ledger.status != 'in_progress' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'claimed', false,
      'reason', format('VTID-01194: Task must be IN_PROGRESS to claim (current: %s). Move task to In Progress to approve execution.', v_ledger.status),
      'vtid_ref', 'VTID-01194'
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
    'summary', v_ledger.summary,
    'vtid_ref', 'VTID-01194'
  );
END;
$$;

-- =============================================================================
-- Step 2: Add comment documenting VTID-01194 semantics
-- =============================================================================
COMMENT ON FUNCTION claim_vtid_task IS 'VTID-01194: Claims a task for execution.
ONLY allows tasks with status = in_progress, which means a human has explicitly approved execution.
IN_PROGRESS = Explicit Human Approval to Execute. No other approval step is needed.';

-- =============================================================================
-- Step 3: Update get_pending_worker_tasks to add VTID-01194 context
-- (Already filters to in_progress, just adding semantic clarity)
-- =============================================================================
COMMENT ON FUNCTION get_pending_worker_tasks IS 'VTID-01194: Returns tasks available for workers to claim.
Only returns tasks with status = in_progress (human approved for execution).
IN_PROGRESS = Explicit Human Approval to Execute.';

-- =============================================================================
-- Done - VTID-01194 Autonomous Execution Trigger Semantics
-- =============================================================================
