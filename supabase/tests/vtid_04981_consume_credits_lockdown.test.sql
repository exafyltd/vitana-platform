-- VTID-04981 assertions. Runs after the VTID-04809 wallet fixture + migration
-- (real credit_wallet), fn_consume_credits as VTID-03107 created it (granted
-- to authenticated), and the VTID-04981 migration applied twice.

DO $$
BEGIN
  ASSERT NOT has_function_privilege('authenticated', 'public.fn_consume_credits(uuid,uuid,integer,text,text,text)', 'EXECUTE'),
    'members (authenticated) cannot execute fn_consume_credits';
  ASSERT NOT has_function_privilege('anon', 'public.fn_consume_credits(uuid,uuid,integer,text,text,text)', 'EXECUTE'),
    'anon cannot execute fn_consume_credits';
  ASSERT has_function_privilege('service_role', 'public.fn_consume_credits(uuid,uuid,integer,text,text,text)', 'EXECUTE'),
    'the gateway (service_role) still can';
END $$;

INSERT INTO public.profiles (user_id) VALUES ('00000000-0000-0000-0000-0000000000d1') ON CONFLICT DO NOTHING;

-- A member calling it is refused by Postgres.
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM public.fn_consume_credits('aaaaaaaa-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000d1', 5, 'reward_credits', 'match_reveals', 'k-member');
  RAISE EXCEPTION 'member call was not refused';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
RESET ROLE;

-- The gateway's behaviour is unchanged: a purchased-credits debit works.
SET ROLE service_role;
DO $$
DECLARE
  t uuid := 'aaaaaaaa-0000-0000-0000-000000000000';
  m uuid := '00000000-0000-0000-0000-0000000000d1';
  r jsonb;
BEGIN
  r := public.credit_wallet(t, m, 20, 'purchase', 'test', 'seed-purchase', NULL);
  ASSERT (r->>'ok')::boolean, 'seed purchase: ' || r::text;
  r := public.fn_consume_credits(t, m, 5, 'purchased_credits', 'match_reveals', 'k-gw-1');
  ASSERT (r->>'ok')::boolean, 'gateway purchased_credits debit still works: ' || r::text;
  r := public.fn_consume_credits(t, m, 5, 'cash_balance', 'match_reveals', 'k-gw-2');
  ASSERT r->>'error' = 'BUCKET_NOT_SPENDABLE', 'cash_balance still refused: ' || r::text;
END $$;
RESET ROLE;

\echo 'VTID-04981: all assertions passed'
