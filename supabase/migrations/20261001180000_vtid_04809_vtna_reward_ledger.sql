-- =============================================================================
-- VTID-04809: user_wallets.CREDITS becomes the canonical VTNA ledger
-- =============================================================================
-- Owner decisions 2026-10-01 (rewards & engagement plan, Phase 1):
--   * user_wallets.CREDITS is the official VTNA ledger (VTNA was folded into
--     CREDITS 1:1 on 2026-07-20).
--   * Rewards (shop, subscription conversion) spend EARNED VTNA only, so the
--     ledger must tell earned credits from purchased ones.
--   * VTNA is pegged to EUR: 1 VTNA = EUR 0.01.
--
-- What this migration does
--   1. user_wallets.earned_balance — the earned part of the CREDITS balance.
--      CHECK 0 <= earned_balance <= balance. Every existing debit path
--      (subtract, exchange, transfer, withdraw) only lowers `balance`, so the
--      CHECK makes it impossible for them to spend earned VTNA: they can only
--      consume the purchased part (balance - earned_balance).
--   2. wallet_transactions.idempotency_key + credit_source, with a unique
--      (user, idempotency_key) index, so a reward can never land twice.
--   3. credit_wallet(...) — re-created with the exact signature its seven
--      live callers already use (diary streaks, milestones, AP-0708,
--      Stripe credit packs, complete_autopilot_recommendation,
--      fn_consume_credits). It never existed live (docs/AURORA-B3-RPC-PARITY-
--      INVENTORY.md §1): `wallet_balances` was never created, so every reward
--      those callers promised members was silently dropped. It now writes to
--      user_wallets.CREDITS. p_type 'reward' -> earned bucket, 'purchase' ->
--      purchased bucket; anything else (e.g. 'earning' = cash) is refused —
--      cash belongs in wallet_accounts. Negative amounts debit the named
--      bucket and are refused with INSUFFICIENT_BALANCE when it is short.
--   4. Closes two self-credit holes (all 251 live balances are 0, so nothing
--      was lost, but VTNA is about to buy real goods):
--        a. RLS policy "Users can update their own wallets" + table UPDATE
--           grant let any signed-in member PATCH their own balance through
--           PostgREST. Dropped; members keep SELECT only.
--        b. update_user_balance(..., 'add') let a member add any amount to
--           their own balance (BuyCreditsPopup used it for "bonus" credits).
--           'add' is now refused; 'subtract' on one's own wallet still works.
--      Members also lose direct INSERT on wallet_transactions; every client
--      write already goes through SECURITY DEFINER RPCs.
--   5. EUR peg rows in exchange_rates (EUR<->CREDITS, EUR<->VTNA at 100/0.01).
--      USD rows are left as they are; the USD figure shown to a member is
--      converted from EUR at the live ECB rate in the app.
--
-- Apply: RUN-MIGRATION.yml (workflow_dispatch). Ship the vitana-v1 change
-- that stops BuyCreditsPopup calling update_user_balance('add') first.
-- =============================================================================

BEGIN;

-- 1. Earned bucket ------------------------------------------------------------
ALTER TABLE public.user_wallets
  ADD COLUMN IF NOT EXISTS earned_balance NUMERIC(15,2) NOT NULL DEFAULT 0;

ALTER TABLE public.user_wallets DROP CONSTRAINT IF EXISTS user_wallets_earned_balance_check;
ALTER TABLE public.user_wallets ADD CONSTRAINT user_wallets_earned_balance_check
  CHECK (
    earned_balance >= 0
    AND earned_balance <= balance
    AND (currency_type = 'CREDITS' OR earned_balance = 0)
  );

COMMENT ON COLUMN public.user_wallets.earned_balance IS
  'VTID-04809: earned VTNA inside the CREDITS balance (rewards). Only reward redemption may lower it; every other debit can only use balance - earned_balance.';

-- 2. Ledger columns -------------------------------------------------------------
ALTER TABLE public.wallet_transactions
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS credit_source TEXT;

ALTER TABLE public.wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_credit_source_check;
ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_transactions_credit_source_check
  CHECK (credit_source IS NULL OR credit_source IN ('earned', 'purchased'));

CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_user_idempotency_key
  ON public.wallet_transactions ((COALESCE(to_user_id, from_user_id)), idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN public.wallet_transactions.idempotency_key IS
  'VTID-04809: caller-supplied source event id; unique per user so a reward or purchase is applied once.';
COMMENT ON COLUMN public.wallet_transactions.credit_source IS
  'VTID-04809: earned | purchased — which CREDITS bucket the row moved.';

-- 3. credit_wallet ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.credit_wallet(
  p_tenant_id        uuid,
  p_user_id          uuid,
  p_amount           integer,
  p_type             text,
  p_source           text,
  p_source_event_id  text,
  p_description      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_earned          boolean;
  v_bucket          text;
  v_wallet          public.user_wallets%ROWTYPE;
  v_bucket_balance  numeric;
  v_tx_id           uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'USER_REQUIRED');
  END IF;
  IF p_amount IS NULL OR p_amount = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT', 'amount', p_amount);
  END IF;

  IF p_type = 'reward' THEN
    v_earned := true;
  ELSIF p_type = 'purchase' THEN
    v_earned := false;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'UNSUPPORTED_TYPE', 'type', p_type);
  END IF;
  v_bucket := CASE WHEN v_earned THEN 'earned' ELSE 'purchased' END;

  INSERT INTO public.user_wallets (user_id, currency_type, balance)
  VALUES (p_user_id, 'CREDITS', 0)
  ON CONFLICT (user_id, currency_type) DO NOTHING;

  -- Row lock serialises every movement on this member's CREDITS wallet, so
  -- the duplicate check below cannot race.
  SELECT * INTO v_wallet
  FROM public.user_wallets
  WHERE user_id = p_user_id AND currency_type = 'CREDITS'
  FOR UPDATE;

  IF p_source_event_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.wallet_transactions
    WHERE COALESCE(to_user_id, from_user_id) = p_user_id
      AND idempotency_key = p_source_event_id
  ) THEN
    RETURN jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'balance', v_wallet.balance,
      'earned_balance', v_wallet.earned_balance,
      'bucket', v_bucket,
      'bucket_balance', CASE WHEN v_earned THEN v_wallet.earned_balance
                             ELSE v_wallet.balance - v_wallet.earned_balance END
    );
  END IF;

  v_bucket_balance := CASE WHEN v_earned THEN v_wallet.earned_balance
                           ELSE v_wallet.balance - v_wallet.earned_balance END;
  IF v_bucket_balance + p_amount < 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'INSUFFICIENT_BALANCE',
      'bucket', v_bucket,
      'bucket_balance', v_bucket_balance
    );
  END IF;

  UPDATE public.user_wallets
  SET balance        = balance + p_amount,
      earned_balance = earned_balance + CASE WHEN v_earned THEN p_amount ELSE 0 END,
      updated_at     = now()
  WHERE id = v_wallet.id
  RETURNING * INTO v_wallet;

  INSERT INTO public.wallet_transactions (
    from_user_id, to_user_id, amount, status, transaction_type,
    from_currency, to_currency, idempotency_key, credit_source, metadata
  ) VALUES (
    CASE WHEN p_amount < 0 THEN p_user_id END,
    CASE WHEN p_amount > 0 THEN p_user_id END,
    abs(p_amount),
    'completed',
    CASE WHEN v_earned THEN 'reward' ELSE 'purchase' END,
    'CREDITS', 'CREDITS',
    p_source_event_id,
    v_bucket,
    jsonb_build_object(
      'source', p_source,
      'description', p_description,
      'tenant_id', p_tenant_id,
      'direction', CASE WHEN p_amount > 0 THEN 'credit' ELSE 'debit' END,
      'ledger', 'vtna',
      'vtid', 'VTID-04809',
      'vitana_system', true
    )
  )
  RETURNING id INTO v_tx_id;

  RETURN jsonb_build_object(
    'ok', true,
    'transaction_id', v_tx_id,
    'amount', p_amount,
    'balance', v_wallet.balance,
    'earned_balance', v_wallet.earned_balance,
    'bucket', v_bucket,
    'bucket_balance', CASE WHEN v_earned THEN v_wallet.earned_balance
                           ELSE v_wallet.balance - v_wallet.earned_balance END
  );
END;
$fn$;

COMMENT ON FUNCTION public.credit_wallet(uuid, uuid, integer, text, text, text, text) IS
  'VTID-04809: idempotent VTNA movement on user_wallets.CREDITS. p_type reward -> earned bucket, purchase -> purchased bucket; negative p_amount debits that bucket. Service role only.';

REVOKE ALL ON FUNCTION public.credit_wallet(uuid, uuid, integer, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_wallet(uuid, uuid, integer, text, text, text, text) TO service_role;

-- 4a. No direct client writes to the ledger tables -----------------------------
DROP POLICY IF EXISTS "Users can update their own wallets" ON public.user_wallets;
DROP POLICY IF EXISTS "Users can create transactions from their account" ON public.wallet_transactions;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.user_wallets FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.wallet_transactions FROM anon, authenticated;

-- 4b. update_user_balance: members may only subtract from their own wallet ------
CREATE OR REPLACE FUNCTION public.update_user_balance(
  user_id_param uuid,
  currency_param text,
  amount_param numeric,
  operation text DEFAULT 'add'::text,
  p_transaction_type text DEFAULT NULL::text,
  p_description text DEFAULT NULL::text
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  new_balance DECIMAL(15,2);
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> user_id_param THEN
    RAISE EXCEPTION 'Not authorized to modify another user''s wallet';
  END IF;

  IF amount_param <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  -- VTID-04809: members can no longer credit their own wallet. Platform
  -- credits go through credit_wallet() (service role) or SECURITY DEFINER
  -- exchange/transfer RPCs.
  IF operation <> 'subtract' THEN
    RAISE EXCEPTION 'Only subtract is allowed; credits are added by the platform';
  END IF;

  INSERT INTO public.user_wallets (user_id, currency_type, balance)
  VALUES (user_id_param, currency_param, 0.00)
  ON CONFLICT (user_id, currency_type) DO NOTHING;

  -- The earned-balance CHECK keeps this from spending earned VTNA.
  UPDATE public.user_wallets
  SET balance = balance - amount_param, updated_at = NOW()
  WHERE user_id = user_id_param AND currency_type = currency_param
    AND balance - earned_balance >= amount_param
  RETURNING balance INTO new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient balance for this operation';
  END IF;

  IF p_transaction_type IS NOT NULL THEN
    INSERT INTO public.wallet_transactions (
      from_user_id, to_user_id, amount, status, transaction_type,
      from_currency, to_currency, credit_source, metadata
    ) VALUES (
      user_id_param, NULL,
      amount_param, 'completed', p_transaction_type,
      currency_param, currency_param,
      CASE WHEN currency_param = 'CREDITS' THEN 'purchased' END,
      jsonb_build_object(
        'description', p_description,
        'operation', operation,
        'vitana_system', true,
        'processed_at', NOW()
      )
    );
  END IF;

  RETURN new_balance;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_user_balance(uuid, text, numeric, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_user_balance(uuid, text, numeric, text, text, text) TO authenticated, service_role;

-- 5. EUR peg ---------------------------------------------------------------------
INSERT INTO public.exchange_rates (from_currency, to_currency, rate, trend, change_24h, is_active)
SELECT v.f, v.t, v.r, 'stable', 0, true
FROM (VALUES
  ('EUR', 'CREDITS', 100::numeric),
  ('CREDITS', 'EUR', 0.01::numeric),
  ('EUR', 'VTNA', 100::numeric),
  ('VTNA', 'EUR', 0.01::numeric)
) AS v(f, t, r)
WHERE NOT EXISTS (
  SELECT 1 FROM public.exchange_rates e
  WHERE e.from_currency = v.f AND e.to_currency = v.t AND e.is_active
);

-- 6. Self-check: roll the whole migration back if any piece is missing ----------
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_wallets_earned_balance_check') THEN
    RAISE EXCEPTION 'VTID-04809: earned_balance check missing';
  END IF;
  IF has_function_privilege('authenticated', 'public.credit_wallet(uuid, uuid, integer, text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-04809: credit_wallet must not be executable by authenticated';
  END IF;
  IF has_table_privilege('authenticated', 'public.user_wallets', 'UPDATE') THEN
    RAISE EXCEPTION 'VTID-04809: authenticated can still UPDATE user_wallets';
  END IF;
  IF has_table_privilege('authenticated', 'public.wallet_transactions', 'INSERT') THEN
    RAISE EXCEPTION 'VTID-04809: authenticated can still INSERT wallet_transactions';
  END IF;
END
$check$;

COMMIT;
