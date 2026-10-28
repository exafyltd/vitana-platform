-- =============================================================================
-- VTID-05171 — Life Timeline P5: companion wiring.
-- Sparring record: docs/validation/VTID-05167/plan-sparring.md
-- (plan hash 535ddb70…2b04, CONVERGED, owner-approved 2026-10-13).
--
-- What this does
--   1. user_routines.routine_kind accepts four more kinds, written by the
--      Timeline Habit Rollup (services/gateway/src/services/timeline/
--      habit-rollup.ts, automation AP-0916):
--        screen_habit      — screens the member returns to on many days
--        active_hours      — when in the day the member is usually active
--        feature_affinity  — life areas the member uses most
--        pillar_rhythm     — when each health pillar is usually logged/synced
--      The five VTID-01936 kinds stay exactly as they are; AP-0906 still
--      writes them and AP-0908 still reads only them.
--   2. public.timeline_learning_prefs: one row per (member, category) the
--      member switched. A missing row means "Vitana may learn from this"
--      (owner default D2). `app_usage` is the "learn from my app usage"
--      switch; off stops the rollup and deletes the app-usage routines.
--      Owner-only RLS; the gateway writes through PUT
--      /api/v1/timeline/learning-prefs with the member's id.
--      These switches decide what Vitana LEARNS from; health data stays
--      governed by the existing health consent and sensitivity rules too.
--
-- Rollback
--   DROP TABLE IF EXISTS public.timeline_learning_prefs;
--   DELETE FROM public.user_routines
--     WHERE routine_kind IN ('screen_habit','active_hours','feature_affinity','pillar_rhythm');
--   ALTER TABLE public.user_routines DROP CONSTRAINT user_routines_routine_kind_check;
--   ALTER TABLE public.user_routines ADD CONSTRAINT user_routines_routine_kind_check
--     CHECK (routine_kind IN ('time_of_day_preference','day_of_week_rhythm',
--       'category_affinity','wave_velocity','completion_streak'));
-- =============================================================================

BEGIN;

-- 1. Routine kinds ------------------------------------------------------------
ALTER TABLE public.user_routines DROP CONSTRAINT IF EXISTS user_routines_routine_kind_check;
ALTER TABLE public.user_routines ADD CONSTRAINT user_routines_routine_kind_check
  CHECK (routine_kind IN (
    'time_of_day_preference',
    'day_of_week_rhythm',
    'category_affinity',
    'wave_velocity',
    'completion_streak',
    'screen_habit',
    'active_hours',
    'feature_affinity',
    'pillar_rhythm'
  ));

-- 2. Learning switches --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.timeline_learning_prefs (
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category   text        NOT NULL CHECK (category IN (
    'nutrition', 'hydration', 'exercise', 'sleep', 'mental', 'cross_pillar',
    'diary', 'goals', 'journey', 'vitana', 'community', 'events', 'live_media',
    'shop', 'wallet', 'account', 'app_usage'
  )),
  learn      boolean     NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);

ALTER TABLE public.timeline_learning_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS timeline_learning_prefs_owner ON public.timeline_learning_prefs;
CREATE POLICY timeline_learning_prefs_owner ON public.timeline_learning_prefs
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON public.timeline_learning_prefs FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.timeline_learning_prefs TO authenticated;

COMMENT ON TABLE public.timeline_learning_prefs IS
  'VTID-05171 — per-category "Vitana may learn from this" switches. Missing row = on. app_usage = learn from app usage (off stops the habit rollup and deletes its routines).';

COMMIT;
