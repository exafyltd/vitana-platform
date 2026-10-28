-- =============================================================================
-- user_diary_streak — current consecutive-day streak for diary entries
-- VTID-01983 (H.5)
-- Date: 2026-04-27
--
-- Returns one row per user that has at least one diary_entries record,
-- with the current streak ending today (or null if the most recent entry
-- isn't from today/yesterday).
--
-- Used by the gateway's POST /memory/diary/sync-index endpoint and by the
-- ORB save_diary_entry tool to detect streak transitions (3/7/14/30
-- days) so a wallet reward + OASIS celebration event can fire.
--
-- Streak rule: consecutive calendar days with ≥ 1 diary_entries.created_at
-- ending today. Yesterday-only (no entry today yet) returns the streak
-- length; a gap of 2+ days breaks the streak (returns 0 / NULL).
--
-- Idempotent: CREATE OR REPLACE VIEW.
-- =============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.user_diary_streak AS
WITH entry_days AS (
  SELECT
    user_id,
    (created_at AT TIME ZONE 'UTC')::DATE AS entry_day
  FROM public.diary_entries
  GROUP BY 1, 2
),
ranked AS (
  SELECT
    user_id,
    entry_day,
    -- Group consecutive days by subtracting a row number from the date.
    -- Days in the same streak share the same (entry_day - rn) value.
    entry_day - (ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY entry_day))::INTEGER AS streak_group
  FROM entry_days
),
streaks AS (
  SELECT
    user_id,
    streak_group,
    COUNT(*) AS streak_days,
    MAX(entry_day) AS last_day
  FROM ranked
  GROUP BY user_id, streak_group
)
SELECT
  user_id,
  streak_days::INTEGER AS current_streak_days,
  last_day
FROM streaks
WHERE last_day >= (CURRENT_DATE - INTERVAL '1 day')::DATE
ORDER BY user_id;

COMMENT ON VIEW public.user_diary_streak IS
  'VTID-01983: per-user current diary streak ending today (or yesterday). Used by /diary/sync-index + save_diary_entry voice tool to detect streak transitions and trigger wallet reward + OASIS celebration. Streak breaks with a 2+ day gap.';

-- RLS: view inherits from diary_entries. Service role reads it from the
-- gateway endpoints; users won't query it directly today.
GRANT SELECT ON public.user_diary_streak TO authenticated, anon;

COMMIT;
