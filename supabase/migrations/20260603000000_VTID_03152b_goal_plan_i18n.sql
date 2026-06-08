-- VTID-03152b — Goal plan view-time localization (translate-on-view + cache).
--
-- Plans are generated once in the user's active language and the step text is
-- stored as a single fixed string (goal_plans.plan_summary, goal_plan_steps
-- .title/.description). That pins a plan to the language it was authored in, so
-- when a user flips the app language toggle (MAXINA intro page) the plan body
-- stayed in its original language while the rest of the UI switched.
--
-- This migration adds:
--   1. goal_plans.source_lang   — the language the stored text is authored in,
--                                 so we can skip translating when the requested
--                                 locale already matches the source.
--   2. goal_plan_i18n           — cached plan_summary translation per locale.
--   3. goal_plan_step_i18n      — cached step title/description per locale.
--
-- The gateway translates lazily on first view of a non-source locale and caches
-- the result here, so subsequent toggles are instant. The plan itself (steps,
-- ordering, progress) is untouched — only the displayed wording is localized.

BEGIN;

-- 1. Record the language the canonical stored text is written in. NULL for
--    pre-existing plans (language unknown → the gateway translates to whatever
--    is requested and caches; new plans set this at generation time).
ALTER TABLE public.goal_plans
  ADD COLUMN IF NOT EXISTS source_lang TEXT;

-- 2. Plan-level translation cache (one row per plan per locale).
CREATE TABLE IF NOT EXISTS public.goal_plan_i18n (
  plan_id      UUID NOT NULL REFERENCES public.goal_plans(id) ON DELETE CASCADE,
  locale       TEXT NOT NULL,
  plan_summary TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, locale)
);

-- 3. Step-level translation cache (one row per step per locale).
CREATE TABLE IF NOT EXISTS public.goal_plan_step_i18n (
  step_id     UUID NOT NULL REFERENCES public.goal_plan_steps(id) ON DELETE CASCADE,
  locale      TEXT NOT NULL,
  title       TEXT,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (step_id, locale)
);

CREATE INDEX IF NOT EXISTS goal_plan_step_i18n_step_idx
  ON public.goal_plan_step_i18n(step_id);

-- updated_at touch triggers. The base goal-plan migration defines this function,
-- but recreate it idempotently here so this migration is self-contained (the
-- function was found missing on the live DB).
CREATE OR REPLACE FUNCTION public.goal_plan_touch_updated_at()
  RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS goal_plan_i18n_updated_at ON public.goal_plan_i18n;
CREATE TRIGGER goal_plan_i18n_updated_at BEFORE UPDATE ON public.goal_plan_i18n
  FOR EACH ROW EXECUTE FUNCTION public.goal_plan_touch_updated_at();

DROP TRIGGER IF EXISTS goal_plan_step_i18n_updated_at ON public.goal_plan_step_i18n;
CREATE TRIGGER goal_plan_step_i18n_updated_at BEFORE UPDATE ON public.goal_plan_step_i18n
  FOR EACH ROW EXECUTE FUNCTION public.goal_plan_touch_updated_at();

-- RLS: the gateway writes/reads with the service role (bypasses RLS). These
-- policies cover any direct authenticated client read, scoped to the owner of
-- the parent plan (mirrors goal_plans / goal_plan_steps select-own policies).
ALTER TABLE public.goal_plan_i18n ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.goal_plan_step_i18n ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS goal_plan_i18n_select_own ON public.goal_plan_i18n;
CREATE POLICY goal_plan_i18n_select_own ON public.goal_plan_i18n
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.goal_plans p
      WHERE p.id = goal_plan_i18n.plan_id AND p.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS goal_plan_step_i18n_select_own ON public.goal_plan_step_i18n;
CREATE POLICY goal_plan_step_i18n_select_own ON public.goal_plan_step_i18n
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.goal_plan_steps s
      WHERE s.id = goal_plan_step_i18n.step_id AND s.user_id = auth.uid()
    )
  );

COMMIT;
