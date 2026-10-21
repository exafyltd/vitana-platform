-- =============================================================================
-- VTID-03107 · Billing v1 — Rolling 5h + weekly window quotas
-- =============================================================================
-- Adds Claude / ChatGPT-style two-tier reset windows so Free users hit walls
-- that recover within hours instead of needing to wait 30 days.
--
-- Pattern (matches Codex menu UX):
--   • 5h sliding window — caps burst usage, refreshes ~4x/day
--   • Weekly sliding window — caps total per week, refreshes Monday 00:00 CET
--   • Monthly window — kept as a higher ceiling so weekly is always the binding
--     cap on Free; paid tiers keep monthly-only (no 5h/weekly limit)
--
-- Schema changes
--   ALTER TABLE feature_entitlements
--     ADD window_5h_quota   INTEGER NULL   -- if set, enforced as sliding 5h
--     ADD weekly_quota      INTEGER NULL   -- if set, enforced as sliding 7d
--
-- NULL semantics: when a window column is NULL, that window is not enforced
-- for this (plan, feature) row. Paid tiers keep both columns NULL → only the
-- existing monthly `quota` is checked. Free uses all three.
--
-- New RPC
--   fn_get_feature_usage_in_window(tenant, user, feature, seconds)
--     Sliding aggregation: SUM(used) over feature_usage rows whose
--     window_start is within the last `seconds` interval. Returns the
--     accumulated usage plus the time when the OLDEST tallied event ages
--     out of the window (= effective reset time the UI shows).
--
--   This sits alongside the existing fn_get_feature_usage (point lookup
--   for calendar-aligned windows) — unchanged for backwards compat.
--
-- Cashflow guardrail
--   Free worst case bumps from €3 → €16/user-month if every window is maxed
--   every cycle. Real typical use is far lower (windows refresh but human
--   attention doesn't). Every number below is one SQL UPDATE away from
--   retuning if telemetry shows abuse.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Add columns
-- -----------------------------------------------------------------------------

ALTER TABLE public.feature_entitlements
  ADD COLUMN IF NOT EXISTS window_5h_quota   INTEGER NULL,
  ADD COLUMN IF NOT EXISTS weekly_quota      INTEGER NULL;

COMMENT ON COLUMN public.feature_entitlements.window_5h_quota IS
  'VTID-03107: optional rolling 5-hour cap. NULL = not enforced. When set, takes precedence over monthly if more restrictive.';
COMMENT ON COLUMN public.feature_entitlements.weekly_quota IS
  'VTID-03107: optional rolling 7-day cap. NULL = not enforced. Typically binds before monthly on Free tier.';

-- -----------------------------------------------------------------------------
-- 2. fn_get_feature_usage_in_window — sliding aggregation
-- -----------------------------------------------------------------------------
-- Returns SUM(used) over the last `p_window_seconds` of events plus the
-- effective reset_at (when the oldest tallied event ages out).
--
-- Storage assumption: callers write per-action event rows via
-- fn_increment_feature_usage with p_window_seconds=60 (minute-granularity),
-- producing one row per minute of activity. Same-minute increments fold via
-- the existing ON CONFLICT.
--
-- This means the EXISTING fn_increment_feature_usage stays usable for both
-- modes — entitlement-service v2 just always passes p_window_seconds=60 so
-- the rows are fine-grained enough for sliding aggregation.

CREATE OR REPLACE FUNCTION public.fn_get_feature_usage_in_window(
  p_tenant_id      uuid,
  p_user_id        uuid,
  p_feature_key    text,
  p_window_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now            timestamptz := now();
  v_cutoff         timestamptz;
  v_used           integer;
  v_oldest         timestamptz;
  v_reset_at       timestamptz;
BEGIN
  IF p_window_seconds < 1 THEN
    RAISE EXCEPTION 'fn_get_feature_usage_in_window: p_window_seconds must be >= 1';
  END IF;

  v_cutoff := v_now - make_interval(secs => p_window_seconds);

  SELECT COALESCE(SUM(used), 0), MIN(window_start)
    INTO v_used, v_oldest
  FROM public.feature_usage
  WHERE user_id = p_user_id
    AND feature_key = p_feature_key
    AND window_start >= v_cutoff;

  -- reset_at = oldest tallied event + window length (when it ages out).
  -- If no events in window, reset_at is null (no usage to recover).
  IF v_oldest IS NOT NULL THEN
    v_reset_at := v_oldest + make_interval(secs => p_window_seconds);
  ELSE
    v_reset_at := NULL;
  END IF;

  RETURN jsonb_build_object(
    'ok',         true,
    'used',       v_used,
    'window_seconds', p_window_seconds,
    'reset_at',   v_reset_at,
    'oldest_event_at', v_oldest
  );
END;
$$;

COMMENT ON FUNCTION public.fn_get_feature_usage_in_window IS
  'VTID-03107: sliding-window usage aggregation. Returns SUM(used) over the last p_window_seconds + effective reset_at (oldest event + window length). Caller writes per-minute event rows via fn_increment_feature_usage(p_window_seconds=60).';

GRANT EXECUTE ON FUNCTION public.fn_get_feature_usage_in_window TO service_role, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Update Free tier with 5h + weekly + monthly
-- -----------------------------------------------------------------------------
-- Free tier gets the three-window treatment so the user always has a near-term
-- recovery option. Monthly is bumped above weekly×4.3 so weekly is the binding
-- cap (the rolling 5h binds first during active use; weekly binds for the week).

UPDATE public.feature_entitlements SET
  window_5h_quota = 5,           -- 5 min per 5h
  weekly_quota    = 20,          -- 20 min per week
  quota           = 80           -- monthly soft ceiling; weekly always binds first
WHERE plan_key = 'free' AND feature_key = 'voice_live_minutes';

UPDATE public.feature_entitlements SET
  window_5h_quota = 20,          -- 20 min per 5h
  weekly_quota    = 60,          -- 1 hr per week
  quota           = 240          -- monthly soft ceiling
WHERE plan_key = 'free' AND feature_key = 'live_room_minutes';

UPDATE public.feature_entitlements SET
  window_5h_quota = 2,           -- 2 posts per 5h
  weekly_quota    = 5,           -- 5 posts per week
  quota           = 20           -- monthly soft ceiling
WHERE plan_key = 'free' AND feature_key = 'match_posts';

UPDATE public.feature_entitlements SET
  window_5h_quota = 3,           -- 3 reveals per 5h
  weekly_quota    = 10,          -- 10 reveals per week
  quota           = 40           -- monthly soft ceiling
WHERE plan_key = 'free' AND feature_key = 'match_reveals';

UPDATE public.feature_entitlements SET
  window_5h_quota = 1,           -- 1 lab per 5h
  weekly_quota    = 3,           -- 3 labs per week
  quota           = 12           -- monthly soft ceiling
WHERE plan_key = 'free' AND feature_key = 'lab_analyses';

UPDATE public.feature_entitlements SET
  window_5h_quota = 5,           -- 5 photos per 5h
  weekly_quota    = 15,          -- 15 photos per week
  quota           = 60           -- monthly soft ceiling
WHERE plan_key = 'free' AND feature_key = 'photo_uploads';

-- -----------------------------------------------------------------------------
-- 4. Paid tiers — leave window_5h_quota + weekly_quota NULL (monthly only)
-- -----------------------------------------------------------------------------
-- Premium / Host / Community keep the existing monthly quotas. window_5h and
-- weekly stay NULL → entitlement service skips those checks for these tiers.
--
-- No-op UPDATEs included for clarity that this is intentional.

-- (intentionally no UPDATEs for premium/premium_5x/premium_20x rows — NULL is correct)

-- -----------------------------------------------------------------------------
-- 5. Flip Free tier behavior_on_exceed from soft_counter → paywall
-- -----------------------------------------------------------------------------
-- Per cashflow review 2026-05-26: hard cuts on all 8 metered features at launch.
-- The auto-grant migration (20260526110000) ensures every onboarded user is on
-- Premium for 12 months, so no existing user hits a Free hard cut. Only new
-- signups after the Founding cap (500) face Free walls — and they always have
-- PAYG credits + Upgrade CTAs.

UPDATE public.feature_entitlements
  SET behavior_on_exceed = 'paywall'
WHERE plan_key = 'free'
  AND behavior_on_exceed = 'soft_counter';

-- -----------------------------------------------------------------------------
-- 6. Verification: Free tier has all three windows populated
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_free_with_5h   integer;
  v_free_with_wk   integer;
  v_paid_with_5h   integer;
  v_voice_5h       integer;
  v_voice_wk       integer;
BEGIN
  SELECT COUNT(*) INTO v_free_with_5h
    FROM public.feature_entitlements
    WHERE plan_key = 'free' AND window_5h_quota IS NOT NULL;

  SELECT COUNT(*) INTO v_free_with_wk
    FROM public.feature_entitlements
    WHERE plan_key = 'free' AND weekly_quota IS NOT NULL;

  SELECT COUNT(*) INTO v_paid_with_5h
    FROM public.feature_entitlements
    WHERE plan_key IN ('premium','premium_5x','premium_20x')
      AND window_5h_quota IS NOT NULL;

  SELECT window_5h_quota, weekly_quota
    INTO v_voice_5h, v_voice_wk
    FROM public.feature_entitlements
    WHERE plan_key = 'free' AND feature_key = 'voice_live_minutes';

  IF v_free_with_5h <> 6 THEN
    RAISE EXCEPTION 'VTID-03107 rolling_windows: expected 6 Free rows with 5h quota, found %', v_free_with_5h;
  END IF;
  IF v_free_with_wk <> 6 THEN
    RAISE EXCEPTION 'VTID-03107 rolling_windows: expected 6 Free rows with weekly quota, found %', v_free_with_wk;
  END IF;
  IF v_paid_with_5h <> 0 THEN
    RAISE EXCEPTION 'VTID-03107 rolling_windows: paid tiers should have NO 5h windows, found %', v_paid_with_5h;
  END IF;
  IF v_voice_5h <> 5 OR v_voice_wk <> 20 THEN
    RAISE EXCEPTION 'VTID-03107 rolling_windows: voice limits wrong (5h=%, weekly=%) expected 5/20', v_voice_5h, v_voice_wk;
  END IF;

  RAISE NOTICE 'VTID-03107 rolling_windows: Free rows have all 3 windows, paid stays monthly-only ✓';
END $$;
