-- =============================================================================
-- VTID-03107 · Billing v1 — Wallet reconciliation (HARD BLOCKER for PR-1)
-- =============================================================================
-- Purpose
--   Split the existing single `wallet_balances.balance` ledger into three
--   semantically-distinct buckets so that earned, purchased, and cash-earning
--   credits cannot be silently converted into expensive features:
--
--     purchased_credits  cash-equivalent (Stripe top-ups, ENTER-code grants,
--                                        refunds, transfers, vtn_convert)
--     reward_credits     engagement reward (diary streaks, milestones,
--                                          referrals); limited burn paths
--     cash_balance       VAEA/hosting payouts (Stripe Connect earnings),
--                                          withdrawable in cents
--
--   `balance` (legacy column) continues to track the SUM of all three buckets
--   so existing read paths keep working without code change.
--
-- Why both `credit_wallet()` RPC AND `update_wallet_balance()` trigger
--   The trigger fires AFTER INSERT on `wallet_transactions`. Direct inserts
--   (bypassing the RPC) must also route to the correct bucket. Replacing only
--   the RPC leaves a real gap.
--
-- Backwards-compatibility
--   `balance` continues to be a valid running total. No existing reader is
--   broken. The new bucket columns default to 0 and are filled forward;
--   one-time backfill assigns the historical `balance` to `purchased_credits`
--   (safest default — most pre-launch state is from Stripe-equivalent flows).
--
-- Verification (embedded at end of file)
--   Synthetic test inserts a reward-typed `wallet_transactions` row WITHOUT
--   going through `credit_wallet()`, then asserts the trigger routed the
--   amount to `reward_credits` (and NOT to `purchased_credits`).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Schema: add the three bucket columns to wallet_balances
-- -----------------------------------------------------------------------------

ALTER TABLE public.wallet_balances
  ADD COLUMN IF NOT EXISTS purchased_credits integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reward_credits    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_balance      integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.wallet_balances.purchased_credits IS
  'VTID-03107: cash-equivalent credits from Stripe top-ups, ENTER-code grants, refunds, transfers. Can burn against any feature.';
COMMENT ON COLUMN public.wallet_balances.reward_credits IS
  'VTID-03107: engagement-earned credits from diary streaks / milestones / referrals. CANNOT burn against Live AI minutes, Room hosting, or subscriptions (cashflow guardrail).';
COMMENT ON COLUMN public.wallet_balances.cash_balance IS
  'VTID-03107: cents-denominated cash earnings (Sell-and-Earn affiliate commissions held by Vitana + Stripe Connect hosting payouts). Withdrawable to bank via Stripe Connect Express.';
COMMENT ON COLUMN public.wallet_balances.balance IS
  'Legacy sum of purchased_credits + reward_credits + cash_balance. Kept for backward compatibility with existing readers; new code should read the specific bucket column.';

-- -----------------------------------------------------------------------------
-- 2. One-time backfill: existing balance → purchased_credits
-- -----------------------------------------------------------------------------
-- All historical balance is treated as purchased (safe default — pre-launch
-- the system has near-zero reward and zero earning rows; routing test pre-prod
-- balances into the most-flexible bucket avoids accidentally restricting
-- legitimate spend paths).
--
-- Idempotent: if migration is re-run (column already 0), no double-credit.
-- The condition `purchased_credits = 0 AND balance > 0` ensures backfill is
-- a one-time operation; subsequent runs are no-ops.

UPDATE public.wallet_balances
SET purchased_credits = balance
WHERE purchased_credits = 0
  AND balance > 0;

-- -----------------------------------------------------------------------------
-- 3. Replace update_wallet_balance() trigger function
-- -----------------------------------------------------------------------------
-- Routes NEW.amount to the bucket determined by NEW.type:
--
--   'reward'                       → reward_credits
--   'earning'                      → cash_balance (NEW type for VTID-03107)
--   'purchase' / 'transfer' /
--   'refund'   / 'vtn_convert' /
--   NULL / unknown                  → purchased_credits (safest default)
--
-- `balance` continues to be the SUM across buckets (legacy read path).
-- `total_earned` / `total_spent` continue to track gross flow regardless of
-- bucket (their existing semantics).

CREATE OR REPLACE FUNCTION public.update_wallet_balance()
RETURNS trigger AS $$
DECLARE
  v_to_purchased integer := 0;
  v_to_reward    integer := 0;
  v_to_cash      integer := 0;
BEGIN
  -- Route the amount to exactly one bucket
  IF NEW.type = 'reward' THEN
    v_to_reward := NEW.amount;
  ELSIF NEW.type = 'earning' THEN
    v_to_cash := NEW.amount;
  ELSE
    -- purchase, transfer, refund, vtn_convert, NULL, or anything else
    v_to_purchased := NEW.amount;
  END IF;

  INSERT INTO public.wallet_balances (
    tenant_id,
    user_id,
    balance,
    total_earned,
    total_spent,
    purchased_credits,
    reward_credits,
    cash_balance,
    updated_at
  )
  VALUES (
    NEW.tenant_id,
    NEW.user_id,
    NEW.amount,
    GREATEST(NEW.amount, 0),
    GREATEST(-NEW.amount, 0),
    v_to_purchased,
    v_to_reward,
    v_to_cash,
    now()
  )
  ON CONFLICT (tenant_id, user_id) DO UPDATE SET
    balance           = public.wallet_balances.balance           + NEW.amount,
    total_earned      = public.wallet_balances.total_earned      + GREATEST(NEW.amount, 0),
    total_spent       = public.wallet_balances.total_spent       + GREATEST(-NEW.amount, 0),
    purchased_credits = public.wallet_balances.purchased_credits + v_to_purchased,
    reward_credits    = public.wallet_balances.reward_credits    + v_to_reward,
    cash_balance      = public.wallet_balances.cash_balance      + v_to_cash,
    updated_at        = now();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.update_wallet_balance() IS
  'VTID-03107: routes wallet_transactions inserts to the correct bucket (purchased_credits / reward_credits / cash_balance) by NEW.type. Maintains `balance` as the legacy total across buckets.';

-- Trigger already exists (trg_wallet_balance_update from 20260318...).
-- The CREATE OR REPLACE FUNCTION above is enough — no need to re-CREATE the
-- trigger itself.

-- -----------------------------------------------------------------------------
-- 4. Replace credit_wallet() RPC
-- -----------------------------------------------------------------------------
-- Now handles 'earning' type. Returns the bucket-specific balance in addition
-- to the legacy 'balance' total so callers can render per-bucket without a
-- second query.
--
-- Insufficient-balance check is per-bucket: a debit of reward_credits cannot
-- pull from purchased_credits, and vice versa. (Debits to a non-existent row
-- still fail with INSUFFICIENT_BALANCE.)

CREATE OR REPLACE FUNCTION public.credit_wallet(
  p_tenant_id        uuid,
  p_user_id          uuid,
  p_amount           integer,
  p_type             text,
  p_source           text,
  p_source_event_id  text,
  p_description      text DEFAULT NULL
)
RETURNS jsonb AS $$
DECLARE
  v_row              public.wallet_balances%ROWTYPE;
  v_bucket_name      text;
  v_current_bucket   integer;
  v_new_bucket       integer;
  v_current_total    integer;
  v_new_total        integer;
  v_tx_id            uuid;
BEGIN
  -- Determine which bucket this transaction targets
  IF p_type = 'reward' THEN
    v_bucket_name := 'reward_credits';
  ELSIF p_type = 'earning' THEN
    v_bucket_name := 'cash_balance';
  ELSE
    v_bucket_name := 'purchased_credits';
  END IF;

  -- Read the user's current row (may not exist yet)
  SELECT * INTO v_row
  FROM public.wallet_balances
  WHERE tenant_id = p_tenant_id AND user_id = p_user_id;

  -- Current bucket value (0 if no row exists)
  IF v_row IS NULL THEN
    v_current_bucket := 0;
    v_current_total  := 0;
  ELSE
    v_current_bucket := CASE v_bucket_name
                          WHEN 'reward_credits'    THEN v_row.reward_credits
                          WHEN 'cash_balance'      THEN v_row.cash_balance
                          ELSE                          v_row.purchased_credits
                        END;
    v_current_total  := v_row.balance;
  END IF;

  v_new_bucket := v_current_bucket + p_amount;
  v_new_total  := v_current_total  + p_amount;

  -- Prevent negative bucket balance for debits (per-bucket isolation)
  IF v_new_bucket < 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'INSUFFICIENT_BALANCE',
      'bucket', v_bucket_name,
      'bucket_balance', v_current_bucket
    );
  END IF;

  -- Insert transaction (idempotent via unique index on source_event_id).
  -- Trigger handles wallet_balances UPSERT.
  INSERT INTO public.wallet_transactions (
    tenant_id, user_id, amount, type, source, source_event_id, description, balance_after
  )
  VALUES (
    p_tenant_id, p_user_id, p_amount, p_type, p_source, p_source_event_id, p_description, v_new_total
  )
  ON CONFLICT (tenant_id, user_id, source_event_id) WHERE source_event_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    -- Already credited (idempotent replay)
    RETURN jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'balance', v_current_total,
      'bucket', v_bucket_name,
      'bucket_balance', v_current_bucket
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'transaction_id', v_tx_id,
    'balance', v_new_total,
    'bucket', v_bucket_name,
    'bucket_balance', v_new_bucket,
    'amount', p_amount
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.credit_wallet IS
  'VTID-03107: idempotent wallet credit/debit. Routes by p_type into purchased_credits / reward_credits / cash_balance. Returns bucket_name + bucket_balance alongside the legacy balance total.';

-- -----------------------------------------------------------------------------
-- 5. Embedded verification: trigger correctness for direct INSERTs
-- -----------------------------------------------------------------------------
-- This block runs at migration time on staging. It inserts a synthetic
-- wallet_transactions row of type='reward' for a sentinel user (deterministic
-- UUID), then asserts the trigger routed the amount to reward_credits and NOT
-- to purchased_credits. The row is rolled back at the end so production state
-- is unchanged.
--
-- Sentinel UUIDs (all-zero except final byte) avoid collision with real users.

DO $$
DECLARE
  v_tenant uuid := '00000000-0000-0000-0000-000000000001';
  v_user   uuid := '00000000-0000-0000-0000-00000000FEED';
  v_event  text := 'vtid-03107-migration-verify-' || gen_random_uuid()::text;
  v_row    public.wallet_balances%ROWTYPE;
BEGIN
  -- Direct insert bypassing credit_wallet() RPC — this is the gap §M called out
  INSERT INTO public.wallet_transactions (
    tenant_id, user_id, amount, type, source, source_event_id, balance_after
  ) VALUES (
    v_tenant, v_user, 100, 'reward', 'vtid-03107-verify', v_event, 100
  );

  -- Trigger should have UPSERTed wallet_balances. Read it back.
  SELECT * INTO v_row
  FROM public.wallet_balances
  WHERE tenant_id = v_tenant AND user_id = v_user;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'VTID-03107 verify: trigger did not insert wallet_balances row';
  END IF;

  IF v_row.reward_credits <> 100 THEN
    RAISE EXCEPTION 'VTID-03107 verify: reward_credits is %, expected 100', v_row.reward_credits;
  END IF;

  IF v_row.purchased_credits <> 0 THEN
    RAISE EXCEPTION 'VTID-03107 verify: purchased_credits is %, expected 0 (type=reward must not touch this bucket)', v_row.purchased_credits;
  END IF;

  IF v_row.cash_balance <> 0 THEN
    RAISE EXCEPTION 'VTID-03107 verify: cash_balance is %, expected 0', v_row.cash_balance;
  END IF;

  IF v_row.balance <> 100 THEN
    RAISE EXCEPTION 'VTID-03107 verify: balance (legacy sum) is %, expected 100', v_row.balance;
  END IF;

  -- Clean up the sentinel row + transaction
  DELETE FROM public.wallet_transactions
   WHERE tenant_id = v_tenant AND user_id = v_user AND source_event_id = v_event;
  DELETE FROM public.wallet_balances
   WHERE tenant_id = v_tenant AND user_id = v_user;

  RAISE NOTICE 'VTID-03107 wallet reconciliation: trigger routes reward → reward_credits ✓';
END $$;

-- Second verification: 'earning' routes to cash_balance
DO $$
DECLARE
  v_tenant uuid := '00000000-0000-0000-0000-000000000001';
  v_user   uuid := '00000000-0000-0000-0000-00000000CA5E';
  v_event  text := 'vtid-03107-migration-verify-earning-' || gen_random_uuid()::text;
  v_row    public.wallet_balances%ROWTYPE;
BEGIN
  INSERT INTO public.wallet_transactions (
    tenant_id, user_id, amount, type, source, source_event_id, balance_after
  ) VALUES (
    v_tenant, v_user, 500, 'earning', 'vtid-03107-verify', v_event, 500
  );

  SELECT * INTO v_row
  FROM public.wallet_balances
  WHERE tenant_id = v_tenant AND user_id = v_user;

  IF v_row.cash_balance <> 500 OR v_row.purchased_credits <> 0 OR v_row.reward_credits <> 0 THEN
    RAISE EXCEPTION 'VTID-03107 verify: earning routing wrong (cash=%, purchased=%, reward=%)',
      v_row.cash_balance, v_row.purchased_credits, v_row.reward_credits;
  END IF;

  DELETE FROM public.wallet_transactions
   WHERE tenant_id = v_tenant AND user_id = v_user AND source_event_id = v_event;
  DELETE FROM public.wallet_balances
   WHERE tenant_id = v_tenant AND user_id = v_user;

  RAISE NOTICE 'VTID-03107 wallet reconciliation: trigger routes earning → cash_balance ✓';
END $$;

-- Third verification: 'purchase' (default path) routes to purchased_credits
DO $$
DECLARE
  v_tenant uuid := '00000000-0000-0000-0000-000000000001';
  v_user   uuid := '00000000-0000-0000-0000-00000000BABE';
  v_event  text := 'vtid-03107-migration-verify-purchase-' || gen_random_uuid()::text;
  v_row    public.wallet_balances%ROWTYPE;
BEGIN
  INSERT INTO public.wallet_transactions (
    tenant_id, user_id, amount, type, source, source_event_id, balance_after
  ) VALUES (
    v_tenant, v_user, 250, 'purchase', 'vtid-03107-verify', v_event, 250
  );

  SELECT * INTO v_row
  FROM public.wallet_balances
  WHERE tenant_id = v_tenant AND user_id = v_user;

  IF v_row.purchased_credits <> 250 OR v_row.reward_credits <> 0 OR v_row.cash_balance <> 0 THEN
    RAISE EXCEPTION 'VTID-03107 verify: purchase routing wrong (purchased=%, reward=%, cash=%)',
      v_row.purchased_credits, v_row.reward_credits, v_row.cash_balance;
  END IF;

  DELETE FROM public.wallet_transactions
   WHERE tenant_id = v_tenant AND user_id = v_user AND source_event_id = v_event;
  DELETE FROM public.wallet_balances
   WHERE tenant_id = v_tenant AND user_id = v_user;

  RAISE NOTICE 'VTID-03107 wallet reconciliation: trigger routes purchase → purchased_credits ✓';
END $$;

-- Final guard: if any of the above blocks raised an exception, the entire
-- migration aborts and the schema is rolled back. Confirming success here.
DO $$ BEGIN
  RAISE NOTICE 'VTID-03107 wallet reconciliation: all three routing paths verified — migration complete.';
END $$;
