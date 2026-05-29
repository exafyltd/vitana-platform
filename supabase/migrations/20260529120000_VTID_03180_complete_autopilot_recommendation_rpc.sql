-- =============================================================================
-- VTID-03180: complete_autopilot_recommendation RPC
-- =============================================================================
-- Closes the gap reported from prod: the gateway /complete route was PATCHing
-- a non-existent `metadata` column on autopilot_recommendations, so every
-- "Complete ✓" tap from the community app got a 400 back from PostgREST and
-- the row never actually flipped to status='completed'. The frontend has been
-- silently falling back to /reject + a per-user localStorage dismiss set
-- (vitana-v1 PR #577) but the canonical row state never advances, so the
-- recommendation resurfaces in any other client that reads the table.
--
-- This migration provides the missing canonical state-transition surface,
-- mirroring activate_autopilot_recommendation / reject_autopilot_recommendation:
--   * verifies the row belongs to the caller,
--   * idempotent on already-completed rows,
--   * transitions 'activated' -> 'completed',
--   * stamps completed_at = NOW(),
--   * credits a 10 VTN reward for onboarding_* signals (same heuristic the
--     gateway was already using to decide reward) via credit_wallet(),
--   * returns JSON { ok, recommendation_id, title, status, completed_at,
--                    reward, already_completed?, source_ref }.
--
-- Schema preconditions (already present, see migration history):
--   * status CHECK includes 'completed'
--     (20260501000000_VTID_02639_autopilot_finding_completed_state.sql)
--   * completed_at TIMESTAMPTZ column exists (same migration)
--   * credit_wallet(tenant_id, user_id, amount, type, source, source_event_id,
--                   description) returns jsonb
--     (20260526000000_VTID_03107_wallet_reconciliation.sql)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.complete_autopilot_recommendation(
  p_recommendation_id UUID,
  p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec       RECORD;
  v_now       TIMESTAMPTZ := NOW();
  v_reward    INTEGER := 0;
  v_tenant_id UUID;
  v_credit    JSONB;
BEGIN
  -- Lock the target row so concurrent /complete taps don't double-credit.
  SELECT * INTO v_rec
  FROM public.autopilot_recommendations
  WHERE id = p_recommendation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Recommendation not found');
  END IF;

  -- Caller must own the row when it's user-scoped. System-wide recs
  -- (user_id IS NULL) are not completable by users — only the dev/admin
  -- VTID lifecycle should ever close those, so reject here.
  IF p_user_id IS NOT NULL
     AND v_rec.user_id IS NOT NULL
     AND v_rec.user_id <> p_user_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Recommendation belongs to another user');
  END IF;

  IF v_rec.user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Cannot complete a system-wide recommendation');
  END IF;

  -- Idempotent: the frontend retries on network errors and the localStorage
  -- dismiss set means a row may be POSTed twice. Don't 400, don't re-credit.
  IF v_rec.status = 'completed' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_completed', true,
      'recommendation_id', p_recommendation_id,
      'title', v_rec.title,
      'status', 'completed',
      'completed_at', v_rec.completed_at,
      'reward', 0,
      'source_ref', v_rec.source_ref
    );
  END IF;

  IF v_rec.status <> 'activated' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', format('Cannot complete recommendation in status: %s', v_rec.status)
    );
  END IF;

  -- Reward heuristic: 10 VTN for onboarding actions. Matches the inline
  -- credit_wallet call the old route was making before this migration.
  IF v_rec.source_ref LIKE 'onboarding_%' THEN
    v_reward := 10;
  END IF;

  -- Flip status FIRST. Reward is best-effort and must never block the
  -- canonical transition (otherwise we recreate exactly the bug we're
  -- fixing: row stays 'activated' on the server even though the user
  -- thinks they're done).
  UPDATE public.autopilot_recommendations
  SET status       = 'completed',
      completed_at = v_now,
      updated_at   = v_now
  WHERE id = p_recommendation_id;

  -- Credit wallet. Failures here downgrade the reward in the response to 0
  -- but keep ok:true; the user is still unblocked.
  IF v_reward > 0 THEN
    SELECT tenant_id INTO v_tenant_id
    FROM public.user_tenants
    WHERE user_id = v_rec.user_id AND is_primary = true
    LIMIT 1;

    IF v_tenant_id IS NOT NULL THEN
      BEGIN
        v_credit := public.credit_wallet(
          v_tenant_id,
          v_rec.user_id,
          v_reward,
          'reward',
          'recommendation_complete',
          'rec_complete_' || p_recommendation_id::text,
          'Completed: ' || v_rec.title
        );
        IF COALESCE((v_credit ->> 'ok')::boolean, false) <> true THEN
          v_reward := 0;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_reward := 0;
      END;
    ELSE
      v_reward := 0;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'recommendation_id', p_recommendation_id,
    'title', v_rec.title,
    'status', 'completed',
    'completed_at', v_now,
    'reward', v_reward,
    'source_ref', v_rec.source_ref
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_autopilot_recommendation(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_autopilot_recommendation(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION public.complete_autopilot_recommendation(UUID, UUID) IS
  'VTID-03180: Transitions an activated autopilot recommendation to completed, stamps completed_at, and credits a VTN reward for onboarding actions via credit_wallet. Mirrors activate_autopilot_recommendation / reject_autopilot_recommendation. Idempotent on already-completed rows. Returns { ok, recommendation_id, title, status, completed_at, reward, already_completed?, source_ref }.';
