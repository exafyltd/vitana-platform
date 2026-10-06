-- VTID-04878 assertions for claim_capped_reward(). Runs after the VTID-04809
-- fixture + migration, the VTID-04878 fixture and the VTID-04878 migration
-- (applied twice). Any failed assertion raises; the runner uses ON_ERROR_STOP.

SET ROLE service_role;

DO $$
DECLARE
  t  uuid := 'aaaaaaaa-0000-0000-0000-000000000000';
  m1 uuid := '00000000-0000-0000-0000-0000000000c1';
  m2 uuid := '00000000-0000-0000-0000-0000000000c2';
  r  jsonb;
BEGIN
  -- 1. Daily cap of 2 (autopilot_action_done, 5 VTNA).
  r := claim_capped_reward(t, m1, 'autopilot_action_done', 'rec-1', 5, 2, 'day');
  ASSERT (r->>'claimed')::boolean AND (r->>'amount')::int = 5, 'first claim pays: ' || r::text;
  r := claim_capped_reward(t, m1, 'autopilot_action_done', 'rec-1', 5, 2, 'day');
  ASSERT NOT (r->>'claimed')::boolean AND r->>'reason' = 'duplicate', 'same ref is a duplicate: ' || r::text;
  r := claim_capped_reward(t, m1, 'autopilot_action_done', 'rec-2', 5, 2, 'day');
  ASSERT (r->>'claimed')::boolean, 'second claim pays';
  r := claim_capped_reward(t, m1, 'autopilot_action_done', 'rec-3', 5, 2, 'day');
  ASSERT NOT (r->>'claimed')::boolean AND r->>'reason' = 'capped', 'third claim in a day is capped: ' || r::text;
  ASSERT (SELECT earned_balance FROM user_wallets WHERE user_id = m1 AND currency_type = 'CREDITS') = 10, 'two payouts landed in earned';
  ASSERT (SELECT count(*) FROM wallet_transactions WHERE to_user_id = m1 AND metadata->>'source' = 'autopilot_action_done') = 2,
    'the cap counts credit_wallet''s metadata.source';

  -- 2. The cap is per member and per rule.
  r := claim_capped_reward(t, m2, 'autopilot_action_done', 'rec-9', 5, 2, 'day');
  ASSERT (r->>'claimed')::boolean, 'another member is not capped by m1';
  r := claim_capped_reward(t, m1, 'live_room_15min', 'att-1', 20, 3, 'week');
  ASSERT (r->>'claimed')::boolean, 'another rule is not capped by autopilot';

  -- 3. Window rollover: yesterday's payouts do not count today.
  UPDATE wallet_transactions SET created_at = now() - interval '1 day'
   WHERE to_user_id = m1 AND metadata->>'source' = 'autopilot_action_done';
  r := claim_capped_reward(t, m1, 'autopilot_action_done', 'rec-3', 5, 2, 'day');
  ASSERT (r->>'claimed')::boolean, 'a new day reopens the cap: ' || r::text;

  -- 4. Weekly cap of 1 (index_new_best, 50 VTNA); last week's does not count.
  r := claim_capped_reward(t, m1, 'index_new_best', '2026-10-05', 50, 1, 'week');
  ASSERT (r->>'claimed')::boolean, 'index best pays';
  r := claim_capped_reward(t, m1, 'index_new_best', '2026-10-06', 50, 1, 'week');
  ASSERT r->>'reason' = 'capped', 'second index best in a week is capped';
  UPDATE wallet_transactions SET created_at = now() - interval '8 days'
   WHERE to_user_id = m1 AND metadata->>'source' = 'index_new_best';
  r := claim_capped_reward(t, m1, 'index_new_best', '2026-10-06', 50, 1, 'week');
  ASSERT (r->>'claimed')::boolean, 'a new week reopens the cap';

  -- 5. Test/service accounts never earn.
  ASSERT claim_capped_reward(t, '00000000-0000-0000-0000-0000000000b1', 'autopilot_action_done', 'x', 5, 2, 'day')->>'error' = 'NOT_ELIGIBLE', 'bot refused';
  ASSERT claim_capped_reward(t, '00000000-0000-0000-0000-0000000000d1', 'autopilot_action_done', 'x', 5, 2, 'day')->>'error' = 'NOT_ELIGIBLE', 'test actor refused';
  ASSERT claim_capped_reward(t, '00000000-0000-0000-0000-0000000000e1', 'autopilot_action_done', 'x', 5, 2, 'day')->>'error' = 'NOT_ELIGIBLE', 'e2e address refused';
  ASSERT claim_capped_reward(t, '00000000-0000-0000-0000-000000000001', 'autopilot_action_done', 'x', 5, 2, 'day')->>'error' = 'NOT_ELIGIBLE', 'system bot refused';
  ASSERT NOT EXISTS (SELECT 1 FROM wallet_transactions WHERE to_user_id IN
    ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1')), 'nothing paid to test accounts';

  -- 6. Bad input.
  ASSERT claim_capped_reward(t, m1, 'autopilot_action_done', 'x', 0, 2, 'day')->>'error' = 'INVALID_AMOUNT', 'zero amount refused';
  ASSERT claim_capped_reward(t, m1, 'autopilot_action_done', 'x', 5, 2, 'month')->>'error' = 'INVALID_WINDOW', 'unknown window refused';
  ASSERT claim_capped_reward(t, m1, 'autopilot_action_done', '', 5, 2, 'day')->>'error' = 'ARGS_REQUIRED', 'empty ref refused';
END $$;

RESET ROLE;

-- Members cannot call it.
SET ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM claim_capped_reward(NULL, '00000000-0000-0000-0000-0000000000c1', 'autopilot_action_done', 'x', 5, 2, 'day');
    RAISE EXCEPTION 'expected permission denied';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;


-- Sweep candidate queries.
SET ROLE service_role;
DO $$
DECLARE
  m1 uuid := '00000000-0000-0000-0000-0000000000c1';
  m2 uuid := '00000000-0000-0000-0000-0000000000c2';
BEGIN
  -- Members: real primary members only, once each, paged.
  ASSERT (SELECT array_agg(user_id ORDER BY user_id) FROM reward_sweep_members(NULL, 100)) = ARRAY[m1, m2],
    'members exclude bot, test actor and e2e address';
  ASSERT (SELECT array_agg(user_id) FROM reward_sweep_members(m1, 100)) = ARRAY[m2], 'paging after m1';
  ASSERT (SELECT count(*) FROM reward_sweep_members(NULL, 1)) = 1, 'page size honoured';

  -- Live rooms: only m1's 30 minutes with m2 present.
  ASSERT (SELECT array_agg(attendance_id) FROM reward_sweep_live_room_candidates(now() - interval '1 day'))
         = ARRAY['10000000-0000-0000-0000-000000000001'::uuid],
    'only a 15+ minute stay with someone else qualifies: '
    || (SELECT coalesce(string_agg(attendance_id::text, ','), 'none') FROM reward_sweep_live_room_candidates(now() - interval '1 day'));
  ASSERT (SELECT count(*) FROM reward_sweep_live_room_candidates(now())) = 0, 'nothing before p_since';
  ASSERT (SELECT duration_minutes FROM live_room_attendance WHERE id = '10000000-0000-0000-0000-000000000002') = 15,
    'the live column rounds 14:59 up to 15 (why the candidate query compares timestamps)';

  -- Index: only m1's +15 new best.
  ASSERT (SELECT array_agg(user_id) FROM reward_sweep_index_candidates(current_date - 6)) = ARRAY[m1],
    'only a +10 new best qualifies';
  ASSERT (SELECT score FROM reward_sweep_index_candidates(current_date - 6)) = 95, 'latest score reported';
  ASSERT (SELECT count(*) FROM reward_sweep_index_candidates(current_date - 25)) = 1,
    'a first reading in the window is the baseline';
END $$;
RESET ROLE;

\echo 'VTID-04878: all assertions passed'
