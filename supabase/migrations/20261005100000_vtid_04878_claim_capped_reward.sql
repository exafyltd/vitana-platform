-- =============================================================================
-- VTID-04878 — capped VTNA rewards, claimed atomically
-- -----------------------------------------------------------------------------
-- Owner decision 2026-10-05 adds three repeatable, capped earning rules on top
-- of the VTID-04864 rule table (amounts and caps live in the gateway's
-- services/rewards/vtna-reward-rules.ts, never in a client):
--   autopilot_action_done   5 VTNA, at most 2 per member per UTC day
--   live_room_15min        20 VTNA, at most 3 per member per ISO week (UTC)
--   index_new_best         50 VTNA, at most 1 per member per ISO week (UTC)
--
-- claim_capped_reward() pays one occurrence (p_ref) of one rule at most once
-- and never past the cap. Under a per-(member, rule) transaction-scoped
-- advisory lock it
--   1. returns duplicate when '<rule>:<ref>' was already paid,
--   2. counts this member's reward credits for the rule in the current window
--      (credit_wallet stores p_source in wallet_transactions.metadata.source),
--   3. returns CAPPED at the cap, without writing,
--   4. otherwise credits through credit_wallet() (VTID-04809) with the
--      idempotency key '<rule>:<ref>'.
-- Same pattern as claim_invite_reward (VTID-04864).
--
-- Test/service accounts (service_bot_accounts, notification_test_actors,
-- e2e address patterns, the system bot) are refused here as well as in the
-- gateway (CLAUDE.md rules 43-45).
--
-- Also: read-only candidate queries for the gateway's reward sweep.
-- service_role only; no table changes.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.claim_capped_reward(
  p_tenant_id  uuid,
  p_user_id    uuid,
  p_rule       text,
  p_ref        text,
  p_amount     integer,
  p_cap        integer,
  p_window     text,
  p_now        timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_key      text;
  v_start    timestamptz;
  v_count    integer;
  v_credit   jsonb;
BEGIN
  IF p_user_id IS NULL OR p_rule IS NULL OR p_ref IS NULL OR p_rule = '' OR p_ref = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ARGS_REQUIRED');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_cap IS NULL OR p_cap <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT');
  END IF;
  IF p_window NOT IN ('day', 'week') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_WINDOW');
  END IF;

  IF p_user_id = '00000000-0000-0000-0000-000000000001'::uuid
     OR EXISTS (SELECT 1 FROM public.service_bot_accounts WHERE user_id = p_user_id)
     OR EXISTS (SELECT 1 FROM public.notification_test_actors WHERE user_id = p_user_id)
     OR EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id
                AND (u.email ILIKE 'e2e-%@%' OR u.email ILIKE '%@vitanatest.exafy.io')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_ELIGIBLE');
  END IF;

  v_key := p_rule || ':' || p_ref;

  -- One member and rule at a time: held until this transaction ends.
  PERFORM pg_advisory_xact_lock(hashtextextended('capped_reward:' || p_user_id::text || ':' || p_rule, 0));

  IF EXISTS (
    SELECT 1 FROM public.wallet_transactions
    WHERE COALESCE(to_user_id, from_user_id) = p_user_id AND idempotency_key = v_key
  ) THEN
    RETURN jsonb_build_object('ok', true, 'claimed', false, 'reason', 'duplicate', 'amount', 0);
  END IF;

  v_start := date_trunc(p_window, p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  SELECT count(*) INTO v_count
  FROM public.wallet_transactions
  WHERE to_user_id = p_user_id
    AND transaction_type = 'reward'
    AND metadata->>'source' = p_rule
    AND created_at >= v_start;

  IF v_count >= p_cap THEN
    RETURN jsonb_build_object('ok', true, 'claimed', false, 'reason', 'capped', 'amount', 0,
                              'cap', p_cap, 'window', p_window);
  END IF;

  v_credit := public.credit_wallet(p_tenant_id, p_user_id, p_amount, 'reward', p_rule, v_key, NULL);

  IF COALESCE((v_credit->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'error', COALESCE(v_credit->>'error', 'CREDIT_FAILED'));
  END IF;
  IF COALESCE((v_credit->>'duplicate')::boolean, false) THEN
    RETURN jsonb_build_object('ok', true, 'claimed', false, 'reason', 'duplicate', 'amount', 0);
  END IF;

  RETURN jsonb_build_object('ok', true, 'claimed', true, 'amount', p_amount,
                            'earned_balance', v_credit->'earned_balance');
END;
$fn$;

REVOKE ALL ON FUNCTION public.claim_capped_reward(uuid, uuid, text, text, integer, integer, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_capped_reward(uuid, uuid, text, text, integer, integer, text, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_capped_reward(uuid, uuid, text, text, integer, integer, text, timestamptz) TO service_role;

COMMENT ON FUNCTION public.claim_capped_reward(uuid, uuid, text, text, integer, integer, text, timestamptz) IS
  'VTID-04878: pays one occurrence of a capped VTNA rule at most once and never past its per-day/per-week cap (UTC), under a per-member+rule advisory lock. Returns { ok, claimed, reason?, amount }. Credits via credit_wallet() with key <rule>:<ref>.';


-- -----------------------------------------------------------------------------
-- Read-only candidate queries for the gateway's reward sweep
-- (services/gateway/src/services/rewards/reward-sweep.ts). The test/service
-- account exclusion lives here once, next to claim_capped_reward()'s.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reward_sweep_is_excluded(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT p_user_id = '00000000-0000-0000-0000-000000000001'::uuid
      OR EXISTS (SELECT 1 FROM public.service_bot_accounts WHERE user_id = p_user_id)
      OR EXISTS (SELECT 1 FROM public.notification_test_actors WHERE user_id = p_user_id)
      OR EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id
                 AND (u.email ILIKE 'e2e-%@%' OR u.email ILIKE '%@vitanatest.exafy.io'));
$fn$;

-- Real members (primary membership), one page at a time by user_id.
CREATE OR REPLACE FUNCTION public.reward_sweep_members(p_after uuid, p_limit integer)
RETURNS TABLE (user_id uuid, tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT DISTINCT ON (ut.user_id) ut.user_id, ut.tenant_id
  FROM public.user_tenants ut
  WHERE ut.is_primary = true
    AND ut.user_id > COALESCE(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
    AND NOT public.reward_sweep_is_excluded(ut.user_id)
  ORDER BY ut.user_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
$fn$;

-- live_room_15min: a finished stay of 15 full minutes during which someone
-- else was in the same room. Compared on the timestamps, not on
-- duration_minutes: that generated column stores a fractional value in an
-- integer, so Postgres ROUNDS it and 14:30 would already read as 15.
CREATE OR REPLACE FUNCTION public.reward_sweep_live_room_candidates(p_since timestamptz)
RETURNS TABLE (user_id uuid, tenant_id uuid, attendance_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT a.user_id, a.tenant_id, a.id
  FROM public.live_room_attendance a
  WHERE a.left_at IS NOT NULL
    AND a.left_at >= p_since
    AND a.left_at - a.joined_at >= interval '15 minutes'
    AND COALESCE(a.is_banned, false) = false
    AND NOT public.reward_sweep_is_excluded(a.user_id)
    AND EXISTS (
      SELECT 1 FROM public.live_room_attendance o
      WHERE o.live_room_id = a.live_room_id
        AND o.user_id <> a.user_id
        AND o.joined_at < a.left_at
        AND COALESCE(o.left_at, o.disconnected_at, now()) > a.joined_at
    );
$fn$;

-- index_new_best: each member's latest Vitana Index reading since p_since, when
-- it is at least 10 points above every earlier reading. The first reading is
-- the baseline (no earlier reading) and never qualifies.
CREATE OR REPLACE FUNCTION public.reward_sweep_index_candidates(p_since date)
RETURNS TABLE (user_id uuid, tenant_id uuid, score_date date, score integer, previous_best integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH latest AS (
    SELECT DISTINCT ON (s.user_id) s.user_id, s.tenant_id, s.date, s.score_total
    FROM public.vitana_index_scores s
    WHERE s.date >= p_since
    ORDER BY s.user_id, s.date DESC
  )
  SELECT l.user_id, l.tenant_id, l.date, l.score_total, b.best
  FROM latest l
  CROSS JOIN LATERAL (
    SELECT max(p.score_total) AS best
    FROM public.vitana_index_scores p
    WHERE p.user_id = l.user_id AND p.date < l.date
  ) b
  WHERE b.best IS NOT NULL
    AND l.score_total >= b.best + 10
    AND NOT public.reward_sweep_is_excluded(l.user_id);
$fn$;

REVOKE ALL ON FUNCTION public.reward_sweep_is_excluded(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reward_sweep_members(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reward_sweep_live_room_candidates(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reward_sweep_index_candidates(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reward_sweep_is_excluded(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reward_sweep_members(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.reward_sweep_live_room_candidates(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.reward_sweep_index_candidates(date) TO service_role;

-- Self-check: members cannot call it.
DO $check$
BEGIN
  IF has_function_privilege('authenticated', 'public.claim_capped_reward(uuid, uuid, text, text, integer, integer, text, timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reward_sweep_members(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reward_sweep_live_room_candidates(timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reward_sweep_index_candidates(date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.claim_capped_reward(uuid, uuid, text, text, integer, integer, text, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-04878: reward functions must not be executable by members';
  END IF;
END
$check$;

COMMIT;
