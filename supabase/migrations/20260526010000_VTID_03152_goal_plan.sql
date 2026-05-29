-- VTID-03152 — Vitana-prescribed goal plan (Slice E).
-- When a user states a goal with a deadline, Vitana generates a structured plan
-- (milestones + weekly checkpoints + recurring daily habits). One active plan per
-- user; regenerating supersedes the prior plan. Steps drive the My Journey
-- day-by-day view and the daily "Today's goal" card, and are mirrored to the
-- calendar via calendar_events (source_ref_id = step id).

BEGIN;

CREATE TABLE IF NOT EXISTS public.goal_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  tenant_id       UUID,
  life_compass_id UUID,                       -- life_compass.id the plan was generated from
  goal_text       TEXT NOT NULL,
  plan_summary    TEXT,
  start_date      DATE NOT NULL,
  target_date     DATE NOT NULL,
  total_days      INT  NOT NULL DEFAULT 90 CHECK (total_days >= 0),
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','superseded','complete')),
  model           TEXT,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.goal_plan_steps (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id           UUID NOT NULL REFERENCES public.goal_plans(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('milestone','checkpoint','habit')),
  title             TEXT NOT NULL,
  description       TEXT,
  day_offset        INT,                      -- days from start_date (null for habits)
  scheduled_date    DATE,                     -- start_date + day_offset (null for habits)
  sort_order        INT NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','done','skipped')),
  calendar_event_id UUID,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS goal_plans_user_status_idx ON public.goal_plans(user_id, status);
CREATE INDEX IF NOT EXISTS goal_plan_steps_plan_idx ON public.goal_plan_steps(plan_id);
CREATE INDEX IF NOT EXISTS goal_plan_steps_user_date_idx ON public.goal_plan_steps(user_id, scheduled_date);

-- updated_at touch trigger (shared function name kept local to this migration).
CREATE OR REPLACE FUNCTION public.goal_plan_touch_updated_at()
  RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS goal_plans_updated_at ON public.goal_plans;
CREATE TRIGGER goal_plans_updated_at BEFORE UPDATE ON public.goal_plans
  FOR EACH ROW EXECUTE FUNCTION public.goal_plan_touch_updated_at();

DROP TRIGGER IF EXISTS goal_plan_steps_updated_at ON public.goal_plan_steps;
CREATE TRIGGER goal_plan_steps_updated_at BEFORE UPDATE ON public.goal_plan_steps
  FOR EACH ROW EXECUTE FUNCTION public.goal_plan_touch_updated_at();

-- RLS: users read/update their own plan + steps. The gateway uses the service
-- role (bypasses RLS) for generation; these policies cover any direct client read.
ALTER TABLE public.goal_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.goal_plan_steps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS goal_plans_select_own ON public.goal_plans;
CREATE POLICY goal_plans_select_own ON public.goal_plans
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS goal_plan_steps_select_own ON public.goal_plan_steps;
CREATE POLICY goal_plan_steps_select_own ON public.goal_plan_steps
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS goal_plan_steps_update_own ON public.goal_plan_steps;
CREATE POLICY goal_plan_steps_update_own ON public.goal_plan_steps
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

COMMIT;
