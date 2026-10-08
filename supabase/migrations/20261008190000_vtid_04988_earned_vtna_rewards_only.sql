-- =============================================================================
-- VTID-04988 — earned VTNA is spent only on rewards
-- -----------------------------------------------------------------------------
-- Owner decision 2026-10-08 ("rewards only"), confirming BUSINESS-MODEL.md §11
-- item 6: earned VTNA (the reward_credits bucket, user_wallets.earned_balance)
-- is spent only by rewards — the Rewards shop and Premium conversion. Paywall
-- overage (match posts/reveals, lab analyses, photo uploads) is paid from
-- purchased credits only.
--
-- 1. feature_entitlements: reward_credits leaves allowed_burn_buckets (16 rows:
--    4 features x 4 plans, seeded by VTID-03107). This migration must run after
--    that seed, whose ON CONFLICT DO UPDATE would restore the bucket if it were
--    re-run; migration timestamps guarantee the order.
-- 2. fn_consume_credits: the VTID-03107 body unchanged except that
--    'reward_credits' is refused (BUCKET_NOT_SPENDABLE, nothing written), like
--    'cash_balance'. Grants stay as VTID-04981 set them: service_role only.
--
-- Read-only check 2026-10-08: no paywall debit has ever touched earned VTNA
-- (0 wallet_transactions with metadata.source 'paywall:%').
-- =============================================================================

BEGIN;

UPDATE public.feature_entitlements
   SET allowed_burn_buckets = array_remove(allowed_burn_buckets, 'reward_credits')
 WHERE 'reward_credits' = ANY (allowed_burn_buckets);

CREATE OR REPLACE FUNCTION public.fn_consume_credits(
  p_tenant_id        uuid,
  p_user_id          uuid,
  p_credits          integer,           -- positive units to debit
  p_bucket           text,              -- 'purchased_credits' (reward_credits refused, VTID-04988)
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
    -- VTID-04988: earned VTNA is spent only on rewards (shop, Premium conversion).
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'BUCKET_NOT_SPENDABLE',
      'message', 'earned VTNA is spent only on rewards'
    );
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

REVOKE ALL ON FUNCTION public.fn_consume_credits(uuid, uuid, integer, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_consume_credits(uuid, uuid, integer, text, text, text) TO service_role;

DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_entitlements WHERE 'reward_credits' = ANY (allowed_burn_buckets)) THEN
    RAISE EXCEPTION 'VTID-04988: a feature still allows spending earned VTNA';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_consume_credits(uuid, uuid, integer, text, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_consume_credits(uuid, uuid, integer, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-04988: fn_consume_credits must not be executable by members';
  END IF;
END
$check$;

COMMIT;
