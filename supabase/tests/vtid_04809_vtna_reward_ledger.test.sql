-- VTID-04809 assertions. Runs after vtid_04809_fixture.sql and the migration
-- (applied twice, to prove it re-runs cleanly). Any failed assertion raises,
-- and the runner uses ON_ERROR_STOP, so the script exits non-zero.

\set u '11111111-1111-1111-1111-111111111111'
\set other '22222222-2222-2222-2222-222222222222'
\set t '33333333-3333-3333-3333-333333333333'

-- Platform side (service role) ---------------------------------------------------
SET ROLE service_role;

DO $$
DECLARE r jsonb; u uuid := '11111111-1111-1111-1111-111111111111';
        t uuid := '33333333-3333-3333-3333-333333333333';
BEGIN
  -- 1. A reward lands in the earned bucket.
  r := public.credit_wallet(t, u, 10, 'reward', 'diary_streak', 'diary_streak_7_u1', '7-day streak');
  ASSERT (r->>'ok')::boolean AND (r->>'balance')::numeric = 10 AND (r->>'earned_balance')::numeric = 10
         AND r->>'bucket' = 'earned', 'reward credit: ' || r::text;

  -- 2. The same source event never lands twice.
  r := public.credit_wallet(t, u, 10, 'reward', 'diary_streak', 'diary_streak_7_u1', '7-day streak');
  ASSERT (r->>'duplicate')::boolean AND (r->>'balance')::numeric = 10, 'duplicate: ' || r::text;
  ASSERT (SELECT count(*) FROM public.wallet_transactions WHERE idempotency_key = 'diary_streak_7_u1') = 1, 'one ledger row';

  -- 3. A paid credit pack lands in the purchased bucket.
  r := public.credit_wallet(t, u, 50, 'purchase', 'credit_pack:starter', 'cs_test_1', 'pack');
  ASSERT (r->>'balance')::numeric = 60 AND (r->>'earned_balance')::numeric = 10
         AND (r->>'bucket_balance')::numeric = 50, 'purchase credit: ' || r::text;

  -- 4. A purchased-bucket debit cannot reach into earned VTNA.
  r := public.credit_wallet(t, u, -55, 'purchase', 'paywall:x', 'pay_1', 'overage');
  ASSERT NOT (r->>'ok')::boolean AND r->>'error' = 'INSUFFICIENT_BALANCE', 'purchased overdraw: ' || r::text;

  -- 5. An earned-bucket debit lowers both totals.
  r := public.credit_wallet(t, u, -5, 'reward', 'rewards_shop', 'redeem_1', 'redeem');
  ASSERT (r->>'balance')::numeric = 55 AND (r->>'earned_balance')::numeric = 5, 'earned debit: ' || r::text;
  ASSERT (SELECT from_user_id FROM public.wallet_transactions WHERE idempotency_key = 'redeem_1') = u, 'debit row is from the member';

  -- 6. Cash ('earning') is not a VTNA movement.
  r := public.credit_wallet(t, u, 5, 'earning', 'x', 'cash_1', NULL);
  ASSERT r->>'error' = 'UNSUPPORTED_TYPE', 'earning refused: ' || r::text;

  -- 7. Zero and missing user are refused.
  ASSERT public.credit_wallet(t, u, 0, 'reward', 'x', 'zero', NULL)->>'error' = 'INVALID_AMOUNT', 'zero refused';
  ASSERT public.credit_wallet(t, NULL, 1, 'reward', 'x', 'nouser', NULL)->>'error' = 'USER_REQUIRED', 'user required';

  -- 8. Positional call shape used by complete_autopilot_recommendation.
  r := public.credit_wallet(t, '22222222-2222-2222-2222-222222222222', 10, 'reward', 'recommendation_complete', 'rec_complete_abc', 'Completed: x');
  ASSERT (r->>'ok')::boolean, 'positional call: ' || r::text;

  -- 9. The CHECK stops any generic debit from spending earned VTNA.
  BEGIN
    UPDATE public.user_wallets SET balance = 4 WHERE user_id = u AND currency_type = 'CREDITS';
    RAISE EXCEPTION 'expected check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- EUR peg rows.
DO $$ BEGIN
  ASSERT (SELECT rate FROM public.exchange_rates WHERE from_currency = 'CREDITS' AND to_currency = 'EUR' AND is_active) = 0.01, 'CREDITS->EUR';
  ASSERT (SELECT rate FROM public.exchange_rates WHERE from_currency = 'EUR' AND to_currency = 'CREDITS' AND is_active) = 100, 'EUR->CREDITS';
  ASSERT (SELECT count(*) FROM public.exchange_rates WHERE from_currency = 'EUR' AND to_currency = 'VTNA') = 1, 'EUR->VTNA once after a re-run';
END $$;

RESET ROLE;

-- Member side (authenticated, signed in as u) ----------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

DO $$
DECLARE n numeric;
BEGIN
  -- 10. Members still read their own wallet and ledger.
  ASSERT (SELECT balance FROM public.user_wallets WHERE currency_type = 'CREDITS') = 55, 'member reads own balance';
  ASSERT (SELECT count(*) FROM public.wallet_transactions) >= 3, 'member reads own ledger';

  -- 11. Direct balance edits through PostgREST are gone.
  BEGIN
    UPDATE public.user_wallets SET balance = 999999 WHERE currency_type = 'CREDITS';
    RAISE EXCEPTION 'expected permission denied on UPDATE';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.wallet_transactions (from_user_id, amount, transaction_type, status)
    VALUES ('11111111-1111-1111-1111-111111111111', 1, 'reward', 'completed');
    RAISE EXCEPTION 'expected permission denied on INSERT';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- 12. Members cannot call credit_wallet.
  BEGIN
    PERFORM public.credit_wallet(NULL, '11111111-1111-1111-1111-111111111111', 1000, 'reward', 'x', 'self', NULL);
    RAISE EXCEPTION 'expected permission denied on credit_wallet';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- 13. update_user_balance refuses 'add'.
  BEGIN
    PERFORM public.update_user_balance('11111111-1111-1111-1111-111111111111', 'CREDITS', 1000, 'add', 'reward', 'bonus');
    RAISE EXCEPTION 'expected add to be refused';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM LIKE 'Only subtract is allowed%', 'add refused with the right message: ' || SQLERRM;
  END;

  -- 14. Subtract still works on the purchased part, never on earned VTNA.
  n := public.update_user_balance('11111111-1111-1111-1111-111111111111', 'CREDITS', 50, 'subtract', 'purchase', 'spend');
  ASSERT n = 5, 'subtract purchased part: ' || n;
  BEGIN
    PERFORM public.update_user_balance('11111111-1111-1111-1111-111111111111', 'CREDITS', 1, 'subtract', 'purchase', 'spend');
    RAISE EXCEPTION 'expected insufficient balance';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM = 'Insufficient balance for this operation', 'earned VTNA protected: ' || SQLERRM;
  END;
END $$;

RESET ROLE;

-- anon lost update_user_balance entirely.
DO $$ BEGIN
  ASSERT NOT has_function_privilege('anon', 'public.update_user_balance(uuid, text, numeric, text, text, text)', 'EXECUTE'), 'anon cannot call update_user_balance';
END $$;

\echo 'VTID-04809: all assertions passed'
