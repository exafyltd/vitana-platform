-- =============================================================================
-- VTID-04982 — Rewards shop: members spend earned VTNA on items
-- -----------------------------------------------------------------------------
-- Owner decisions (BUSINESS-MODEL.md §11 items 6 and 8): a Rewards Shop in
-- the Wallet prices items in VTNA (1 VTNA = EUR 0.01) with the EUR/USD
-- equivalent; only EARNED VTNA is spent, through credit_wallet() (VTID-04809);
-- wine needs an age confirmation and the member pays shipping.
--
-- Tables
--   reward_shop_items     the catalogue (admin data; titles per locale)
--   reward_shipping_fees  flat shipping fee per destination country/currency
--   reward_orders         one row per redemption
--
-- Shop items are deliberately NOT rows in public.products: that table is read
-- by 20+ Discover / ORB / shopping-agent / checkout query sites, and VTNA
-- items must never appear as marketplace offerings or influence ranking.
--
-- Flow
--   event / digital items: redeem_reward_item() debits VTNA, takes one unit of
--     stock and creates the order 'paid' in one transaction.
--   ship items: redeem_reward_item() RESERVES one unit and creates the order
--     'awaiting_shipping_payment' (no VTNA moves). The member pays shipping in
--     Stripe Checkout; settle_reward_order_shipping() then debits VTNA and
--     turns the reservation into a stock decrement. If the VTNA is gone by
--     then, or a late payment finds no stock, the order is 'refunded' and the
--     gateway refunds the Stripe charge. An unpaid hold expires after 30 min
--     (Stripe's session expiry), released by the checkout.session.expired
--     webhook, by release_expired_reward_reservations() every 5 minutes, and
--     before every redeem of the same item.
--
-- Birth dates are checked and discarded; only age_confirmed_at is stored.
-- reward_orders has a uuid user_id and no FK to auth.users, so
-- erase_user_data() (VTID-04765) deletes a member's orders, address included.
--
-- Test / service accounts are refused (reward_sweep_is_excluded, VTID-04878;
-- CLAUDE.md rules 43-45). Every function is service_role only.
-- =============================================================================

BEGIN;

-- The shop must not open while members can still debit other members'
-- credits through fn_consume_credits (VTID-04981 runs first).
DO $pre$
BEGIN
  IF to_regprocedure('public.fn_consume_credits(uuid,uuid,integer,text,text,text)') IS NOT NULL
     AND (has_function_privilege('authenticated', 'public.fn_consume_credits(uuid,uuid,integer,text,text,text)', 'EXECUTE')
          OR has_function_privilege('anon', 'public.fn_consume_credits(uuid,uuid,integer,text,text,text)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'VTID-04982: apply VTID-04981 first — fn_consume_credits is still executable by members';
  END IF;
END
$pre$;

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.reward_shop_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  titles              jsonb NOT NULL CHECK (jsonb_typeof(titles) = 'object' AND titles ? 'de'),
  descriptions        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(descriptions) = 'object'),
  images              text[] NOT NULL DEFAULT '{}',
  vtna_price          integer NOT NULL CHECK (vtna_price > 0),
  fulfilment          text NOT NULL CHECK (fulfilment IN ('ship', 'event', 'digital')),
  age_restricted      boolean NOT NULL DEFAULT false,
  min_age             smallint CHECK (min_age IS NULL OR min_age BETWEEN 1 AND 99),
  ships_to_countries  char(2)[] NOT NULL DEFAULT '{}',
  stock               integer CHECK (stock IS NULL OR stock >= 0),
  reserved            integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  is_active           boolean NOT NULL DEFAULT false,
  sort_order          integer NOT NULL DEFAULT 100,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT age_restricted OR min_age IS NOT NULL),
  CHECK (fulfilment <> 'ship' OR cardinality(ships_to_countries) > 0 OR NOT is_active),
  CHECK (stock IS NULL OR reserved <= stock)
);

CREATE TABLE IF NOT EXISTS public.reward_shipping_fees (
  country     char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  currency    text NOT NULL CHECK (currency IN ('EUR', 'USD')),
  fee_cents   integer NOT NULL CHECK (fee_cents >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (country, currency)
);

CREATE TABLE IF NOT EXISTS public.reward_orders (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL,
  user_id                 uuid NOT NULL,
  item_id                 uuid NOT NULL REFERENCES public.reward_shop_items(id),
  vtna_amount             integer NOT NULL CHECK (vtna_amount > 0),
  fulfilment              text NOT NULL CHECK (fulfilment IN ('ship', 'event', 'digital')),
  status                  text NOT NULL CHECK (status IN ('awaiting_shipping_payment', 'paid', 'fulfilling',
                                                          'shipped', 'delivered', 'cancelled', 'refunded')),
  country                 char(2),
  shipping_address        jsonb,
  shipping_fee_cents      integer CHECK (shipping_fee_cents IS NULL OR shipping_fee_cents >= 0),
  shipping_currency       text CHECK (shipping_currency IS NULL OR shipping_currency IN ('EUR', 'USD')),
  stripe_session_id       text UNIQUE,
  stripe_payment_intent   text,
  age_confirmed_at        timestamptz,
  reservation_held        boolean NOT NULL DEFAULT false,
  reservation_expires_at  timestamptz,
  paid_at                 timestamptz,
  status_reason           text,
  idempotency_key         text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS reward_orders_user_idx ON public.reward_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reward_orders_awaiting_idx ON public.reward_orders (reservation_expires_at)
  WHERE status = 'awaiting_shipping_payment';
CREATE INDEX IF NOT EXISTS reward_orders_status_idx ON public.reward_orders (status, created_at DESC);

ALTER TABLE public.reward_shop_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_shipping_fees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_orders ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.reward_shop_items, public.reward_shipping_fees, public.reward_orders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.reward_shop_items, public.reward_shipping_fees, public.reward_orders TO authenticated;
GRANT ALL ON public.reward_shop_items, public.reward_shipping_fees, public.reward_orders TO service_role;

DROP POLICY IF EXISTS reward_shop_items_read_active ON public.reward_shop_items;
CREATE POLICY reward_shop_items_read_active ON public.reward_shop_items
  FOR SELECT TO authenticated USING (is_active);
DROP POLICY IF EXISTS reward_shipping_fees_read ON public.reward_shipping_fees;
CREATE POLICY reward_shipping_fees_read ON public.reward_shipping_fees
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS reward_orders_read_own ON public.reward_orders;
CREATE POLICY reward_orders_read_own ON public.reward_orders
  FOR SELECT TO authenticated USING (user_id = auth.uid());

COMMENT ON TABLE public.reward_shop_items IS
  'VTID-04982: Rewards shop catalogue, priced in earned VTNA. Admin data (titles/descriptions per locale). Never read by Discover/marketplace code.';
COMMENT ON TABLE public.reward_shipping_fees IS
  'VTID-04982: flat shipping fee per destination country and currency for shipped rewards; the member pays it in Stripe Checkout.';
COMMENT ON TABLE public.reward_orders IS
  'VTID-04982: one row per Rewards shop redemption. Written only by the redeem/settle/release functions (service_role).';

-- -----------------------------------------------------------------------------
-- release_reward_reservation: idempotent; a no-op unless the order still holds
-- its reservation and awaits payment.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_reward_reservation(p_order uuid, p_reason text DEFAULT 'expired')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_order public.reward_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.reward_orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ORDER_NOT_FOUND');
  END IF;
  IF v_order.status <> 'awaiting_shipping_payment' THEN
    RETURN jsonb_build_object('ok', true, 'released', false, 'status', v_order.status);
  END IF;

  IF v_order.reservation_held THEN
    UPDATE public.reward_shop_items
       SET reserved = greatest(reserved - 1, 0), updated_at = now()
     WHERE id = v_order.item_id;
  END IF;
  UPDATE public.reward_orders
     SET status = 'cancelled', reservation_held = false, status_reason = p_reason, updated_at = now()
   WHERE id = p_order;
  RETURN jsonb_build_object('ok', true, 'released', true, 'order_id', p_order);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.release_expired_reward_reservations(p_item uuid DEFAULT NULL, p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id uuid;
  v_n  integer := 0;
  v_r  jsonb;
BEGIN
  FOR v_id IN
    SELECT id FROM public.reward_orders
     WHERE status = 'awaiting_shipping_payment'
       AND reservation_expires_at < p_now
       AND (p_item IS NULL OR item_id = p_item)
     ORDER BY reservation_expires_at
  LOOP
    v_r := public.release_reward_reservation(v_id, 'expired');
    IF COALESCE((v_r->>'released')::boolean, false) THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$fn$;

-- -----------------------------------------------------------------------------
-- redeem_reward_item
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_reward_item(
  p_tenant_id        uuid,
  p_user_id          uuid,
  p_item_id          uuid,
  p_idempotency_key  text,
  p_currency         text DEFAULT 'EUR',
  p_country          text DEFAULT NULL,
  p_address          jsonb DEFAULT NULL,
  p_birth_date       date DEFAULT NULL,
  p_age_confirmed    boolean DEFAULT false,
  p_now              timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_existing  public.reward_orders%ROWTYPE;
  v_item      public.reward_shop_items%ROWTYPE;
  v_earned    numeric;
  v_fee       integer;
  v_country   char(2);
  v_order     uuid := gen_random_uuid();
  v_credit    jsonb;
BEGIN
  IF p_tenant_id IS NULL OR p_user_id IS NULL OR p_item_id IS NULL
     OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ARGS_REQUIRED');
  END IF;
  IF p_currency NOT IN ('EUR', 'USD') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_CURRENCY');
  END IF;
  IF public.reward_sweep_is_excluded(p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_ELIGIBLE');
  END IF;

  -- One redemption per member at a time.
  PERFORM pg_advisory_xact_lock(hashtextextended('reward_shop:' || p_user_id::text, 0));

  -- A replay of the same request returns the order it created.
  SELECT * INTO v_existing FROM public.reward_orders
   WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'order_id', v_existing.id,
      'status', v_existing.status, 'vtna_amount', v_existing.vtna_amount,
      'shipping_fee_cents', v_existing.shipping_fee_cents, 'shipping_currency', v_existing.shipping_currency,
      'reservation_expires_at', v_existing.reservation_expires_at);
  END IF;

  -- Expired holds on this item never block the next member.
  PERFORM public.release_expired_reward_reservations(p_item_id, p_now);

  SELECT * INTO v_item FROM public.reward_shop_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND OR NOT v_item.is_active THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ITEM_NOT_AVAILABLE');
  END IF;

  IF v_item.age_restricted THEN
    IF NOT COALESCE(p_age_confirmed, false) OR p_birth_date IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'AGE_CONFIRMATION_REQUIRED', 'min_age', v_item.min_age);
    END IF;
    IF date_part('year', age((p_now AT TIME ZONE 'UTC')::date, p_birth_date)) < v_item.min_age THEN
      RETURN jsonb_build_object('ok', false, 'error', 'UNDER_MIN_AGE', 'min_age', v_item.min_age);
    END IF;
  END IF;

  IF v_item.fulfilment = 'ship' THEN
    v_country := upper(btrim(COALESCE(p_country, '')));
    IF v_country !~ '^[A-Z]{2}$' OR NOT (v_country = ANY (v_item.ships_to_countries)) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'SHIPPING_NOT_AVAILABLE', 'country', v_country);
    END IF;
    IF p_address IS NULL OR jsonb_typeof(p_address) <> 'object'
       OR COALESCE(btrim(p_address->>'name'), '') = '' OR COALESCE(btrim(p_address->>'line1'), '') = ''
       OR COALESCE(btrim(p_address->>'postal_code'), '') = '' OR COALESCE(btrim(p_address->>'city'), '') = '' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'ADDRESS_REQUIRED');
    END IF;
    SELECT fee_cents INTO v_fee FROM public.reward_shipping_fees
     WHERE country = v_country AND currency = p_currency;
    IF v_fee IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'SHIPPING_NOT_AVAILABLE', 'country', v_country);
    END IF;
  END IF;

  IF v_item.stock IS NOT NULL AND v_item.stock - v_item.reserved <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'OUT_OF_STOCK');
  END IF;

  SELECT COALESCE(earned_balance, 0) INTO v_earned FROM public.user_wallets
   WHERE user_id = p_user_id AND currency_type = 'CREDITS';
  IF COALESCE(v_earned, 0) < v_item.vtna_price THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_BALANCE',
      'vtna_price', v_item.vtna_price, 'earned_balance', COALESCE(v_earned, 0));
  END IF;

  IF v_item.fulfilment = 'ship' THEN
    -- Hold one unit; VTNA moves only once shipping is paid.
    UPDATE public.reward_shop_items SET reserved = reserved + 1, updated_at = now() WHERE id = v_item.id;
    INSERT INTO public.reward_orders (id, tenant_id, user_id, item_id, vtna_amount, fulfilment, status,
      country, shipping_address, shipping_fee_cents, shipping_currency, age_confirmed_at,
      reservation_held, reservation_expires_at, idempotency_key)
    VALUES (v_order, p_tenant_id, p_user_id, v_item.id, v_item.vtna_price, 'ship', 'awaiting_shipping_payment',
      v_country, p_address, v_fee, p_currency,
      CASE WHEN v_item.age_restricted THEN p_now END,
      true, p_now + interval '30 minutes', p_idempotency_key);
    RETURN jsonb_build_object('ok', true, 'order_id', v_order, 'status', 'awaiting_shipping_payment',
      'vtna_amount', v_item.vtna_price, 'shipping_fee_cents', v_fee, 'shipping_currency', p_currency,
      'reservation_expires_at', p_now + interval '30 minutes');
  END IF;

  -- event / digital: pay with VTNA now.
  v_credit := public.credit_wallet(p_tenant_id, p_user_id, -v_item.vtna_price, 'reward', 'reward_shop',
                                   'reward_shop:' || v_order::text, 'Rewards shop: ' || v_item.slug);
  IF COALESCE((v_credit->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'error', COALESCE(v_credit->>'error', 'DEBIT_FAILED'));
  END IF;
  IF v_item.stock IS NOT NULL THEN
    UPDATE public.reward_shop_items SET stock = stock - 1, updated_at = now() WHERE id = v_item.id;
  END IF;
  INSERT INTO public.reward_orders (id, tenant_id, user_id, item_id, vtna_amount, fulfilment, status,
    age_confirmed_at, paid_at, idempotency_key)
  VALUES (v_order, p_tenant_id, p_user_id, v_item.id, v_item.vtna_price, v_item.fulfilment, 'paid',
    CASE WHEN v_item.age_restricted THEN p_now END, p_now, p_idempotency_key);
  RETURN jsonb_build_object('ok', true, 'order_id', v_order, 'status', 'paid', 'vtna_amount', v_item.vtna_price,
    'earned_balance', v_credit->'earned_balance');
END;
$fn$;

-- -----------------------------------------------------------------------------
-- settle_reward_order_shipping: Stripe confirmed the shipping payment.
-- Returns refund=true when the gateway must refund the Stripe charge.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_reward_order_shipping(
  p_order_id        uuid,
  p_session_id      text,
  p_payment_intent  text,
  p_now             timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_order   public.reward_orders%ROWTYPE;
  v_item    public.reward_shop_items%ROWTYPE;
  v_credit  jsonb;
  v_held    boolean;
BEGIN
  SELECT * INTO v_order FROM public.reward_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ORDER_NOT_FOUND', 'refund', true);
  END IF;
  IF v_order.stripe_session_id IS NOT NULL AND v_order.stripe_session_id <> p_session_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SESSION_MISMATCH', 'refund', true);
  END IF;
  IF v_order.status IN ('paid', 'fulfilling', 'shipped', 'delivered') THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'status', v_order.status);
  END IF;
  IF v_order.status = 'refunded' THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'status', 'refunded', 'refund', false);
  END IF;
  IF v_order.status NOT IN ('awaiting_shipping_payment', 'cancelled') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATUS', 'status', v_order.status, 'refund', true);
  END IF;

  SELECT * INTO v_item FROM public.reward_shop_items WHERE id = v_order.item_id FOR UPDATE;
  v_held := v_order.reservation_held;

  -- A payment after the hold was released needs a unit again.
  IF NOT v_held AND v_item.stock IS NOT NULL AND v_item.stock - v_item.reserved <= 0 THEN
    UPDATE public.reward_orders
       SET status = 'refunded', status_reason = 'out_of_stock_after_release',
           stripe_session_id = p_session_id, stripe_payment_intent = p_payment_intent, updated_at = now()
     WHERE id = v_order.id;
    RETURN jsonb_build_object('ok', false, 'error', 'OUT_OF_STOCK', 'refund', true);
  END IF;

  v_credit := public.credit_wallet(v_order.tenant_id, v_order.user_id, -v_order.vtna_amount, 'reward', 'reward_shop',
                                   'reward_shop:' || v_order.id::text, 'Rewards shop: ' || v_item.slug);
  IF COALESCE((v_credit->>'ok')::boolean, false) IS NOT TRUE THEN
    IF v_held THEN
      UPDATE public.reward_shop_items SET reserved = greatest(reserved - 1, 0), updated_at = now() WHERE id = v_item.id;
    END IF;
    UPDATE public.reward_orders
       SET status = 'refunded', reservation_held = false,
           status_reason = lower(COALESCE(v_credit->>'error', 'debit_failed')),
           stripe_session_id = p_session_id, stripe_payment_intent = p_payment_intent, updated_at = now()
     WHERE id = v_order.id;
    RETURN jsonb_build_object('ok', false, 'error', COALESCE(v_credit->>'error', 'DEBIT_FAILED'), 'refund', true);
  END IF;

  UPDATE public.reward_shop_items
     SET reserved = CASE WHEN v_held THEN greatest(reserved - 1, 0) ELSE reserved END,
         stock = CASE WHEN stock IS NULL THEN NULL ELSE stock - 1 END,
         updated_at = now()
   WHERE id = v_item.id;
  UPDATE public.reward_orders
     SET status = 'paid', reservation_held = false, paid_at = p_now, status_reason = NULL,
         stripe_session_id = p_session_id, stripe_payment_intent = p_payment_intent, updated_at = now()
   WHERE id = v_order.id;
  RETURN jsonb_build_object('ok', true, 'status', 'paid', 'order_id', v_order.id, 'refund', false);
END;
$fn$;

-- Admin fulfilment transitions (exafy_admin through the gateway).
CREATE OR REPLACE FUNCTION public.set_reward_order_status(p_order_id uuid, p_status text, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_order public.reward_orders%ROWTYPE;
  v_ok    boolean;
BEGIN
  SELECT * INTO v_order FROM public.reward_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ORDER_NOT_FOUND');
  END IF;
  v_ok := (v_order.status, p_status) IN (('paid', 'fulfilling'), ('paid', 'shipped'), ('fulfilling', 'shipped'),
                                         ('shipped', 'delivered'), ('paid', 'delivered'), ('fulfilling', 'delivered'));
  IF NOT v_ok THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_TRANSITION', 'from', v_order.status, 'to', p_status);
  END IF;
  UPDATE public.reward_orders SET status = p_status, status_reason = p_reason, updated_at = now() WHERE id = p_order_id;
  RETURN jsonb_build_object('ok', true, 'order_id', p_order_id, 'from', v_order.status, 'to', p_status);
END;
$fn$;

REVOKE ALL ON FUNCTION public.release_reward_reservation(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_expired_reward_reservations(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_reward_item(uuid, uuid, uuid, text, text, text, jsonb, date, boolean, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_reward_order_shipping(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_reward_order_status(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_reward_reservation(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_expired_reward_reservations(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.redeem_reward_item(uuid, uuid, uuid, text, text, text, jsonb, date, boolean, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_reward_order_shipping(uuid, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_reward_order_status(uuid, text, text) TO service_role;

-- Self-check: members cannot call any of it.
DO $check$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.release_reward_reservation(uuid,text)',
    'public.release_expired_reward_reservations(uuid,timestamptz)',
    'public.redeem_reward_item(uuid,uuid,uuid,text,text,text,jsonb,date,boolean,timestamptz)',
    'public.settle_reward_order_shipping(uuid,text,text,timestamptz)',
    'public.set_reward_order_status(uuid,text,text)'
  ] LOOP
    IF has_function_privilege('authenticated', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'VTID-04982: % must not be executable by members', f;
    END IF;
  END LOOP;
  IF has_table_privilege('authenticated', 'public.reward_orders', 'INSERT')
     OR has_table_privilege('authenticated', 'public.reward_orders', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.reward_shop_items', 'UPDATE') THEN
    RAISE EXCEPTION 'VTID-04982: members must not write the shop tables';
  END IF;
END
$check$;

COMMIT;
