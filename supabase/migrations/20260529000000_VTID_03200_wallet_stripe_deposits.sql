/**
 * Vitana Wallet — Stripe Deposit Schema (multi-currency: EUR + USD)
 *
 * VTID: VTID-03200
 *
 * Tables:
 *   - wallet_accounts          — one row per (user, currency); cached balance
 *   - wallet_deposits          — Stripe Checkout deposit intent + lifecycle
 *   - wallet_ledger_entries    — append-only money movements; source of truth
 *   - stripe_webhook_events    — wallet-source Stripe event audit + replay guard
 *
 * Trigger:
 *   - on_auth_user_created_wallet — provisions EUR + USD accounts at signup
 *
 * RPC:
 *   - credit_deposit(p_deposit_id, p_stripe_event_id, p_stripe_pi_id)
 *       Idempotent finalization called from the webhook handler. Inserts the
 *       ledger entry, updates cached balance, marks deposit succeeded — all
 *       in a single transaction.
 *
 * Money is stored as bigint minor units (cents). Never as float.
 *
 * Idempotency layers:
 *   1. stripe_webhook_events.stripe_event_id  unique  (Stripe redelivery)
 *   2. wallet_ledger_entries  unique(reference_type, reference_id, entry_type)
 *      (different events finalizing the same deposit cannot double-credit)
 *   3. wallet_deposits.status='succeeded' early-return in RPC (race-free under
 *      SELECT FOR UPDATE)
 *
 * Sibling but separate from wallet_transactions / credit_wallet (VTID-01250)
 * which is the unitless rewards/automations credit ledger. They will be
 * unified at the product layer later; do not cross the streams here.
 *
 * VTID-03159 hazard guard: see "Drift check" block below. Refuses to run if
 * a same-named table already exists with mismatched columns.
 */

-- ============================================================================
-- 0. Drift check — VTID-03159 lesson. Hard-fail on column mismatch instead of
--    silently no-op'ing CREATE TABLE IF NOT EXISTS against an uncommitted
--    experimental table.
-- ============================================================================
DO $$
DECLARE
  v_drift_msg text;
BEGIN
  -- wallet_accounts: expected columns must include id, user_id, currency, balance_minor
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='wallet_accounts') THEN
    SELECT string_agg(column_name, ',' ORDER BY column_name) INTO v_drift_msg
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='wallet_accounts';
    IF v_drift_msg NOT LIKE '%balance_minor%' OR v_drift_msg NOT LIKE '%currency%' THEN
      RAISE EXCEPTION 'VTID-03200 drift guard: public.wallet_accounts exists with unexpected columns (%). Resolve before re-running migration.', v_drift_msg;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='wallet_deposits') THEN
    SELECT string_agg(column_name, ',' ORDER BY column_name) INTO v_drift_msg
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='wallet_deposits';
    IF v_drift_msg NOT LIKE '%amount_minor%' OR v_drift_msg NOT LIKE '%stripe_checkout_session_id%' THEN
      RAISE EXCEPTION 'VTID-03200 drift guard: public.wallet_deposits exists with unexpected columns (%). Resolve before re-running migration.', v_drift_msg;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='wallet_ledger_entries') THEN
    SELECT string_agg(column_name, ',' ORDER BY column_name) INTO v_drift_msg
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='wallet_ledger_entries';
    IF v_drift_msg NOT LIKE '%entry_type%' OR v_drift_msg NOT LIKE '%direction%' THEN
      RAISE EXCEPTION 'VTID-03200 drift guard: public.wallet_ledger_entries exists with unexpected columns (%). Resolve before re-running migration.', v_drift_msg;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='stripe_webhook_events') THEN
    SELECT string_agg(column_name, ',' ORDER BY column_name) INTO v_drift_msg
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='stripe_webhook_events';
    IF v_drift_msg NOT LIKE '%stripe_event_id%' OR v_drift_msg NOT LIKE '%source%' THEN
      RAISE EXCEPTION 'VTID-03200 drift guard: public.stripe_webhook_events exists with unexpected columns (%). Resolve before re-running migration.', v_drift_msg;
    END IF;
  END IF;
END $$;

-- ============================================================================
-- 1. wallet_accounts — one row per (user, currency); cached balance
-- ============================================================================
CREATE TABLE IF NOT EXISTS wallet_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  currency        text NOT NULL CHECK (currency IN ('EUR', 'USD')),
  balance_minor   bigint NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, currency)
);

CREATE INDEX IF NOT EXISTS idx_wallet_accounts_user
  ON wallet_accounts (user_id);

ALTER TABLE wallet_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own wallet accounts"
  ON wallet_accounts FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Service role manage wallet accounts"
  ON wallet_accounts FOR ALL
  USING (true) WITH CHECK (true);

-- ============================================================================
-- 2. wallet_deposits — Stripe Checkout deposit intent + lifecycle
-- ============================================================================
CREATE TABLE IF NOT EXISTS wallet_deposits (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     uuid NOT NULL REFERENCES auth.users(id),
  account_id                  uuid NOT NULL REFERENCES wallet_accounts(id),
  amount_minor                bigint NOT NULL CHECK (amount_minor > 0),
  currency                    text NOT NULL CHECK (currency IN ('EUR', 'USD')),
  status                      text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'checkout_started', 'succeeded', 'failed', 'canceled', 'expired')),
  idempotency_key             text NOT NULL UNIQUE,
  stripe_checkout_session_id  text UNIQUE,
  stripe_payment_intent_id    text UNIQUE,
  failure_reason              text,
  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_deposits_user_created
  ON wallet_deposits (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_deposits_inflight
  ON wallet_deposits (status) WHERE status IN ('created', 'checkout_started');

ALTER TABLE wallet_deposits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own deposits"
  ON wallet_deposits FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Service role manage deposits"
  ON wallet_deposits FOR ALL
  USING (true) WITH CHECK (true);

-- ============================================================================
-- 3. wallet_ledger_entries — append-only money movements; source of truth
-- ============================================================================
CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES wallet_accounts(id),
  user_id         uuid NOT NULL,
  entry_type      text NOT NULL
    CHECK (entry_type IN ('deposit_completed', 'service_spend', 'manual_adjustment', 'refund_debit')),
  direction       text NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  currency        text NOT NULL CHECK (currency IN ('EUR', 'USD')),
  reference_type  text NOT NULL,
  reference_id    text NOT NULL,
  description     text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Idempotency: one entry per (reference, entry_type) — second insert fails,
  -- transaction rolls back, webhook returns 200 because the event was already
  -- processed on a previous delivery.
  UNIQUE (reference_type, reference_id, entry_type)
);

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_account_created
  ON wallet_ledger_entries (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user_created
  ON wallet_ledger_entries (user_id, created_at DESC);

ALTER TABLE wallet_ledger_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own ledger entries"
  ON wallet_ledger_entries FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Service role manage ledger entries"
  ON wallet_ledger_entries FOR ALL
  USING (true) WITH CHECK (true);

-- ============================================================================
-- 4. stripe_webhook_events — audit + replay-safe event ledger (wallet source)
-- ============================================================================
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id   text NOT NULL UNIQUE,
  event_type        text NOT NULL,
  source            text NOT NULL CHECK (source IN ('wallet', 'payments', 'connect')),
  payload           jsonb NOT NULL,
  processed_at      timestamptz,
  processing_error  text,
  received_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_type_received
  ON stripe_webhook_events (event_type, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_unprocessed
  ON stripe_webhook_events (received_at DESC) WHERE processed_at IS NULL;

ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;
-- Service role only; no user policy (no user-visible reads).
CREATE POLICY "Service role manage stripe_webhook_events"
  ON stripe_webhook_events FOR ALL
  USING (true) WITH CHECK (true);

-- ============================================================================
-- 5. Auto-provision wallets at signup
-- ============================================================================
-- Trigger fires on auth.users insert, creates EUR + USD accounts atomically.
-- SECURITY DEFINER required because the trigger runs as the auth-admin role.
-- search_path is pinned to prevent shadow-table hijacks.
CREATE OR REPLACE FUNCTION public.provision_wallet_accounts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.wallet_accounts (user_id, currency)
  VALUES (NEW.id, 'EUR'), (NEW.id, 'USD')
  ON CONFLICT (user_id, currency) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_wallet ON auth.users;
CREATE TRIGGER on_auth_user_created_wallet
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.provision_wallet_accounts();

-- ============================================================================
-- 6. RPC: credit_deposit — idempotent finalization from webhook handler
-- ============================================================================
CREATE OR REPLACE FUNCTION credit_deposit(
  p_deposit_id      uuid,
  p_stripe_event_id text,
  p_stripe_pi_id    text DEFAULT NULL
)
RETURNS jsonb AS $$
DECLARE
  v_deposit  wallet_deposits%ROWTYPE;
  v_balance  bigint;
BEGIN
  -- Lock the deposit row to serialize concurrent webhook deliveries
  SELECT * INTO v_deposit
    FROM wallet_deposits
    WHERE id = p_deposit_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DEPOSIT_NOT_FOUND');
  END IF;

  -- Fast path: already succeeded on a prior delivery
  IF v_deposit.status = 'succeeded' THEN
    SELECT balance_minor INTO v_balance
      FROM wallet_accounts WHERE id = v_deposit.account_id;
    RETURN jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'balance_minor', v_balance,
      'currency', v_deposit.currency
    );
  END IF;

  -- Refuse to credit a terminal-failed/canceled deposit
  IF v_deposit.status IN ('failed', 'canceled', 'expired') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DEPOSIT_NOT_PENDING', 'status', v_deposit.status);
  END IF;

  -- Append ledger entry. The UNIQUE(reference_type, reference_id, entry_type)
  -- guard makes this the structural prevention of double-credit.
  INSERT INTO wallet_ledger_entries (
    account_id, user_id, entry_type, direction,
    amount_minor, currency,
    reference_type, reference_id, description, metadata
  ) VALUES (
    v_deposit.account_id, v_deposit.user_id, 'deposit_completed', 'credit',
    v_deposit.amount_minor, v_deposit.currency,
    'wallet_deposit', v_deposit.id::text, 'Stripe deposit',
    jsonb_build_object(
      'stripe_event_id', p_stripe_event_id,
      'stripe_payment_intent_id', p_stripe_pi_id,
      'stripe_checkout_session_id', v_deposit.stripe_checkout_session_id
    )
  );

  -- Update cached balance
  UPDATE wallet_accounts
     SET balance_minor = balance_minor + v_deposit.amount_minor,
         updated_at    = now()
   WHERE id = v_deposit.account_id
   RETURNING balance_minor INTO v_balance;

  -- Mark deposit succeeded
  UPDATE wallet_deposits
     SET status                   = 'succeeded',
         stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, p_stripe_pi_id),
         updated_at               = now()
   WHERE id = p_deposit_id;

  RETURN jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'balance_minor', v_balance,
    'currency', v_deposit.currency
  );

EXCEPTION WHEN unique_violation THEN
  -- Race: another worker beat us to the ledger insert. Report current balance
  -- as success — the deposit IS credited, just not by us.
  SELECT balance_minor INTO v_balance
    FROM wallet_accounts WHERE id = v_deposit.account_id;
  RETURN jsonb_build_object(
    'ok', true,
    'duplicate', true,
    'balance_minor', v_balance,
    'currency', v_deposit.currency
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- 7. Backfill: provision EUR + USD accounts for existing users
-- ============================================================================
INSERT INTO wallet_accounts (user_id, currency)
SELECT u.id, c.currency
  FROM auth.users u
  CROSS JOIN (VALUES ('EUR'), ('USD')) AS c(currency)
ON CONFLICT (user_id, currency) DO NOTHING;
