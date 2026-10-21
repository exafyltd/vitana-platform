/**
 * Vitana Wallet — Spend + Earning RPCs (cart / marketplace contract)
 *
 * VTID: VTID-03249
 *
 * Adds the two backend chokepoints the universal cart + Vitanaland Marketplace
 * services call when money moves through the wallet:
 *
 *   debit_wallet_for_spend  — buyer pays for cart checkout or marketplace order
 *   credit_wallet_for_earning — seller/creator receives marketplace earning
 *
 * Both follow the same transactional pattern as credit_deposit() (VTID-03200):
 *   SELECT FOR UPDATE → ledger insert (UNIQUE makes it idempotent) → balance
 *   update → return jsonb. Single transaction, fails atomically on any step.
 *
 * Schema delta:
 *   - wallet_ledger_entries.entry_type CHECK gains 'earning_credit'
 *
 * Currency: passed in by caller; must match the account's currency or RPC
 * returns CURRENCY_MISMATCH (no implicit FX).
 *
 * Idempotency: caller picks reference_type + reference_id (e.g. cart_order_id,
 * marketplace_order_id). Same (reference_type, reference_id, entry_type) → no
 * duplicate write — caller is told duplicate:true with the current balance so
 * retries are safe.
 */

-- ============================================================================
-- 1. Expand entry_type to include 'earning_credit'
-- ============================================================================
-- Postgres can't ALTER a CHECK constraint in place; drop + recreate.
ALTER TABLE public.wallet_ledger_entries
  DROP CONSTRAINT IF EXISTS wallet_ledger_entries_entry_type_check;

ALTER TABLE public.wallet_ledger_entries
  ADD CONSTRAINT wallet_ledger_entries_entry_type_check
  CHECK (entry_type IN (
    'deposit_completed',
    'service_spend',
    'earning_credit',
    'manual_adjustment',
    'refund_debit'
  ));

-- ============================================================================
-- 2. RPC: debit_wallet_for_spend — cart checkout, marketplace purchase
-- ============================================================================
CREATE OR REPLACE FUNCTION debit_wallet_for_spend(
  p_account_id     uuid,
  p_amount_minor   bigint,
  p_currency       text,
  p_reference_type text,
  p_reference_id   text,
  p_description    text DEFAULT NULL,
  p_metadata       jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb AS $$
DECLARE
  v_account  wallet_accounts%ROWTYPE;
  v_balance  bigint;
  v_entry_id uuid;
BEGIN
  -- Input validation
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT');
  END IF;
  IF p_currency NOT IN ('EUR', 'USD') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_CURRENCY');
  END IF;
  IF p_reference_type IS NULL OR p_reference_id IS NULL
     OR length(p_reference_type) = 0 OR length(p_reference_id) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_REFERENCE');
  END IF;

  -- Lock account row to serialize concurrent debits
  SELECT * INTO v_account
    FROM wallet_accounts
    WHERE id = p_account_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ACCOUNT_NOT_FOUND');
  END IF;

  IF v_account.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ACCOUNT_NOT_ACTIVE', 'status', v_account.status);
  END IF;

  IF v_account.currency <> p_currency THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'CURRENCY_MISMATCH',
      'account_currency', v_account.currency,
      'requested_currency', p_currency
    );
  END IF;

  -- Check sufficient balance BEFORE the UPDATE so we return a friendly error
  -- rather than a CHECK-constraint violation surfacing as a generic SQL error.
  IF v_account.balance_minor < p_amount_minor THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'INSUFFICIENT_BALANCE',
      'balance_minor', v_account.balance_minor,
      'required_minor', p_amount_minor,
      'currency', v_account.currency
    );
  END IF;

  -- Append ledger entry. UNIQUE(reference_type, reference_id, entry_type) is
  -- the structural guard against double-debiting a single business event.
  INSERT INTO wallet_ledger_entries (
    account_id, user_id, entry_type, direction,
    amount_minor, currency,
    reference_type, reference_id, description, metadata
  ) VALUES (
    v_account.id, v_account.user_id, 'service_spend', 'debit',
    p_amount_minor, v_account.currency,
    p_reference_type, p_reference_id, p_description, COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_entry_id;

  -- Update cached balance
  UPDATE wallet_accounts
     SET balance_minor = balance_minor - p_amount_minor,
         updated_at    = now()
   WHERE id = v_account.id
   RETURNING balance_minor INTO v_balance;

  RETURN jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'ledger_entry_id', v_entry_id,
    'balance_minor', v_balance,
    'currency', v_account.currency
  );

EXCEPTION WHEN unique_violation THEN
  -- Replay of the same business event. Report current balance as success
  -- so the caller's retry loop terminates cleanly.
  SELECT balance_minor INTO v_balance
    FROM wallet_accounts WHERE id = p_account_id;
  RETURN jsonb_build_object(
    'ok', true,
    'duplicate', true,
    'balance_minor', v_balance,
    'currency', (SELECT currency FROM wallet_accounts WHERE id = p_account_id)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- 3. RPC: credit_wallet_for_earning — marketplace sale earning to seller
-- ============================================================================
CREATE OR REPLACE FUNCTION credit_wallet_for_earning(
  p_account_id     uuid,
  p_amount_minor   bigint,
  p_currency       text,
  p_reference_type text,
  p_reference_id   text,
  p_description    text DEFAULT NULL,
  p_metadata       jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb AS $$
DECLARE
  v_account  wallet_accounts%ROWTYPE;
  v_balance  bigint;
  v_entry_id uuid;
BEGIN
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT');
  END IF;
  IF p_currency NOT IN ('EUR', 'USD') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_CURRENCY');
  END IF;
  IF p_reference_type IS NULL OR p_reference_id IS NULL
     OR length(p_reference_type) = 0 OR length(p_reference_id) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_REFERENCE');
  END IF;

  SELECT * INTO v_account
    FROM wallet_accounts
    WHERE id = p_account_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ACCOUNT_NOT_FOUND');
  END IF;

  IF v_account.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ACCOUNT_NOT_ACTIVE', 'status', v_account.status);
  END IF;

  IF v_account.currency <> p_currency THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'CURRENCY_MISMATCH',
      'account_currency', v_account.currency,
      'requested_currency', p_currency
    );
  END IF;

  INSERT INTO wallet_ledger_entries (
    account_id, user_id, entry_type, direction,
    amount_minor, currency,
    reference_type, reference_id, description, metadata
  ) VALUES (
    v_account.id, v_account.user_id, 'earning_credit', 'credit',
    p_amount_minor, v_account.currency,
    p_reference_type, p_reference_id, p_description, COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_entry_id;

  UPDATE wallet_accounts
     SET balance_minor = balance_minor + p_amount_minor,
         updated_at    = now()
   WHERE id = v_account.id
   RETURNING balance_minor INTO v_balance;

  RETURN jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'ledger_entry_id', v_entry_id,
    'balance_minor', v_balance,
    'currency', v_account.currency
  );

EXCEPTION WHEN unique_violation THEN
  SELECT balance_minor INTO v_balance
    FROM wallet_accounts WHERE id = p_account_id;
  RETURN jsonb_build_object(
    'ok', true,
    'duplicate', true,
    'balance_minor', v_balance,
    'currency', (SELECT currency FROM wallet_accounts WHERE id = p_account_id)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
