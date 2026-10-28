-- =============================================================================
-- VTID-03107 · Billing v1 — pg_cron cleanup + redemption-grant reconciliation
-- =============================================================================
-- Two daily jobs that keep the billing state tidy:
--
--   billing_feature_usage_prune     Daily 03:00 UTC — deletes feature_usage rows
--                                   older than 7 days past window_end. Keeps the
--                                   table small while preserving recent windows
--                                   for analytics.
--
--   billing_reconcile_grants        Daily 03:10 UTC — flips redemption-grant
--                                   subscriptions whose period has expired back
--                                   to plan_key='free', status='free'. Stripe-
--                                   paid subs are NOT touched here (Stripe
--                                   webhooks own that lifecycle).
--
-- pg_cron schema: cron.schedule(job_name, schedule, command).
-- Idempotency: cron.unschedule is called first to allow re-runs.
-- =============================================================================

-- pg_cron is already installed across the platform (see prior VAEA cron usage).
-- This migration creates schema/extension if absent for safety.

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- -----------------------------------------------------------------------------
-- 1. Cleanup function: feature_usage rows older than 7 days past window_end
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_prune_feature_usage()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  DELETE FROM public.feature_usage
   WHERE window_end < now() - interval '7 days';

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'deleted_rows', v_deleted, 'ran_at', now());
END;
$$;

COMMENT ON FUNCTION public.fn_prune_feature_usage IS
  'VTID-03107: daily prune of feature_usage rows older than 7 days past window_end. Keeps the table size bounded while preserving recent history for analytics.';

GRANT EXECUTE ON FUNCTION public.fn_prune_feature_usage TO service_role;

-- -----------------------------------------------------------------------------
-- 2. Reconciliation function: expired redemption grants → free
-- -----------------------------------------------------------------------------
-- A redemption-grant sub is identified by metadata.source ∈ {'redemption',
-- 'earned'} AND stripe_subscription_id IS NULL. When current_period_end <
-- now(), the user's premium time has elapsed; flip them to free.
--
-- Stripe-paid subs (stripe_subscription_id IS NOT NULL) are never touched by
-- this job — Stripe webhooks own that lifecycle. Mixing the two paths here
-- would risk double-cancellation races.

CREATE OR REPLACE FUNCTION public.fn_reconcile_redemption_grants()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated bigint;
BEGIN
  UPDATE public.user_subscriptions
     SET plan_key             = 'free',
         status               = 'free',
         price_key            = NULL,
         current_period_start = NULL,
         current_period_end   = NULL,
         cancel_at_period_end = false,
         trial_end            = NULL,
         metadata             = COALESCE(metadata, '{}'::jsonb) ||
                                jsonb_build_object(
                                  'reconciled_from', plan_key,
                                  'reconciled_at',   now()
                                ),
         updated_at           = now()
   WHERE stripe_subscription_id IS NULL
     AND current_period_end IS NOT NULL
     AND current_period_end < now()
     AND plan_key <> 'free'
     AND status <> 'free'
     AND (metadata ? 'source')
     AND (metadata->>'source') IN ('redemption', 'earned');

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- Audit: write one paywall_events row per reconciled user
  IF v_updated > 0 THEN
    INSERT INTO public.paywall_events (tenant_id, user_id, feature_key, action, current_plan, context)
    SELECT
      tenant_id,
      user_id,
      'subscription',
      'rejected',                    -- closest existing action enum value (period ended)
      'free',
      jsonb_build_object(
        'reason', 'redemption_grant_expired',
        'previous_plan', metadata->>'reconciled_from',
        'reconciled_at', metadata->>'reconciled_at'
      )
    FROM public.user_subscriptions
    WHERE (metadata->>'reconciled_at')::timestamptz > now() - interval '1 hour';
  END IF;

  RETURN jsonb_build_object('ok', true, 'reconciled_rows', v_updated, 'ran_at', now());
END;
$$;

COMMENT ON FUNCTION public.fn_reconcile_redemption_grants IS
  'VTID-03107: daily reconciliation that flips expired redemption-grant subs (metadata.source ∈ {redemption, earned}) back to free. Never touches Stripe-paid subs.';

GRANT EXECUTE ON FUNCTION public.fn_reconcile_redemption_grants TO service_role;

-- -----------------------------------------------------------------------------
-- 3. Schedule the cron jobs (idempotent — unschedule first)
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_jobid bigint;
BEGIN
  -- Unschedule existing jobs with same names (no-op if absent)
  FOR v_jobid IN
    SELECT jobid FROM cron.job
     WHERE jobname IN ('billing_feature_usage_prune', 'billing_reconcile_grants')
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'billing_feature_usage_prune',
  '0 3 * * *',                         -- daily 03:00 UTC
  $cron_prune$SELECT public.fn_prune_feature_usage();$cron_prune$
);

SELECT cron.schedule(
  'billing_reconcile_grants',
  '10 3 * * *',                        -- daily 03:10 UTC (10 minutes after prune)
  $cron_recon$SELECT public.fn_reconcile_redemption_grants();$cron_recon$
);

-- -----------------------------------------------------------------------------
-- 4. Verification: both cron jobs registered
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM cron.job
  WHERE jobname IN ('billing_feature_usage_prune', 'billing_reconcile_grants');

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'VTID-03107 cron: expected 2 jobs registered, found %', v_count;
  END IF;

  RAISE NOTICE 'VTID-03107 cron: feature_usage prune + redemption grants reconciliation scheduled ✓';
END $$;

-- -----------------------------------------------------------------------------
-- 5. Verification: functions execute on empty data without error
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_prune  jsonb;
  v_recon  jsonb;
BEGIN
  v_prune := public.fn_prune_feature_usage();
  IF NOT (v_prune->>'ok')::boolean THEN
    RAISE EXCEPTION 'VTID-03107: fn_prune_feature_usage returned %', v_prune;
  END IF;

  v_recon := public.fn_reconcile_redemption_grants();
  IF NOT (v_recon->>'ok')::boolean THEN
    RAISE EXCEPTION 'VTID-03107: fn_reconcile_redemption_grants returned %', v_recon;
  END IF;

  RAISE NOTICE 'VTID-03107 cron functions: both executable on empty data ✓ (pruned=%, reconciled=%)',
    v_prune->>'deleted_rows', v_recon->>'reconciled_rows';
END $$;
