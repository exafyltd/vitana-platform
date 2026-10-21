-- =============================================================================
-- VTID-03107 · Billing v1 — OpenClaw compatibility view
-- =============================================================================
-- Purpose
--   The OpenClaw skill at services/openclaw-bridge/src/skills/vitana-stripe.ts
--   queries a `stripe_subscriptions` table that doesn't exist:
--
--     .from('stripe_subscriptions')
--     .select('id, tenant_id, status, last_payment_error')
--     .in('status', ['past_due', 'unpaid'])
--
--   A real table by that name would duplicate user_subscriptions. Instead we
--   ship a view that exposes the same column shape, sourced from the canonical
--   user_subscriptions table. OpenClaw heartbeats continue to work with zero
--   code change.
--
--   The view is filtered to subscriptions that have a real Stripe sub ID —
--   redemption-grant rows (where stripe_subscription_id is NULL) are excluded
--   so OpenClaw never tries to retry-charge a grant.
-- =============================================================================

DROP VIEW IF EXISTS public.stripe_subscriptions;

CREATE VIEW public.stripe_subscriptions AS
SELECT
  stripe_subscription_id  AS id,            -- OpenClaw expects 'id' (Stripe sub id)
  tenant_id,
  status,
  last_payment_error,
  user_id,
  plan_key,
  current_period_start,
  current_period_end,
  cancel_at_period_end,
  trial_end,
  stripe_customer_id,
  metadata,
  created_at,
  updated_at
FROM public.user_subscriptions
WHERE stripe_subscription_id IS NOT NULL;

COMMENT ON VIEW public.stripe_subscriptions IS
  'VTID-03107: compatibility view for the OpenClaw vitana-stripe skill and any other consumer expecting a `stripe_subscriptions` table. Sourced from user_subscriptions; excludes grant-based rows (no stripe_subscription_id).';

GRANT SELECT ON public.stripe_subscriptions TO authenticated, service_role, anon;
