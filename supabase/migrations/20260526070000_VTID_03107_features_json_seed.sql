-- =============================================================================
-- VTID-03107 · Billing v1 — subscription_plans.features_json seed
-- =============================================================================
-- Populates the per-tier capability config that lives alongside the metered
-- feature_entitlements rows. These are CAPABILITY flags (boolean-ish / scalar)
-- that don't fit the quota model:
--
--   storage_mb                       Storage quota (separate metering path
--                                    using Supabase Storage upload sizes)
--   sell_and_earn_catalog_size       Max items in the user's referral catalog
--   sell_and_earn_daily_drafts       Per-day cap on Sell-and-Earn shadow drafts
--   sell_and_earn_channels           Max listener channels
--   sell_and_earn_autonomy_ceiling   Highest autonomy level user can set
--                                    ('silent' | 'draft_to_user' | 'one_tap_approve' | 'auto_post')
--                                    In v1: highest available is 'one_tap_approve'
--                                    (auto_post is feature-flagged off platform-wide)
--   sell_and_earn_voice_cloning      Voice/persona cloning (false in v1 launch)
--   premium_priority_practitioner    Premium users surface first in practitioner queues
--   ai_digest_cadence                'weekly' (Free) | 'daily' (paid) — feature flag
--   auto_schedule_calendar           Premium-only calendar auto-schedule capability
--
-- Engineering naming
--   These keys live in features_json (jsonb) on subscription_plans. The
--   entitlement service reads them via:
--     SELECT features_json->>'storage_mb' FROM subscription_plans WHERE plan_key = $1
-- =============================================================================

UPDATE public.subscription_plans
SET features_json = jsonb_build_object(
  -- Storage
  'storage_mb',                       100,

  -- Sell and Earn (capability ladder per §R)
  'sell_and_earn_catalog_size',       5,
  'sell_and_earn_daily_drafts',       1,
  'sell_and_earn_channels',           1,
  'sell_and_earn_autonomy_ceiling',   'draft_to_user',
  'sell_and_earn_voice_cloning',      false,
  'sell_and_earn_detected_window_days', 7,

  -- AI / personalization
  'ai_digest_cadence',                'weekly',
  'auto_schedule_calendar',           false,

  -- Practitioner / marketplace
  'premium_priority_practitioner',    false
)
WHERE plan_key = 'free';

UPDATE public.subscription_plans
SET features_json = jsonb_build_object(
  -- Storage
  'storage_mb',                       5000,            -- 5 GB

  -- Sell and Earn
  'sell_and_earn_catalog_size',       25,
  'sell_and_earn_daily_drafts',       5,
  'sell_and_earn_channels',           3,
  'sell_and_earn_autonomy_ceiling',   'draft_to_user',
  'sell_and_earn_voice_cloning',      false,
  'sell_and_earn_detected_window_days', 30,

  -- AI / personalization
  'ai_digest_cadence',                'daily',
  'auto_schedule_calendar',           true,

  -- Practitioner / marketplace
  'premium_priority_practitioner',    true
)
WHERE plan_key = 'premium';

UPDATE public.subscription_plans
SET features_json = jsonb_build_object(
  -- Storage
  'storage_mb',                       25000,           -- 25 GB

  -- Sell and Earn
  'sell_and_earn_catalog_size',       100,
  'sell_and_earn_daily_drafts',       25,
  'sell_and_earn_channels',           10,
  'sell_and_earn_autonomy_ceiling',   'one_tap_approve',
  'sell_and_earn_voice_cloning',      false,
  'sell_and_earn_detected_window_days', 90,

  -- AI / personalization
  'ai_digest_cadence',                'daily',
  'auto_schedule_calendar',           true,

  -- Practitioner / marketplace
  'premium_priority_practitioner',    true
)
WHERE plan_key = 'premium_5x';

UPDATE public.subscription_plans
SET features_json = jsonb_build_object(
  -- Storage
  'storage_mb',                       100000,          -- 100 GB

  -- Sell and Earn (fair-use ceilings; finite per cashflow guardrail §N #1)
  'sell_and_earn_catalog_size',       1000,
  'sell_and_earn_daily_drafts',       200,
  'sell_and_earn_channels',           50,
  'sell_and_earn_autonomy_ceiling',   'one_tap_approve',
  'sell_and_earn_voice_cloning',      false,
  'sell_and_earn_detected_window_days', -1,             -- lifetime (this is the ONE place we use -1; not a paywall quota)

  -- AI / personalization
  'ai_digest_cadence',                'daily',
  'auto_schedule_calendar',           true,

  -- Practitioner / marketplace
  'premium_priority_practitioner',    true,

  -- Live Rooms participant guardrail (internal cap to bound Daily.co cost)
  'live_room_participant_minute_cap', 60000             -- 100h × avg 10 ppl = 60k p-min/mo
)
WHERE plan_key = 'premium_20x';

-- -----------------------------------------------------------------------------
-- Verification: every plan has a non-empty features_json with storage_mb
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_count             integer;
  v_free_storage      integer;
  v_premium_storage   integer;
  v_5x_storage        integer;
  v_20x_storage       integer;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.subscription_plans
  WHERE features_json ? 'storage_mb';

  IF v_count <> 4 THEN
    RAISE EXCEPTION 'VTID-03107 features_json: expected 4 plans with storage_mb, found %', v_count;
  END IF;

  SELECT (features_json->>'storage_mb')::integer INTO v_free_storage    FROM public.subscription_plans WHERE plan_key = 'free';
  SELECT (features_json->>'storage_mb')::integer INTO v_premium_storage FROM public.subscription_plans WHERE plan_key = 'premium';
  SELECT (features_json->>'storage_mb')::integer INTO v_5x_storage      FROM public.subscription_plans WHERE plan_key = 'premium_5x';
  SELECT (features_json->>'storage_mb')::integer INTO v_20x_storage     FROM public.subscription_plans WHERE plan_key = 'premium_20x';

  IF v_free_storage    <> 100    THEN RAISE EXCEPTION 'free storage_mb = %, expected 100', v_free_storage; END IF;
  IF v_premium_storage <> 5000   THEN RAISE EXCEPTION 'premium storage_mb = %, expected 5000', v_premium_storage; END IF;
  IF v_5x_storage      <> 25000  THEN RAISE EXCEPTION 'premium_5x storage_mb = %, expected 25000', v_5x_storage; END IF;
  IF v_20x_storage     <> 100000 THEN RAISE EXCEPTION 'premium_20x storage_mb = %, expected 100000', v_20x_storage; END IF;

  RAISE NOTICE 'VTID-03107 features_json: storage_mb seeded per plan ✓ (100MB / 5GB / 25GB / 100GB)';
END $$;

DO $$
DECLARE
  v_premium_catalog integer;
  v_5x_catalog      integer;
  v_20x_catalog     integer;
  v_free_ceiling    text;
BEGIN
  SELECT (features_json->>'sell_and_earn_catalog_size')::integer INTO v_premium_catalog
   FROM public.subscription_plans WHERE plan_key = 'premium';
  SELECT (features_json->>'sell_and_earn_catalog_size')::integer INTO v_5x_catalog
   FROM public.subscription_plans WHERE plan_key = 'premium_5x';
  SELECT (features_json->>'sell_and_earn_catalog_size')::integer INTO v_20x_catalog
   FROM public.subscription_plans WHERE plan_key = 'premium_20x';
  SELECT features_json->>'sell_and_earn_autonomy_ceiling' INTO v_free_ceiling
   FROM public.subscription_plans WHERE plan_key = 'free';

  IF v_premium_catalog <> 25 OR v_5x_catalog <> 100 OR v_20x_catalog <> 1000 THEN
    RAISE EXCEPTION 'Sell-and-Earn catalog ladder broken: premium=%, 5x=%, 20x=%',
      v_premium_catalog, v_5x_catalog, v_20x_catalog;
  END IF;

  IF v_free_ceiling <> 'draft_to_user' THEN
    RAISE EXCEPTION 'Free Sell-and-Earn autonomy ceiling = %, expected draft_to_user', v_free_ceiling;
  END IF;

  RAISE NOTICE 'VTID-03107 features_json: Sell-and-Earn capability ladder verified ✓ (catalogs % / % / %)',
    v_premium_catalog, v_5x_catalog, v_20x_catalog;
END $$;
