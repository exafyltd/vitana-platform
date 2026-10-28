-- VTID-04859 assertions. Runs after vtid_04859_fixture.sql and the migration
-- (applied twice). Any failed assertion raises; the runner uses ON_ERROR_STOP.

SET ROLE service_role;

DO $$
DECLARE
  t  uuid := 'aaaaaaaa-0000-0000-0000-000000000000';
  u1 uuid := '00000000-0000-0000-0000-0000000000a1';
  u2 uuid := '00000000-0000-0000-0000-0000000000a2';
  u3 uuid := '00000000-0000-0000-0000-0000000000a3';
  u4 uuid := '00000000-0000-0000-0000-0000000000a4';
  u5 uuid := '00000000-0000-0000-0000-0000000000a5';
  u6 uuid := '00000000-0000-0000-0000-0000000000a6';
  r  jsonb;
  fm record;
  s  record;
BEGIN
  -- 1. Backfill gave seats 1..4 in signup order, skipping the bot and the test actor.
  ASSERT (SELECT seat_number FROM founding_members WHERE user_id = u1) = 1, 'u1 seat 1';
  ASSERT (SELECT seat_number FROM founding_members WHERE user_id = u2) = 2, 'u2 seat 2';
  ASSERT (SELECT seat_number FROM founding_members WHERE user_id = u3) = 3, 'u3 seat 3';
  ASSERT (SELECT seat_number FROM founding_members WHERE user_id = u6) = 4, 'u6 seat 4';
  ASSERT NOT EXISTS (SELECT 1 FROM founding_members WHERE user_id IN (u4, u5, '00000000-0000-0000-0000-0000000000a7')), 'no seat for test/service accounts';
  ASSERT NOT EXISTS (SELECT 1 FROM user_subscriptions WHERE user_id = '00000000-0000-0000-0000-0000000000a7'), 'no grant for e2e address';
  ASSERT (SELECT count(*) FROM founding_members) = 4, 'four seats after two migration runs';

  -- 2. Launch-grant member keeps their year, not extended.
  SELECT * INTO fm FROM founding_members WHERE user_id = u1;
  SELECT * INTO s FROM user_subscriptions WHERE user_id = u1;
  ASSERT fm.grant_source = 'launch_auto_grant_2026' AND fm.granted_until = s.current_period_end, 'u1 launch grant kept';
  ASSERT s.current_period_end < now() + interval '241 days', 'u1 not extended';

  -- 3. A member without a subscription gets a Premium year.
  SELECT * INTO s FROM user_subscriptions WHERE user_id = u2;
  ASSERT s.plan_key = 'premium' AND s.status = 'active', 'u2 premium active';
  ASSERT s.current_period_end BETWEEN now() + interval '364 days' AND now() + interval '366 days', 'u2 one year';
  ASSERT s.metadata->>'source' = 'founding_1000' AND (s.metadata->>'seat_number')::int = 2, 'u2 metadata';
  ASSERT (SELECT count(*) FROM paywall_events WHERE user_id = u2 AND context->>'campaign' = 'founding_1000') = 1, 'u2 audited once';

  -- 4. A paying member is untouched.
  SELECT * INTO s FROM user_subscriptions WHERE user_id = u3;
  ASSERT s.metadata->>'source' = 'stripe' AND s.current_period_end < now() + interval '21 days', 'u3 stripe untouched';
  ASSERT (SELECT grant_source FROM founding_members WHERE user_id = u3) = 'stripe_active', 'u3 seat only';

  -- 5. A short code grant becomes a full year from now.
  SELECT * INTO s FROM user_subscriptions WHERE user_id = u6;
  ASSERT s.current_period_end > now() + interval '364 days' AND s.metadata->>'source' = 'founding_1000', 'u6 lifted to a year';

  -- 6. Claiming again returns the same seat and changes nothing.
  r := claim_founding_seat(u2, t);
  ASSERT (r->>'already')::boolean AND (r->>'seat_number')::int = 2, 'idempotent: ' || r::text;
  ASSERT claim_founding_seat(u4, t)->>'error' = 'NOT_ELIGIBLE', 'bot refused';
  ASSERT claim_founding_seat('00000000-0000-0000-0000-000000000001', t)->>'error' = 'NOT_ELIGIBLE', 'system bot refused';
  ASSERT claim_founding_seat('00000000-0000-0000-0000-0000000000a7', t)->>'error' = 'NOT_ELIGIBLE', 'e2e address refused';

  -- 7. A new signup gets the next seat through the trigger.
  INSERT INTO user_tenants (tenant_id, user_id, is_primary) VALUES (t, '00000000-0000-0000-0000-0000000000b7', true);
  ASSERT (SELECT seat_number FROM founding_members WHERE user_id = '00000000-0000-0000-0000-0000000000b7') = 5, 'trigger seat 5';
  ASSERT (SELECT status FROM user_subscriptions WHERE user_id = '00000000-0000-0000-0000-0000000000b7') = 'active', 'trigger grant';

  -- 8. Seat 1,001 is refused and the signup still succeeds.
  INSERT INTO founding_members (user_id, tenant_id, seat_number, grant_source)
  SELECT gen_random_uuid(), t, g, 'founding_1000' FROM generate_series(6, 1000) g;
  INSERT INTO user_tenants (tenant_id, user_id, is_primary) VALUES (t, '00000000-0000-0000-0000-0000000000b8', true);
  ASSERT NOT EXISTS (SELECT 1 FROM founding_members WHERE user_id = '00000000-0000-0000-0000-0000000000b8'), 'no seat 1001';
  ASSERT NOT EXISTS (SELECT 1 FROM user_subscriptions WHERE user_id = '00000000-0000-0000-0000-0000000000b8'), 'no grant after 1000';
  ASSERT claim_founding_seat('00000000-0000-0000-0000-0000000000b8', t)->>'error' = 'SOLD_OUT', 'sold out';

  -- 9. Celebration flag.
  ASSERT (mark_founding_celebrated(u2)->>'ok')::boolean, 'celebrated';
  ASSERT (SELECT celebrated_at FROM founding_members WHERE user_id = u2) IS NOT NULL, 'celebrated_at set';
  ASSERT mark_founding_celebrated(u4)->>'error' = 'NOT_A_FOUNDING_MEMBER', 'non-member refused';

  -- 10. The old code is retired.
  ASSERT NOT (SELECT is_active FROM redemption_codes WHERE code = 'FOUNDING'), 'FOUNDING code inactive';
END $$;

RESET ROLE;

-- Member side: reads only their own seat, cannot claim or edit.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', false) \gset
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM founding_members) = 1, 'member sees only their own row';
  ASSERT (SELECT seat_number FROM founding_members) = 2, 'own seat';
  BEGIN
    UPDATE founding_members SET seat_number = 1;
    RAISE EXCEPTION 'expected permission denied on UPDATE';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM claim_founding_seat('00000000-0000-0000-0000-0000000000a2', NULL);
    RAISE EXCEPTION 'expected permission denied on claim';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

\echo 'VTID-04859: all assertions passed'
