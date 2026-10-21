-- =============================================================================
-- VTID-03107 · Billing v1 — Usage-window + credit-burn helper RPCs
-- =============================================================================
-- Two atomic RPCs used by entitlement-service.ts (shipped in PR-2):
--
--   fn_increment_feature_usage   Atomic UPSERT into feature_usage; computes
--                                the current rolling window and bumps `used`.
--                                Returns new `used` + `window_end`.
--
--   fn_consume_credits           Wrapper around credit_wallet() that debits a
--                                specific bucket (purchased_credits or
--                                reward_credits) for paywall PAYG overage.
--                                Maps p_bucket → p_type so the existing
--                                trigger does the routing.
--
-- Both are SECURITY DEFINER so the entitlement service (running as
-- service_role) can call them without RLS friction; the policies on the
-- underlying tables already restrict direct access.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. fn_increment_feature_usage
-- -----------------------------------------------------------------------------
-- Window alignment: calendar / epoch-bucket. For a 30-day (2592000s) window
-- this groups all users into the same window boundaries so the window_end is
-- predictable ("resets on this future timestamp"). Better than per-user-anchored
-- because the entitlement engine can cache window_end across users.
--
-- Atomicity: single INSERT … ON CONFLICT … RETURNING ensures concurrent calls
-- against the same (user, feature, window) increment correctly without races.

CREATE OR REPLACE FUNCTION public.fn_increment_feature_usage(
  p_tenant_id      uuid,
  p_user_id        uuid,
  p_feature_key    text,
  p_amount         integer DEFAULT 1,
  p_window_seconds integer DEFAULT 2592000  -- 30 days
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now             timestamptz := now();
  v_window_start    timestamptz;
  v_window_end      timestamptz;
  v_used            integer;
BEGIN
  IF p_window_seconds < 1 THEN
    RAISE EXCEPTION 'fn_increment_feature_usage: p_window_seconds must be >= 1';
  END IF;

  -- Epoch-bucket alignment: floor to nearest window_seconds boundary
  v_window_start := to_timestamp(
    floor(extract(epoch FROM v_now)::bigint / p_window_seconds) * p_window_seconds
  );
  v_window_end := v_window_start + make_interval(secs => p_window_seconds);

  INSERT INTO public.feature_usage AS fu (
    tenant_id, user_id, feature_key, window_start, window_end, used, updated_at
  ) VALUES (
    p_tenant_id, p_user_id, p_feature_key, v_window_start, v_window_end, p_amount, v_now
  )
  ON CONFLICT (user_id, feature_key, window_start)
  DO UPDATE SET
    used       = fu.used + p_amount,
    updated_at = v_now
  RETURNING used INTO v_used;

  RETURN jsonb_build_object(
    'ok',           true,
    'used',         v_used,
    'window_start', v_window_start,
    'window_end',   v_window_end
  );
END;
$$;

COMMENT ON FUNCTION public.fn_increment_feature_usage IS
  'VTID-03107: atomic feature usage increment. Calendar-aligned rolling window. Returns the post-increment `used` value + window_end.';

GRANT EXECUTE ON FUNCTION public.fn_increment_feature_usage TO service_role, authenticated;

-- -----------------------------------------------------------------------------
-- 2. fn_get_feature_usage  (read-only helper for the entitlement service)
-- -----------------------------------------------------------------------------
-- Returns the user's current `used` value in the current window without
-- incrementing. Used by checkEntitlement() before deciding whether to allow,
-- defer (D36), or paywall.

CREATE OR REPLACE FUNCTION public.fn_get_feature_usage(
  p_tenant_id      uuid,
  p_user_id        uuid,
  p_feature_key    text,
  p_window_seconds integer DEFAULT 2592000
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now            timestamptz := now();
  v_window_start   timestamptz;
  v_window_end     timestamptz;
  v_used           integer;
BEGIN
  v_window_start := to_timestamp(
    floor(extract(epoch FROM v_now)::bigint / p_window_seconds) * p_window_seconds
  );
  v_window_end := v_window_start + make_interval(secs => p_window_seconds);

  SELECT used INTO v_used
  FROM public.feature_usage
  WHERE user_id = p_user_id
    AND feature_key = p_feature_key
    AND window_start = v_window_start;

  RETURN jsonb_build_object(
    'ok',           true,
    'used',         COALESCE(v_used, 0),
    'window_start', v_window_start,
    'window_end',   v_window_end
  );
END;
$$;

COMMENT ON FUNCTION public.fn_get_feature_usage IS
  'VTID-03107: read-only feature usage query. Returns the user current `used` in the current rolling window; 0 if no row exists yet.';

GRANT EXECUTE ON FUNCTION public.fn_get_feature_usage TO service_role, authenticated;

-- -----------------------------------------------------------------------------
-- 3. fn_consume_credits
-- -----------------------------------------------------------------------------
-- Debits the specified bucket for paywall PAYG overage. Wraps the existing
-- credit_wallet() RPC (which routes by p_type → bucket).
--
-- Bucket mapping (mirrors the §M wallet-split semantics):
--   'purchased_credits' → p_type='purchase'   (default; used for voice/rooms/sub overage)
--   'reward_credits'    → p_type='reward'     (allowed for match/lab/photo overage only)
--   'cash_balance'      → REJECTED in v1     (cash earnings are withdrawable to bank
--                                              via Stripe Connect Express, not in-app spend)
--
-- Idempotency via the existing wallet_transactions unique index on
-- (tenant_id, user_id, source_event_id). Replays return ok=true, duplicate=true.

CREATE OR REPLACE FUNCTION public.fn_consume_credits(
  p_tenant_id        uuid,
  p_user_id          uuid,
  p_credits          integer,           -- positive units to debit
  p_bucket           text,              -- 'purchased_credits' | 'reward_credits'
  p_feature_key      text,              -- for audit + source field
  p_idempotency_key  text               -- source_event_id (entitlement-service generates UUID)
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type        text;
  v_source      text;
  v_description text;
  v_result      jsonb;
BEGIN
  IF p_credits <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT', 'credits', p_credits);
  END IF;

  -- Map bucket → wallet_transactions.type (used by credit_wallet + trigger to route)
  IF p_bucket = 'purchased_credits' THEN
    v_type := 'purchase';
  ELSIF p_bucket = 'reward_credits' THEN
    v_type := 'reward';
  ELSIF p_bucket = 'cash_balance' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'BUCKET_NOT_SPENDABLE',
      'message', 'cash_balance is withdrawable to bank via Stripe Connect, not in-app spend (§M)'
    );
  ELSE
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'INVALID_BUCKET',
      'bucket', p_bucket
    );
  END IF;

  v_source      := 'paywall:' || p_feature_key;
  v_description := 'PAYG overage debit for ' || p_feature_key || ' from ' || p_bucket;

  -- credit_wallet() handles per-bucket insufficient-balance check + idempotency
  v_result := public.credit_wallet(
    p_tenant_id       => p_tenant_id,
    p_user_id         => p_user_id,
    p_amount          => -p_credits,    -- NEGATIVE for debit
    p_type            => v_type,
    p_source          => v_source,
    p_source_event_id => p_idempotency_key,
    p_description     => v_description
  );

  -- Pass-through credit_wallet's response (ok / duplicate / INSUFFICIENT_BALANCE)
  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.fn_consume_credits IS
  'VTID-03107: idempotent paywall PAYG debit. Maps p_bucket → wallet_transactions.type so the existing trigger routes the debit to the right column. Rejects cash_balance spends (withdrawable only).';

GRANT EXECUTE ON FUNCTION public.fn_consume_credits TO service_role, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Verification: fn_increment_feature_usage routes to correct window
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_tenant uuid := '00000000-0000-0000-0000-000003107010';
  v_user   uuid := '00000000-0000-0000-0000-000003107011';
  v_result jsonb;
  v_used   integer;
BEGIN
  -- First call: should create the row with used=1
  v_result := public.fn_increment_feature_usage(v_tenant, v_user, 'verify_voice_min', 1, 2592000);
  v_used := (v_result->>'used')::integer;
  IF v_used <> 1 THEN
    RAISE EXCEPTION 'VTID-03107 fn_increment_feature_usage verify: first call returned used=%, expected 1', v_used;
  END IF;

  -- Second call in same window: should increment to used=6
  v_result := public.fn_increment_feature_usage(v_tenant, v_user, 'verify_voice_min', 5, 2592000);
  v_used := (v_result->>'used')::integer;
  IF v_used <> 6 THEN
    RAISE EXCEPTION 'VTID-03107 fn_increment_feature_usage verify: second call returned used=%, expected 6', v_used;
  END IF;

  -- fn_get_feature_usage should return 6 without incrementing
  v_result := public.fn_get_feature_usage(v_tenant, v_user, 'verify_voice_min', 2592000);
  v_used := (v_result->>'used')::integer;
  IF v_used <> 6 THEN
    RAISE EXCEPTION 'VTID-03107 fn_get_feature_usage verify: returned used=%, expected 6', v_used;
  END IF;

  -- Cleanup
  DELETE FROM public.feature_usage
   WHERE tenant_id = v_tenant AND user_id = v_user AND feature_key = 'verify_voice_min';

  RAISE NOTICE 'VTID-03107 fn_increment_feature_usage + fn_get_feature_usage: verified ✓';
END $$;

-- -----------------------------------------------------------------------------
-- 5. Verification: fn_consume_credits rejects cash_balance + invalid bucket
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_tenant uuid := '00000000-0000-0000-0000-000003107020';
  v_user   uuid := '00000000-0000-0000-0000-000003107021';
  v_result jsonb;
BEGIN
  -- Cash bucket should be rejected
  v_result := public.fn_consume_credits(
    v_tenant, v_user, 10, 'cash_balance', 'verify_voice', 'vtid-03107-verify-' || gen_random_uuid()::text
  );
  IF (v_result->>'ok')::boolean OR (v_result->>'error') <> 'BUCKET_NOT_SPENDABLE' THEN
    RAISE EXCEPTION 'VTID-03107 fn_consume_credits verify: cash_balance should be rejected, got %', v_result;
  END IF;

  -- Invalid bucket should be rejected
  v_result := public.fn_consume_credits(
    v_tenant, v_user, 10, 'invalid_bucket', 'verify_voice', 'vtid-03107-verify-' || gen_random_uuid()::text
  );
  IF (v_result->>'ok')::boolean OR (v_result->>'error') <> 'INVALID_BUCKET' THEN
    RAISE EXCEPTION 'VTID-03107 fn_consume_credits verify: invalid_bucket should be rejected, got %', v_result;
  END IF;

  -- Zero/negative amount should be rejected
  v_result := public.fn_consume_credits(
    v_tenant, v_user, 0, 'purchased_credits', 'verify_voice', 'vtid-03107-verify-' || gen_random_uuid()::text
  );
  IF (v_result->>'ok')::boolean OR (v_result->>'error') <> 'INVALID_AMOUNT' THEN
    RAISE EXCEPTION 'VTID-03107 fn_consume_credits verify: zero amount should be rejected, got %', v_result;
  END IF;

  -- Insufficient balance: user has 0 purchased_credits, asking to debit 100
  v_result := public.fn_consume_credits(
    v_tenant, v_user, 100, 'purchased_credits', 'verify_voice', 'vtid-03107-verify-' || gen_random_uuid()::text
  );
  IF (v_result->>'ok')::boolean OR (v_result->>'error') <> 'INSUFFICIENT_BALANCE' THEN
    RAISE EXCEPTION 'VTID-03107 fn_consume_credits verify: insufficient balance check failed, got %', v_result;
  END IF;

  RAISE NOTICE 'VTID-03107 fn_consume_credits: cash-rejection + invalid-bucket + zero-amount + insufficient-balance all verified ✓';
END $$;
