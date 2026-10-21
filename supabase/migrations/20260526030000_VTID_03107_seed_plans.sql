-- =============================================================================
-- VTID-03107 · Billing v1 — Seed plans, prices, credit packs, entitlements
-- =============================================================================
-- Populates the four core config tables with the launch-day catalog:
--
--   subscription_plans          4 rows (free, premium, premium_5x, premium_20x)
--   subscription_plan_prices    6 rows (3 paid tiers × 2 intervals)
--   credit_packs                3 rows (starter, boost, power)
--   feature_entitlements        24 rows (4 plans × 6 metered features)
--
-- All Stripe Price IDs left NULL — ops fills them via SQL UPDATE after the
-- Stripe Dashboard sweep:
--   1. Create 4 Stripe Products (Premium, Host, Community, Credit-Pack)
--   2. Create 9 Stripe Prices (Premium m+y, Host m+y, Community m+y, 3 credit packs)
--   3. UPDATE subscription_plans SET stripe_product_id='prod_…' WHERE plan_key='…';
--   4. UPDATE subscription_plan_prices SET stripe_price_id='price_…' WHERE price_key='…';
--   5. UPDATE credit_packs SET stripe_price_id='price_…', stripe_product_id='prod_…' WHERE pack_key='…';
--
-- Naming
--   plan_key  → internal engineering identifier (free, premium, premium_5x, premium_20x)
--   display_name → engineer-readable label (NOT shown in UI; UI uses i18n)
--   i18n customer-facing names map per §O: Free, Premium, Host, Community
--
-- Cashflow guardrail
--   Every quota is a finite integer — no -1, no "unlimited" semantics.
--   Premium 5× / Premium 20× quotas are 5×/20× the Premium baseline.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. subscription_plans — 4 tier rows
-- -----------------------------------------------------------------------------

INSERT INTO public.subscription_plans (
  plan_key, display_name, stripe_product_id, trial_days, features_json, sort_order, is_active
) VALUES
  ('free',         'Free',                     NULL,  0,  '{}'::jsonb, 10, true),
  ('premium',      'Premium',                  NULL, 14,  '{}'::jsonb, 20, true),
  ('premium_5x',   'Premium 5x (Host)',        NULL, 14,  '{}'::jsonb, 30, true),
  ('premium_20x',  'Premium 20x (Community)',  NULL, 14,  '{}'::jsonb, 40, true)
ON CONFLICT (plan_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  trial_days   = EXCLUDED.trial_days,
  sort_order   = EXCLUDED.sort_order,
  is_active    = EXCLUDED.is_active,
  updated_at   = now();

-- features_json is intentionally empty here. Migration 8 (20260526070000)
-- seeds storage_mb + Sell-and-Earn capability config per tier.

-- -----------------------------------------------------------------------------
-- 2. subscription_plan_prices — 6 variant rows (3 paid tiers × 2 intervals)
-- -----------------------------------------------------------------------------

INSERT INTO public.subscription_plan_prices (
  price_key, plan_key, billing_interval, price_cents, currency, stripe_price_id, is_active, sort_order
) VALUES
  -- Premium: €9.99/mo · €89/yr (save ~26%)
  ('premium_monthly',     'premium',      'month',    999, 'eur', NULL, true, 10),
  ('premium_annual',      'premium',      'year',    8900, 'eur', NULL, true, 20),

  -- Premium 5× / Host: €99/mo · €890/yr (save ~25%) — 10× the Premium price for 5× the quota
  ('premium_5x_monthly',  'premium_5x',   'month',   9900, 'eur', NULL, true, 30),
  ('premium_5x_annual',   'premium_5x',   'year',   89000, 'eur', NULL, true, 40),

  -- Premium 20× / Community: €199/mo · €1990/yr (save ~17%) — 20× price for 20× quota
  ('premium_20x_monthly', 'premium_20x',  'month',  19900, 'eur', NULL, true, 50),
  ('premium_20x_annual',  'premium_20x',  'year',  199000, 'eur', NULL, true, 60)
ON CONFLICT (price_key) DO UPDATE SET
  plan_key         = EXCLUDED.plan_key,
  billing_interval = EXCLUDED.billing_interval,
  price_cents      = EXCLUDED.price_cents,
  currency         = EXCLUDED.currency,
  is_active        = EXCLUDED.is_active,
  sort_order       = EXCLUDED.sort_order,
  updated_at       = now();

-- -----------------------------------------------------------------------------
-- 3. credit_packs — 3 one-shot SKUs
-- -----------------------------------------------------------------------------

INSERT INTO public.credit_packs (
  pack_key, display_name, credits, bonus_credits, price_cents, currency,
  stripe_product_id, stripe_price_id, is_active, sort_order
) VALUES
  ('starter', 'Starter',  500,    0,  499, 'eur', NULL, NULL, true, 10),
  ('boost',   'Boost',   2000,  200, 1999, 'eur', NULL, NULL, true, 20),  -- +10% bonus
  ('power',   'Power',  10000, 2000, 9900, 'eur', NULL, NULL, true, 30)   -- +20% bonus
ON CONFLICT (pack_key) DO UPDATE SET
  display_name  = EXCLUDED.display_name,
  credits       = EXCLUDED.credits,
  bonus_credits = EXCLUDED.bonus_credits,
  price_cents   = EXCLUDED.price_cents,
  currency      = EXCLUDED.currency,
  is_active     = EXCLUDED.is_active,
  sort_order    = EXCLUDED.sort_order,
  updated_at    = now();

-- Customer-facing labels in i18n (PR-3) lead with what the credits buy, not the
-- raw count:
--   starter: "10 hours of standard voice OR 100 live minutes"
--   boost:   "Most popular — 7 hours of live voice"
--   power:   "Heavy use — 40 hours of live voice"

-- -----------------------------------------------------------------------------
-- 4. feature_entitlements — 24 rows (4 plans × 6 metered features)
-- -----------------------------------------------------------------------------
-- Feature quotas locked per §A of the plan. All numbers finite (no -1).
--
-- Six features metered in v1:
--   voice_live_minutes  (ORB Gemini Live)         — HARD: degrade
--   live_room_minutes   (Daily.co hosting)        — HARD: graceful disconnect
--   match_posts         (Find-a-Match post count) — SOFT counter (no 402)
--   match_reveals       (Find-a-Match reveals)    — SOFT counter (no 402)
--   lab_analyses        (OCR + LLM lab readings)  — SOFT counter (no 402)
--   photo_uploads       (storage-bound)           — SOFT counter (no 402)
--
-- allowed_burn_buckets governs which wallet bucket can fund PAYG overage:
--   purchased_credits only           — voice + rooms (expensive, cashflow-critical)
--   purchased_credits + reward_credits — match/lab/photo (cheap, engagement-friendly)
--
-- credit_cost_per_unit is the PAYG burn rate per additional unit beyond quota.

INSERT INTO public.feature_entitlements (
  plan_key, feature_key, quota, window_seconds, unit, behavior_on_exceed,
  credit_cost_per_unit, allowed_burn_buckets
) VALUES
  -- ─── voice_live_minutes (Gemini Live · €0.20/min raw cost) ─────────────────
  -- 30-day window. Behavior: degrade to standard voice (Cartesia + Flash).
  -- PAYG rate: 5 credits/min = €0.05/min covers cost + margin.
  ('free',         'voice_live_minutes',   15, 2592000, 'minutes', 'degrade',     5, ARRAY['purchased_credits']),
  ('premium',      'voice_live_minutes',   30, 2592000, 'minutes', 'degrade',     5, ARRAY['purchased_credits']),
  ('premium_5x',   'voice_live_minutes',  150, 2592000, 'minutes', 'degrade',     5, ARRAY['purchased_credits']),
  ('premium_20x',  'voice_live_minutes',  600, 2592000, 'minutes', 'degrade',     5, ARRAY['purchased_credits']),

  -- ─── live_room_minutes (Daily.co hosting · €0.004/p-min) ───────────────────
  -- 30-day window. Behavior: 5-min warning → 1-min warning → graceful disconnect.
  -- PAYG rate: 1 credit/min = €0.01/min.
  -- Free: 40 min/month total (≈ one 40-min session). Per-session 40-min cap is
  -- enforced in the route handler, not the entitlement.
  ('free',         'live_room_minutes',    40, 2592000, 'minutes', 'hard_block',  1, ARRAY['purchased_credits']),
  ('premium',      'live_room_minutes',   300, 2592000, 'minutes', 'hard_block',  1, ARRAY['purchased_credits']),
  ('premium_5x',   'live_room_minutes',  1500, 2592000, 'minutes', 'hard_block',  1, ARRAY['purchased_credits']),
  ('premium_20x',  'live_room_minutes',  6000, 2592000, 'minutes', 'hard_block',  1, ARRAY['purchased_credits']),

  -- ─── match_posts (Find-a-Match post creation) ──────────────────────────────
  -- 30-day window. Behavior: soft_counter — UI badge, route returns 200.
  -- PAYG rate: 50 credits/post = €0.50.
  ('free',         'match_posts',           3, 2592000, 'count',   'soft_counter', 50, ARRAY['purchased_credits','reward_credits']),
  ('premium',      'match_posts',          20, 2592000, 'count',   'soft_counter', 50, ARRAY['purchased_credits','reward_credits']),
  ('premium_5x',   'match_posts',         100, 2592000, 'count',   'soft_counter', 50, ARRAY['purchased_credits','reward_credits']),
  ('premium_20x',  'match_posts',         400, 2592000, 'count',   'soft_counter', 50, ARRAY['purchased_credits','reward_credits']),

  -- ─── match_reveals (Find-a-Match counterparty reveal) ──────────────────────
  -- 7-day rolling window. Behavior: soft_counter in v1.
  -- PAYG rate: 10 credits/reveal = €0.10.
  ('free',         'match_reveals',         5,  604800, 'count',   'soft_counter', 10, ARRAY['purchased_credits','reward_credits']),
  ('premium',      'match_reveals',        50, 2592000, 'count',   'soft_counter', 10, ARRAY['purchased_credits','reward_credits']),
  ('premium_5x',   'match_reveals',       250, 2592000, 'count',   'soft_counter', 10, ARRAY['purchased_credits','reward_credits']),
  ('premium_20x',  'match_reveals',      1000, 2592000, 'count',   'soft_counter', 10, ARRAY['purchased_credits','reward_credits']),

  -- ─── lab_analyses (OCR + Gemini multimodal · ~€0.10/lab raw) ───────────────
  -- 30-day window. Behavior: soft_counter in v1.
  -- PAYG rate: 50 credits/lab = €0.50.
  ('free',         'lab_analyses',          1, 2592000, 'count',   'soft_counter', 50, ARRAY['purchased_credits','reward_credits']),
  ('premium',      'lab_analyses',          5, 2592000, 'count',   'soft_counter', 50, ARRAY['purchased_credits','reward_credits']),
  ('premium_5x',   'lab_analyses',         25, 2592000, 'count',   'soft_counter', 50, ARRAY['purchased_credits','reward_credits']),
  ('premium_20x',  'lab_analyses',        100, 2592000, 'count',   'soft_counter', 50, ARRAY['purchased_credits','reward_credits']),

  -- ─── photo_uploads (Supabase Storage · ~$0.021/GB-month + egress) ──────────
  -- 30-day window. Behavior: soft_counter in v1.
  -- PAYG rate: 1 credit/photo = €0.01.
  -- Storage GB quotas are separate (subscription_plans.features_json.storage_mb,
  -- seeded in migration 8) and metered by a different code path.
  ('free',         'photo_uploads',         5, 2592000, 'count',   'soft_counter',  1, ARRAY['purchased_credits','reward_credits']),
  ('premium',      'photo_uploads',        50, 2592000, 'count',   'soft_counter',  1, ARRAY['purchased_credits','reward_credits']),
  ('premium_5x',   'photo_uploads',       250, 2592000, 'count',   'soft_counter',  1, ARRAY['purchased_credits','reward_credits']),
  ('premium_20x',  'photo_uploads',      1000, 2592000, 'count',   'soft_counter',  1, ARRAY['purchased_credits','reward_credits'])

ON CONFLICT (plan_key, feature_key) DO UPDATE SET
  quota                = EXCLUDED.quota,
  window_seconds       = EXCLUDED.window_seconds,
  unit                 = EXCLUDED.unit,
  behavior_on_exceed   = EXCLUDED.behavior_on_exceed,
  credit_cost_per_unit = EXCLUDED.credit_cost_per_unit,
  allowed_burn_buckets = EXCLUDED.allowed_burn_buckets;

-- -----------------------------------------------------------------------------
-- 5. Verification: row counts
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_plans     integer;
  v_prices    integer;
  v_packs     integer;
  v_entitle   integer;
BEGIN
  SELECT COUNT(*) INTO v_plans   FROM public.subscription_plans       WHERE is_active = true;
  SELECT COUNT(*) INTO v_prices  FROM public.subscription_plan_prices WHERE is_active = true;
  SELECT COUNT(*) INTO v_packs   FROM public.credit_packs             WHERE is_active = true;
  SELECT COUNT(*) INTO v_entitle FROM public.feature_entitlements;

  IF v_plans   <> 4  THEN RAISE EXCEPTION 'VTID-03107 seed: expected 4 plans, found %', v_plans; END IF;
  IF v_prices  <> 6  THEN RAISE EXCEPTION 'VTID-03107 seed: expected 6 prices, found %', v_prices; END IF;
  IF v_packs   <> 3  THEN RAISE EXCEPTION 'VTID-03107 seed: expected 3 credit packs, found %', v_packs; END IF;
  IF v_entitle <> 24 THEN RAISE EXCEPTION 'VTID-03107 seed: expected 24 entitlement rows, found %', v_entitle; END IF;

  RAISE NOTICE 'VTID-03107 seed: 4 plans, 6 prices, 3 credit packs, 24 entitlements ✓';
END $$;

-- -----------------------------------------------------------------------------
-- 6. Verification: the 5×/20× quota multipliers are exact
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_premium_voice   integer;
  v_5x_voice        integer;
  v_20x_voice       integer;
BEGIN
  SELECT quota INTO v_premium_voice FROM public.feature_entitlements
    WHERE plan_key = 'premium'      AND feature_key = 'voice_live_minutes';
  SELECT quota INTO v_5x_voice      FROM public.feature_entitlements
    WHERE plan_key = 'premium_5x'   AND feature_key = 'voice_live_minutes';
  SELECT quota INTO v_20x_voice     FROM public.feature_entitlements
    WHERE plan_key = 'premium_20x'  AND feature_key = 'voice_live_minutes';

  IF v_5x_voice  <> v_premium_voice * 5  THEN
    RAISE EXCEPTION 'VTID-03107 seed: Premium 5x voice quota is %, expected %', v_5x_voice, v_premium_voice * 5;
  END IF;
  IF v_20x_voice <> v_premium_voice * 20 THEN
    RAISE EXCEPTION 'VTID-03107 seed: Premium 20x voice quota is %, expected %', v_20x_voice, v_premium_voice * 20;
  END IF;

  RAISE NOTICE 'VTID-03107 seed: 5×/20× quota multipliers verified ✓ (% / % / % min)',
    v_premium_voice, v_5x_voice, v_20x_voice;
END $$;
