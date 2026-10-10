-- =============================================================================
-- VTID-04864 — VTNA reward rules: Autopilot completion stops paying
-- -----------------------------------------------------------------------------
-- Owner decision 2026-10-03: "You earn VTNA for real things you do yourself,
-- once per milestone, and for staying consistent." The rule table lives in
-- services/gateway/src/services/rewards/vtna-reward-rules.ts.
--
-- complete_autopilot_recommendation() (VTID-03180) paid 10 VTNA for every
-- completed onboarding_* suggestion. The same steps are first-step milestones
-- (profile_complete, first_diary, first_health_check, ...) paid by the
-- milestone service, so a member was paid twice for one step. This re-creates
-- the function from its latest definition with ONLY that heuristic removed;
-- status transition, idempotency, grants and the response shape are unchanged
-- (the response's `reward` is now always 0, which the app already handles).
-- =============================================================================

BEGIN;

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

  -- VTID-04864: no reward here any more. Completing a Vitana suggestion is
  -- not itself a reward rule; the first steps those onboarding suggestions
  -- lead to (profile, diary, group, ...) are paid ONCE by the milestone
  -- service from the VTNA rule table. This used to pay 10 VTNA per
  -- onboarding_* suggestion on top of the matching milestone. v_reward stays
  -- 0, so the credit block below is skipped and the response reports 0.

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
  'VTID-03180 / VTID-04864: Transitions an activated autopilot recommendation to completed and stamps completed_at. Pays no VTNA (first steps are paid once by the milestone service from the VTNA rule table). Idempotent on already-completed rows. Returns { ok, recommendation_id, title, status, completed_at, reward (always 0), already_completed?, source_ref }.';

COMMIT;
