-- =============================================================================
-- VTID-04864 — atomic invite-reward claim (cap + status in one locked step)
-- -----------------------------------------------------------------------------
-- Owner decision 2026-10-03: 1,000 VTNA per invited friend who joins, at most
-- 10 per inviter per 30 days, plus a one-time 10,000 VTNA bonus at 10 friends.
--
-- community-autopilot/invites.ts used to count the inviter's rewarded referrals
-- and then, in a second statement, move this referral signed_up -> rewarded.
-- Two claims for the same inviter at a count of 9 could both pass the count and
-- both be paid (their credit_wallet keys differ by referred user, so the ledger
-- does not deduplicate them) — the cap was not a cap under concurrency.
--
-- claim_invite_reward() does both under a per-inviter transaction-scoped
-- advisory lock, so concurrent claims for one inviter are serialised and the
-- cap holds. The VTNA credit itself stays in credit_wallet() (VTID-04809),
-- called by the gateway only when this returns claimed = true.
--
-- service_role only; no table changes.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.claim_invite_reward(
  p_referral_id  uuid,
  p_inviter_id   uuid,
  p_amount       integer,
  p_cap          integer,
  p_window_days  integer,
  p_now          timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_count  integer;
  v_id     uuid;
BEGIN
  IF p_referral_id IS NULL OR p_inviter_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ARGS_REQUIRED');
  END IF;

  -- One inviter at a time: held until this function's transaction ends.
  PERFORM pg_advisory_xact_lock(hashtextextended('invite_reward:' || p_inviter_id::text, 0));

  SELECT count(*) INTO v_count
  FROM public.referrals
  WHERE referrer_id = p_inviter_id
    AND status = 'rewarded'
    AND rewarded_at >= p_now - make_interval(days => p_window_days);

  IF v_count >= p_cap THEN
    RETURN jsonb_build_object('ok', true, 'claimed', false, 'reason', 'monthly_cap');
  END IF;

  -- Exactly once: only the call that moves signed_up -> rewarded may be paid.
  UPDATE public.referrals
  SET status = 'rewarded', rewarded_at = p_now, reward_amount = p_amount
  WHERE id = p_referral_id AND referrer_id = p_inviter_id AND status = 'signed_up'
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'claimed', false, 'reason', 'already_rewarded');
  END IF;

  RETURN jsonb_build_object('ok', true, 'claimed', true);
END;
$fn$;

REVOKE ALL ON FUNCTION public.claim_invite_reward(uuid, uuid, integer, integer, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_invite_reward(uuid, uuid, integer, integer, integer, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_invite_reward(uuid, uuid, integer, integer, integer, timestamptz) TO service_role;

COMMENT ON FUNCTION public.claim_invite_reward(uuid, uuid, integer, integer, integer, timestamptz) IS
  'VTID-04864: per-inviter locked cap check + signed_up->rewarded transition for the member-invite VTNA reward. Returns { ok, claimed, reason? }. The credit is made separately via credit_wallet().';

COMMIT;
