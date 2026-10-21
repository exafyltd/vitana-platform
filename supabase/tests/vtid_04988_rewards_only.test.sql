-- VTID-04988 assertions: earned VTNA is never spent on paywall overage.
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.feature_entitlements WHERE 'reward_credits' = ANY (allowed_burn_buckets)) = 0,
    'no feature allows reward_credits';
  ASSERT (SELECT count(*) FROM public.feature_entitlements WHERE allowed_burn_buckets = ARRAY['purchased_credits']) = 24,
    'all 24 rows are purchased-only (16 changed, 8 untouched)';
  ASSERT NOT has_function_privilege('authenticated', 'public.fn_consume_credits(uuid,uuid,integer,text,text,text)', 'EXECUTE'),
    'members still cannot execute';
END $$;

SET ROLE service_role;
DO $$
DECLARE
  t uuid := 'aaaaaaaa-0000-0000-0000-000000000000';
  m uuid := '00000000-0000-0000-0000-0000000000f1';
  r jsonb;
BEGIN
  PERFORM public.credit_wallet(t, m, 100, 'reward', 'test', 'seed-earned', NULL);
  PERFORM public.credit_wallet(t, m, 50, 'purchase', 'test', 'seed-purchased', NULL);

  r := public.fn_consume_credits(t, m, 10, 'reward_credits', 'match_reveals', 'k-r1');
  ASSERT r->>'error' = 'BUCKET_NOT_SPENDABLE', 'earned VTNA refused: ' || r::text;
  ASSERT (SELECT earned_balance FROM user_wallets WHERE user_id = m AND currency_type = 'CREDITS') = 100, 'earned untouched';
  ASSERT NOT EXISTS (SELECT 1 FROM wallet_transactions WHERE idempotency_key = 'k-r1'), 'nothing written';

  r := public.fn_consume_credits(t, m, 10, 'purchased_credits', 'match_reveals', 'k-p1');
  ASSERT (r->>'ok')::boolean, 'purchased debit works: ' || r::text;
  ASSERT (SELECT balance FROM user_wallets WHERE user_id = m AND currency_type = 'CREDITS') = 140, 'purchased debited 10';
  ASSERT (SELECT earned_balance FROM user_wallets WHERE user_id = m AND currency_type = 'CREDITS') = 100, 'earned still 100';

  r := public.fn_consume_credits(t, m, 10, 'cash_balance', 'match_reveals', 'k-c1');
  ASSERT r->>'error' = 'BUCKET_NOT_SPENDABLE', 'cash still refused';
END $$;
RESET ROLE;

\echo 'VTID-04988: all assertions passed'
