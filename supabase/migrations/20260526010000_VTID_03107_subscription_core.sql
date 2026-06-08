-- =============================================================================
-- VTID-03107 · Billing v1 — Subscription core schema
-- =============================================================================
-- Six tables that together form the billing v1 state model:
--
--   subscription_plans     config · one row per published plan (Free / Premium /
--                                   Host / Community), one source of truth for
--                                   price + Stripe IDs + capability JSON
--   user_subscriptions     state  · per-user current sub (plan_key, status,
--                                   Stripe customer/sub IDs, period bounds)
--   feature_entitlements   config · per (plan, feature) → quota + window +
--                                   behavior_on_exceed + allowed burn buckets
--   feature_usage          state  · per (user, feature, window) → counter
--   credit_packs           config · one-shot Stripe Checkout SKUs
--   paywall_events         analytics · funnel events for telemetry dashboard
--
-- Naming
--   Internal plan_keys: 'free', 'premium', 'premium_5x', 'premium_20x'
--   Customer-facing names ('Premium', 'Host', 'Community') live in i18n
--   shards and the §O copy table — never in the DB.
--
-- RLS
--   subscription_plans / feature_entitlements / credit_packs → world-readable
--     (config tables, not user data)
--   user_subscriptions / feature_usage / paywall_events → user reads own only
--   All tables → service_role full access
--
-- Compatibility
--   This migration adds no foreign key to wallet_balances; the entitlement
--   service joins by tenant_id + user_id at query time. See §M wallet
--   reconciliation (20260526000000) — that lands first as the hard blocker.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. subscription_plans  (one row per tier)
-- -----------------------------------------------------------------------------
-- Four tiers: free, premium, premium_5x, premium_20x. Price + Stripe Price IDs
-- are NOT here — they live in subscription_plan_prices (2 prices per paid tier).
-- This separation lets the entitlement engine key off plan_key (tier) without
-- duplicating quota rows for monthly vs annual.

CREATE TABLE IF NOT EXISTS public.subscription_plans (
  plan_key             text PRIMARY KEY,
  display_name         text NOT NULL,                  -- internal label; user-facing label is i18n-driven
  stripe_product_id    text,                            -- Stripe Product (one per tier)
  trial_days           integer NOT NULL DEFAULT 0,      -- 14 for paid tiers, 0 for free
  features_json        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- storage_mb, sell_and_earn_*, etc. (see migration 8)
  sort_order           integer NOT NULL DEFAULT 0,
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.subscription_plans IS
  'VTID-03107: catalog of subscription tiers (free / premium / premium_5x / premium_20x). plan_key is the canonical internal identifier; display_name + i18n strings provide customer-facing labels. Pricing variants live in subscription_plan_prices.';
COMMENT ON COLUMN public.subscription_plans.features_json IS
  'Per-tier capability config (storage_mb, sell_and_earn_catalog_size, etc.). Seeded by migration 20260526070000.';

-- -----------------------------------------------------------------------------
-- 1b. subscription_plan_prices  (one row per (tier, interval) variant)
-- -----------------------------------------------------------------------------
-- 6 rows expected: premium×{month, year}, premium_5x×{month, year}, premium_20x×{month, year}.
-- Free has no price row (the application defaults to "free" with no Stripe binding).
-- Adding a quarterly tier or a regional price later is just an INSERT here.

CREATE TABLE IF NOT EXISTS public.subscription_plan_prices (
  price_key            text PRIMARY KEY,                              -- e.g. 'premium_monthly', 'premium_annual'
  plan_key             text NOT NULL REFERENCES public.subscription_plans(plan_key) ON DELETE CASCADE,
  billing_interval     text NOT NULL CHECK (billing_interval IN ('month','year')),
  price_cents          integer NOT NULL CHECK (price_cents > 0),
  currency             text NOT NULL DEFAULT 'eur',
  stripe_price_id      text UNIQUE,                                   -- filled by ops via SQL UPDATE
  is_active            boolean NOT NULL DEFAULT true,
  sort_order           integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_key, billing_interval)
);

CREATE INDEX IF NOT EXISTS idx_subscription_plan_prices_plan
  ON public.subscription_plan_prices (plan_key);

COMMENT ON TABLE public.subscription_plan_prices IS
  'VTID-03107: Stripe Price variants per plan tier (monthly + annual). One Stripe Price ID per row. Filled by ops via SQL UPDATE after Dashboard creation.';

-- -----------------------------------------------------------------------------
-- 2. user_subscriptions
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.user_subscriptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL,
  user_id                 uuid NOT NULL,
  plan_key                text NOT NULL REFERENCES public.subscription_plans(plan_key),         -- tier
  price_key               text REFERENCES public.subscription_plan_prices(price_key),           -- variant (NULL for grants)
  status                  text NOT NULL CHECK (status IN (
                            'trialing',
                            'active',
                            'past_due',
                            'unpaid',
                            'canceled',
                            'incomplete',
                            'incomplete_expired',
                            'paused',
                            'free'
                          )),
  stripe_customer_id      text,
  stripe_subscription_id  text UNIQUE,
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean NOT NULL DEFAULT false,
  trial_end               timestamptz,
  last_payment_error      text,
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status
  ON public.user_subscriptions (status);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_period_end
  ON public.user_subscriptions (current_period_end)
  WHERE status IN ('active','trialing','past_due');
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_stripe_customer
  ON public.user_subscriptions (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

COMMENT ON TABLE public.user_subscriptions IS
  'VTID-03107: per-user subscription state. metadata.source ∈ {stripe, redemption, earned} distinguishes Stripe-paid from grant-based subs.';
COMMENT ON COLUMN public.user_subscriptions.stripe_subscription_id IS
  'NULL for grant-based subs (ENTER codes, Founding promo, future referral). Only Stripe-paid subs have a real Stripe sub ID.';

-- -----------------------------------------------------------------------------
-- 3. feature_entitlements
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.feature_entitlements (
  plan_key             text NOT NULL REFERENCES public.subscription_plans(plan_key) ON DELETE CASCADE,
  feature_key          text NOT NULL,
  quota                integer NOT NULL,                          -- finite number; no -1, no "unlimited"
  window_seconds       integer NOT NULL DEFAULT 2592000,          -- default 30 days
  unit                 text NOT NULL DEFAULT 'count'              -- 'count' | 'minutes' | 'bytes'
                         CHECK (unit IN ('count','minutes','bytes')),
  behavior_on_exceed   text NOT NULL DEFAULT 'paywall'
                         CHECK (behavior_on_exceed IN ('paywall','degrade','hard_block','soft_counter')),
  credit_cost_per_unit integer NOT NULL DEFAULT 0,                -- PAYG burn rate; 0 = pay-with-credits not allowed
  allowed_burn_buckets text[] NOT NULL DEFAULT ARRAY['purchased_credits']::text[],
                                                                  -- which wallet buckets can fund overage
  PRIMARY KEY (plan_key, feature_key)
);

COMMENT ON TABLE public.feature_entitlements IS
  'VTID-03107: per-plan, per-feature quotas + behavior on exceed. Single SQL UPDATE retunes any value without a deploy.';
COMMENT ON COLUMN public.feature_entitlements.quota IS
  'Finite number, e.g. 15 (Free voice min/month) or 1200 (Community voice min/month). Cashflow guardrail §N #1 forbids -1/unlimited.';
COMMENT ON COLUMN public.feature_entitlements.behavior_on_exceed IS
  'paywall: return 402 · degrade: handler chooses fallback (voice → Standard mode) · hard_block: 402 with no PAYG · soft_counter: UI shows counter but route returns 200.';
COMMENT ON COLUMN public.feature_entitlements.allowed_burn_buckets IS
  'Wallet bucket(s) that can pay PAYG overage. Voice/Rooms: {purchased_credits} only. Match/photo/lab: {purchased_credits, reward_credits}. Subscription discount: never (out of launch scope).';

-- -----------------------------------------------------------------------------
-- 4. feature_usage
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.feature_usage (
  tenant_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  feature_key   text NOT NULL,
  window_start  timestamptz NOT NULL,
  window_end    timestamptz NOT NULL,
  used          integer NOT NULL DEFAULT 0,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feature_key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_feature_usage_window_end
  ON public.feature_usage (window_end);
CREATE INDEX IF NOT EXISTS idx_feature_usage_tenant
  ON public.feature_usage (tenant_id);

COMMENT ON TABLE public.feature_usage IS
  'VTID-03107: per-user, per-feature, per-window usage counter. window_start is the rolling window anchor; fn_increment_feature_usage (migration 20260526040000) does the atomic UPSERT.';

-- -----------------------------------------------------------------------------
-- 5. credit_packs
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.credit_packs (
  pack_key         text PRIMARY KEY,
  display_name     text NOT NULL,
  credits          integer NOT NULL CHECK (credits > 0),
  bonus_credits    integer NOT NULL DEFAULT 0 CHECK (bonus_credits >= 0),
  price_cents      integer NOT NULL CHECK (price_cents > 0),
  currency         text NOT NULL DEFAULT 'eur',
  stripe_product_id text,
  stripe_price_id  text UNIQUE,
  is_active        boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.credit_packs IS
  'VTID-03107: one-shot credit pack SKUs sold via Stripe Checkout payment mode. Inserted credits land in wallet_balances.purchased_credits.';

-- -----------------------------------------------------------------------------
-- 6. paywall_events
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.paywall_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  feature_key   text NOT NULL,
  action        text NOT NULL CHECK (action IN (
                  'shown',
                  'upgraded',
                  'rejected',
                  'credit_paid',
                  'deferred_for_vulnerability',
                  'degraded',
                  'redeemed',
                  'soft_counter_reached'
                )),
  current_plan  text,
  context       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_paywall_events_user_time
  ON public.paywall_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paywall_events_feature_time
  ON public.paywall_events (feature_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paywall_events_action
  ON public.paywall_events (action, created_at DESC);

COMMENT ON TABLE public.paywall_events IS
  'VTID-03107: funnel analytics for the Command Hub billing dashboard. Each paywall touch (shown, upgraded, credit_paid, deferred, etc.) writes one row.';

-- -----------------------------------------------------------------------------
-- 7. processed_stripe_events (webhook idempotency)
-- -----------------------------------------------------------------------------
-- Mirrors the existing Connect-webhook idempotency pattern. PR-2's customer-side
-- Stripe webhook inserts the event.id before processing; PK conflict = skip.

CREATE TABLE IF NOT EXISTS public.processed_stripe_events (
  event_id     text PRIMARY KEY,                         -- Stripe's event.id (evt_xxx)
  event_type   text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_processed_stripe_events_type_time
  ON public.processed_stripe_events (event_type, processed_at DESC);

COMMENT ON TABLE public.processed_stripe_events IS
  'VTID-03107: Stripe webhook idempotency log. Insert event.id before processing; PK conflict = already handled, skip.';

-- =============================================================================
-- updated_at triggers (shared helper)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.billing_bump_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_subscription_plans_updated        ON public.subscription_plans;
DROP TRIGGER IF EXISTS trg_subscription_plan_prices_updated  ON public.subscription_plan_prices;
DROP TRIGGER IF EXISTS trg_user_subscriptions_updated        ON public.user_subscriptions;
DROP TRIGGER IF EXISTS trg_credit_packs_updated              ON public.credit_packs;
DROP TRIGGER IF EXISTS trg_feature_usage_updated             ON public.feature_usage;

CREATE TRIGGER trg_subscription_plans_updated
  BEFORE UPDATE ON public.subscription_plans
  FOR EACH ROW EXECUTE FUNCTION public.billing_bump_updated_at();

CREATE TRIGGER trg_subscription_plan_prices_updated
  BEFORE UPDATE ON public.subscription_plan_prices
  FOR EACH ROW EXECUTE FUNCTION public.billing_bump_updated_at();

CREATE TRIGGER trg_user_subscriptions_updated
  BEFORE UPDATE ON public.user_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.billing_bump_updated_at();

CREATE TRIGGER trg_credit_packs_updated
  BEFORE UPDATE ON public.credit_packs
  FOR EACH ROW EXECUTE FUNCTION public.billing_bump_updated_at();

CREATE TRIGGER trg_feature_usage_updated
  BEFORE UPDATE ON public.feature_usage
  FOR EACH ROW EXECUTE FUNCTION public.billing_bump_updated_at();

-- =============================================================================
-- Row-Level Security
-- =============================================================================

-- subscription_plans: world-readable config (no user PII), service_role writes
ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscription_plans_read_all   ON public.subscription_plans;
DROP POLICY IF EXISTS subscription_plans_svc_full   ON public.subscription_plans;
CREATE POLICY subscription_plans_read_all ON public.subscription_plans
  FOR SELECT TO authenticated, anon
  USING (is_active = true);
CREATE POLICY subscription_plans_svc_full ON public.subscription_plans
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- subscription_plan_prices: world-readable active variants, service_role writes
ALTER TABLE public.subscription_plan_prices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscription_plan_prices_read_all ON public.subscription_plan_prices;
DROP POLICY IF EXISTS subscription_plan_prices_svc_full ON public.subscription_plan_prices;
CREATE POLICY subscription_plan_prices_read_all ON public.subscription_plan_prices
  FOR SELECT TO authenticated, anon
  USING (is_active = true);
CREATE POLICY subscription_plan_prices_svc_full ON public.subscription_plan_prices
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- feature_entitlements: world-readable, service_role writes
ALTER TABLE public.feature_entitlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS feature_entitlements_read_all ON public.feature_entitlements;
DROP POLICY IF EXISTS feature_entitlements_svc_full ON public.feature_entitlements;
CREATE POLICY feature_entitlements_read_all ON public.feature_entitlements
  FOR SELECT TO authenticated, anon
  USING (true);
CREATE POLICY feature_entitlements_svc_full ON public.feature_entitlements
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- credit_packs: world-readable (active SKUs only), service_role writes
ALTER TABLE public.credit_packs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credit_packs_read_active ON public.credit_packs;
DROP POLICY IF EXISTS credit_packs_svc_full    ON public.credit_packs;
CREATE POLICY credit_packs_read_active ON public.credit_packs
  FOR SELECT TO authenticated, anon
  USING (is_active = true);
CREATE POLICY credit_packs_svc_full ON public.credit_packs
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- user_subscriptions: user reads own only, service_role writes
ALTER TABLE public.user_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_subscriptions_read_own ON public.user_subscriptions;
DROP POLICY IF EXISTS user_subscriptions_svc_full ON public.user_subscriptions;
CREATE POLICY user_subscriptions_read_own ON public.user_subscriptions
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY user_subscriptions_svc_full ON public.user_subscriptions
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- feature_usage: user reads own only, service_role writes
ALTER TABLE public.feature_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS feature_usage_read_own ON public.feature_usage;
DROP POLICY IF EXISTS feature_usage_svc_full ON public.feature_usage;
CREATE POLICY feature_usage_read_own ON public.feature_usage
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY feature_usage_svc_full ON public.feature_usage
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- paywall_events: user reads own (for transparency), service_role writes
ALTER TABLE public.paywall_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS paywall_events_read_own ON public.paywall_events;
DROP POLICY IF EXISTS paywall_events_svc_full ON public.paywall_events;
CREATE POLICY paywall_events_read_own ON public.paywall_events
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY paywall_events_svc_full ON public.paywall_events
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- processed_stripe_events: service_role only (internal log)
ALTER TABLE public.processed_stripe_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS processed_stripe_events_svc_full ON public.processed_stripe_events;
CREATE POLICY processed_stripe_events_svc_full ON public.processed_stripe_events
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- =============================================================================
-- Grants
-- =============================================================================

GRANT SELECT ON public.subscription_plans         TO authenticated, anon;
GRANT SELECT ON public.subscription_plan_prices   TO authenticated, anon;
GRANT SELECT ON public.feature_entitlements       TO authenticated, anon;
GRANT SELECT ON public.credit_packs               TO authenticated, anon;
GRANT SELECT ON public.user_subscriptions    TO authenticated;
GRANT SELECT ON public.feature_usage         TO authenticated;
GRANT SELECT ON public.paywall_events        TO authenticated;

-- Service role gets full access via RLS bypass (default); no explicit grant
-- needed but listed here for documentation:
--   GRANT ALL ON public.* TO service_role;
