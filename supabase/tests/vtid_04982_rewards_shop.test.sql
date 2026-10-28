-- VTID-04982 assertions for the Rewards shop. Runs after the VTID-04809
-- wallet fixture + migration (real credit_wallet), the VTID-04878 fixture +
-- migration (members, test accounts, reward_sweep_is_excluded) and the
-- VTID-04982 migration applied twice. Any failed assertion raises.

SET ROLE service_role;

DO $$
DECLARE
  t   uuid := 'aaaaaaaa-0000-0000-0000-000000000000';
  m1  uuid := '00000000-0000-0000-0000-0000000000c1';
  m2  uuid := '00000000-0000-0000-0000-0000000000c2';
  tst uuid := '00000000-0000-0000-0000-0000000000d1';
  r   jsonb;
  o1  uuid;
  o2  uuid;
  addr jsonb := '{"name":"A Member","line1":"Street 1","postal_code":"10115","city":"Berlin"}';
  wine uuid;
  ticket uuid;
  cap  uuid;
BEGIN
  -- Earned VTNA: m1 2,000, m2 1,500; m1 also has 500 purchased (never spendable here).
  PERFORM public.credit_wallet(t, m1, 2000, 'reward', 'test', 'seed-m1', NULL);
  PERFORM public.credit_wallet(t, m1, 500, 'purchase', 'test', 'seed-m1-p', NULL);
  PERFORM public.credit_wallet(t, m2, 1500, 'reward', 'test', 'seed-m2', NULL);
  PERFORM public.credit_wallet(t, tst, 5000, 'reward', 'test', 'seed-tst', NULL);

  INSERT INTO public.reward_shop_items (slug, titles, vtna_price, fulfilment, age_restricted, min_age, ships_to_countries, stock, is_active)
  VALUES ('son-amaret-chardonnay', '{"de":"Son Amaret Chardonnay","en":"Son Amaret Chardonnay"}', 1200, 'ship', true, 18, ARRAY['DE','AT']::char(2)[], 1, true)
  RETURNING id INTO wine;
  INSERT INTO public.reward_shop_items (slug, titles, vtna_price, fulfilment, stock, is_active)
  VALUES ('event-ticket', '{"de":"Ticket"}', 300, 'event', 2, true) RETURNING id INTO ticket;
  INSERT INTO public.reward_shop_items (slug, titles, vtna_price, fulfilment, ships_to_countries, is_active)
  VALUES ('maxina-cap', '{"de":"Cap"}', 5000, 'ship', ARRAY['DE']::char(2)[], true) RETURNING id INTO cap;
  INSERT INTO public.reward_shipping_fees (country, currency, fee_cents) VALUES ('DE', 'EUR', 690), ('DE', 'USD', 790);

  -- 1. Event item: paid in VTNA now, from the earned bucket only.
  r := public.redeem_reward_item(t, m1, ticket, 'idem-ticket-0001');
  ASSERT (r->>'ok')::boolean AND r->>'status' = 'paid', 'ticket redeemed: ' || r::text;
  ASSERT (SELECT earned_balance FROM user_wallets WHERE user_id = m1 AND currency_type = 'CREDITS') = 1700, 'earned debited 300';
  ASSERT (SELECT balance FROM user_wallets WHERE user_id = m1 AND currency_type = 'CREDITS') = 2200, 'purchased untouched';
  ASSERT (SELECT stock FROM reward_shop_items WHERE id = ticket) = 1, 'stock decremented';

  -- 2. Replay of the same request: same order, no second debit.
  r := public.redeem_reward_item(t, m1, ticket, 'idem-ticket-0001');
  ASSERT (r->>'duplicate')::boolean AND (r->>'status') = 'paid', 'replay returns the order: ' || r::text;
  ASSERT (SELECT earned_balance FROM user_wallets WHERE user_id = m1 AND currency_type = 'CREDITS') = 1700, 'no second debit';
  ASSERT (SELECT count(*) FROM reward_orders WHERE user_id = m1) = 1, 'one order';

  -- 3. Insufficient earned balance (purchased credits do not count).
  r := public.redeem_reward_item(t, m1, cap, 'idem-cap-0001', 'EUR', 'DE', addr);
  ASSERT r->>'error' = 'INSUFFICIENT_BALANCE', 'cap too expensive: ' || r::text;

  -- 4. Age: missing confirmation, under age, then accepted; the birth date is not stored.
  r := public.redeem_reward_item(t, m1, wine, 'idem-wine-0001', 'EUR', 'DE', addr);
  ASSERT r->>'error' = 'AGE_CONFIRMATION_REQUIRED', 'age needed: ' || r::text;
  r := public.redeem_reward_item(t, m1, wine, 'idem-wine-0002', 'EUR', 'DE', addr, (current_date - interval '17 years')::date, true);
  ASSERT r->>'error' = 'UNDER_MIN_AGE', 'under 18 refused: ' || r::text;

  -- 5. Shipping checks: country not served, address missing.
  r := public.redeem_reward_item(t, m1, wine, 'idem-wine-0003', 'EUR', 'FR', addr, '1980-01-01', true);
  ASSERT r->>'error' = 'SHIPPING_NOT_AVAILABLE', 'FR not served: ' || r::text;
  r := public.redeem_reward_item(t, m1, wine, 'idem-wine-0004', 'EUR', 'DE', '{"name":"x"}', '1980-01-01', true);
  ASSERT r->>'error' = 'ADDRESS_REQUIRED', 'address needed: ' || r::text;
  r := public.redeem_reward_item(t, m1, wine, 'idem-wine-0005', 'EUR', 'AT', addr, '1980-01-01', true);
  ASSERT r->>'error' = 'SHIPPING_NOT_AVAILABLE', 'no AT fee row: ' || r::text;

  -- 6. Ship item: reserved, awaiting payment, no VTNA moved; the last unit is held from m2.
  r := public.redeem_reward_item(t, m1, wine, 'idem-wine-0006', 'EUR', 'DE', addr, '1980-01-01', true);
  ASSERT (r->>'ok')::boolean AND r->>'status' = 'awaiting_shipping_payment' AND (r->>'shipping_fee_cents')::int = 690,
    'wine reserved: ' || r::text;
  o1 := (r->>'order_id')::uuid;
  ASSERT (SELECT reserved FROM reward_shop_items WHERE id = wine) = 1, 'one unit reserved';
  ASSERT (SELECT earned_balance FROM user_wallets WHERE user_id = m1 AND currency_type = 'CREDITS') = 1700, 'no VTNA moved yet';
  ASSERT (SELECT age_confirmed_at IS NOT NULL FROM reward_orders WHERE id = o1), 'age confirmation time stored';
  ASSERT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reward_orders' AND column_name ILIKE '%birth%'),
    'no birth date column';
  r := public.redeem_reward_item(t, m2, wine, 'idem-wine-m2-01', 'USD', 'DE', addr, '1980-01-01', true);
  ASSERT r->>'error' = 'OUT_OF_STOCK', 'last unit held for m1: ' || r::text;

  -- 7. Settle: VTNA debited, reservation becomes a stock decrement; a repeat is a duplicate.
  r := public.settle_reward_order_shipping(o1, 'cs_test_1', 'pi_test_1');
  ASSERT (r->>'ok')::boolean AND r->>'status' = 'paid', 'settled: ' || r::text;
  ASSERT (SELECT earned_balance FROM user_wallets WHERE user_id = m1 AND currency_type = 'CREDITS') = 500, 'wine VTNA debited';
  ASSERT (SELECT stock FROM reward_shop_items WHERE id = wine) = 0 AND (SELECT reserved FROM reward_shop_items WHERE id = wine) = 0,
    'stock 0, nothing reserved';
  r := public.settle_reward_order_shipping(o1, 'cs_test_1', 'pi_test_1');
  ASSERT (r->>'duplicate')::boolean, 'repeat settle is a duplicate';
  ASSERT (SELECT earned_balance FROM user_wallets WHERE user_id = m1 AND currency_type = 'CREDITS') = 500, 'no double debit';

  -- 8. Expiry: m2 reserves a unit and never pays.
  UPDATE reward_shop_items SET stock = 1 WHERE id = wine;
  r := public.redeem_reward_item(t, m2, wine, 'idem-wine-m2-02', 'EUR', 'DE', addr, '1980-01-01', true);
  o2 := (r->>'order_id')::uuid;
  ASSERT (r->>'ok')::boolean, 'm2 reserved: ' || r::text;
  -- The sweep releases it once its 30 minutes are over; a second release is a no-op.
  ASSERT public.release_expired_reward_reservations(NULL, now() + interval '31 minutes') = 1, 'sweep released one';
  r := public.release_reward_reservation(o2, 'stripe_expired');
  ASSERT NOT (r->>'released')::boolean, 'second release is a no-op: ' || r::text;
  ASSERT (SELECT reserved FROM reward_shop_items WHERE id = wine) = 0, 'reserved not double-decremented';
  ASSERT (SELECT status FROM reward_orders WHERE id = o2) = 'cancelled', 'order cancelled';

  -- 9. A payment that lands after the release: stock still there -> settles; then out of stock -> refund.
  r := public.settle_reward_order_shipping(o2, 'cs_test_2', 'pi_test_2');
  ASSERT (r->>'ok')::boolean AND r->>'status' = 'paid', 'late payment settles when stock remains: ' || r::text;
  ASSERT (SELECT stock FROM reward_shop_items WHERE id = wine) = 0, 'stock taken by the late payment';
  UPDATE reward_shop_items SET stock = 1 WHERE id = wine;
  PERFORM public.credit_wallet(t, m2, 1500, 'reward', 'test', 'seed-m2-a', NULL);
  r := public.redeem_reward_item(t, m2, wine, 'idem-wine-m2-03', 'EUR', 'DE', addr, '1980-01-01', true);
  o2 := (r->>'order_id')::uuid;
  PERFORM public.release_reward_reservation(o2, 'expired');
  UPDATE reward_shop_items SET stock = 0 WHERE id = wine;  -- sold elsewhere meanwhile
  r := public.settle_reward_order_shipping(o2, 'cs_test_3', 'pi_test_3');
  ASSERT (r->>'refund')::boolean AND r->>'error' = 'OUT_OF_STOCK', 'late payment without stock is refunded: ' || r::text;
  ASSERT (SELECT status FROM reward_orders WHERE id = o2) = 'refunded', 'order refunded';

  -- 10. Settle after the VTNA was spent elsewhere: refund, reservation released.
  UPDATE reward_shop_items SET stock = 5 WHERE id = wine;
  PERFORM public.credit_wallet(t, m2, 1500, 'reward', 'test', 'seed-m2-b', NULL);
  r := public.redeem_reward_item(t, m2, wine, 'idem-wine-m2-04', 'EUR', 'DE', addr, '1980-01-01', true);
  o2 := (r->>'order_id')::uuid;
  PERFORM public.credit_wallet(t, m2, -(SELECT earned_balance FROM user_wallets WHERE user_id = m2 AND currency_type = 'CREDITS')::int,
                               'reward', 'test', 'drain-m2', NULL);
  r := public.settle_reward_order_shipping(o2, 'cs_test_4', 'pi_test_4');
  ASSERT (r->>'refund')::boolean AND r->>'error' = 'INSUFFICIENT_BALANCE', 'balance gone -> refund: ' || r::text;
  ASSERT (SELECT reserved FROM reward_shop_items WHERE id = wine) = 0, 'reservation released on refund';

  -- 11. Test accounts are refused.
  r := public.redeem_reward_item(t, tst, ticket, 'idem-tst-00001');
  ASSERT r->>'error' = 'NOT_ELIGIBLE', 'test account refused: ' || r::text;

  -- 12. Admin fulfilment transitions.
  r := public.set_reward_order_status(o1, 'shipped');
  ASSERT (r->>'ok')::boolean, 'paid -> shipped';
  r := public.set_reward_order_status(o1, 'paid');
  ASSERT r->>'error' = 'INVALID_TRANSITION', 'no going back: ' || r::text;

  -- 13. Inactive items cannot be redeemed.
  UPDATE reward_shop_items SET is_active = false WHERE id = ticket;
  r := public.redeem_reward_item(t, m2, ticket, 'idem-ticket-m2-1');
  ASSERT r->>'error' = 'ITEM_NOT_AVAILABLE', 'inactive item: ' || r::text;
END $$;

RESET ROLE;

-- Members: no function access, read only their own orders and active items.
DO $$
BEGIN
  ASSERT NOT has_function_privilege('authenticated', 'public.redeem_reward_item(uuid,uuid,uuid,text,text,text,jsonb,date,boolean,timestamptz)', 'EXECUTE'),
    'members cannot redeem directly';
  ASSERT NOT has_function_privilege('authenticated', 'public.settle_reward_order_shipping(uuid,text,text,timestamptz)', 'EXECUTE'),
    'members cannot settle';
  ASSERT NOT has_table_privilege('authenticated', 'public.reward_orders', 'INSERT'), 'members cannot insert orders';
END $$;

\echo 'VTID-04982: all assertions passed'
