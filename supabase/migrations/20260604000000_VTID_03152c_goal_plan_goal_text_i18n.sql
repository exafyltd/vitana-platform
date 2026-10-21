-- VTID-03152c — Localize the goal-plan title (goal_text) alongside the body.
--
-- VTID-03152b added view-time translation for plan_summary + step title/description
-- and cached it in goal_plan_i18n / goal_plan_step_i18n. It did NOT cover
-- goal_plans.goal_text — the plan's title, rendered as the drawer subtitle
-- ("Your plan" → goal_text). That string is copied from the Life Compass goal at
-- generation time in the user's then-active language, so a German-authored plan
-- shows a German title even when the app language toggle is flipped to English
-- (the exact symptom in the plan drawer: English chrome, German title).
--
-- The frontend's localizeGoal() can only flip *known* English seed strings to the
-- catalog; a German or free-text custom goal passes through untranslated. So we
-- translate-on-view + cache goal_text the same way as plan_summary: one extra
-- column on the existing per-locale plan cache.

BEGIN;

ALTER TABLE public.goal_plan_i18n
  ADD COLUMN IF NOT EXISTS goal_text TEXT;

COMMIT;
