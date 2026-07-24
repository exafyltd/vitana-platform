-- impact-allow-solo-migration: modifies an existing SECURITY DEFINER function
-- called only from the gateway's wallet webhook handler (already-shipped code,
-- no route/signature change) plus a same-PR frontend rewire in vitana-v1; no
-- gateway/worker TypeScript change is needed to pair with this DB-side edit.
--
-- Bridge real Stripe wallet deposits into the legacy user_wallets balance.
--
-- The wallet UI (vitana-v1 useWallet.ts) reads USD balance from user_wallets,
-- not from the newer wallet_accounts/wallet_ledger_entries rail that the real
-- Stripe checkout flow (createDeposit/credit_deposit) actually credits. Add
-- Funds is being wired to trigger a real Stripe Checkout Session via that
-- existing, working flow; without this bridge, a successful real payment
-- would land in wallet_accounts and never appear in the balance the user
-- actually sees.
--
-- This mirrors USD deposits only (the currency the legacy wallet stores) into
-- user_wallets, atomically, inside the same row-locked transaction as the
-- wallet_accounts credit -- not as a second call from application code. EUR
-- deposits are left as wallet_accounts-only for now (no EUR concept in the
-- legacy table); the frontend always requests USD for Add Funds.
--
-- Full consolidation onto a single wallet system remains separate follow-up
-- work (see DATABASE_SCHEMA.md "Wallet System" section).

CREATE OR REPLACE FUNCTION public.credit_deposit(p_deposit_id uuid, p_stripe_event_id text, p_stripe_pi_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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

  -- Bridge: mirror USD deposits into the legacy user_wallets balance that the
  -- wallet UI actually reads. Same transaction as the credit above.
  IF v_deposit.currency = 'USD' THEN
    INSERT INTO user_wallets (user_id, currency_type, balance)
    VALUES (v_deposit.user_id, 'USD', v_deposit.amount_minor / 100.0)
    ON CONFLICT (user_id, currency_type)
    DO UPDATE SET balance = user_wallets.balance + EXCLUDED.balance,
                  updated_at = now();
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'balance_minor', v_balance,
    'currency', v_deposit.currency
  );

EXCEPTION WHEN unique_violation THEN
  -- Race: another worker beat us to the ledger insert. Report current balance
  -- as success -- the deposit IS credited, just not by us.
  SELECT balance_minor INTO v_balance
    FROM wallet_accounts WHERE id = v_deposit.account_id;
  RETURN jsonb_build_object(
    'ok', true,
    'duplicate', true,
    'balance_minor', v_balance,
    'currency', v_deposit.currency
  );
END;
$function$;
