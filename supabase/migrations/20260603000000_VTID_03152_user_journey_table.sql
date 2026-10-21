-- VTID-03152 — Slice A: persistent user_journey table.
--
-- Today, journey state (current_wave, day_in_journey, is_past_90_day) is
-- computed live in services/gateway/src/services/guide/awareness-context.ts
-- (buildJourney) from app_users.created_at math every request. There is
-- no persistent representation, no plan_type, no milestone progress, no
-- anti-repetition memory for greetings, no "have we said hello today"
-- gate, and no place to mark the journey paused / restarted / complete.
--
-- This migration introduces `user_journey` as the canonical source of
-- truth for a user's journey. Slice B (GET /api/v1/my-journey) and the
-- forthcoming conversational slices (D daily morning greeting, C one-
-- time welcome, G milestones, H gap recovery) all read from here.
--
-- Design notes:
--   - One row per user (PK = user_id). No tenant FK on the row — we read
--     tenant via user_tenants.active_role at query time.
--   - Schema is additive. The legacy buildJourney() math still works as
--     a fallback in the service layer if a row is missing (transition
--     period for any user the backfill misses).
--   - Backfill seeds is_first_session=false for all existing users
--     (they've already had sessions; the one-time welcome should not
--     fire retroactively). Slice C will only fire for users whose
--     first /me call happens AFTER this migration.

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_journey (
  user_id                  UUID PRIMARY KEY REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  tenant_id                UUID,
  started_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_days               INT NOT NULL DEFAULT 90,
  plan_type                TEXT NOT NULL DEFAULT 'default'
                             CHECK (plan_type IN ('default','personalized')),
  plan_summary             TEXT,
  current_wave_id          TEXT,
  current_milestone_id     TEXT,
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','paused','complete','restarted')),
  completed_milestone_ids  TEXT[] NOT NULL DEFAULT '{}',
  is_first_session         BOOLEAN NOT NULL DEFAULT true,
  last_session_date        DATE,
  last_acknowledged_day    INT,
  recent_greeting_openings TEXT[] NOT NULL DEFAULT '{}',
  plan_negotiated_at       TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.user_journey IS
  'VTID-03152: persistent journey state. One row per user. Slice A of the journey-as-spine plan.';
COMMENT ON COLUMN public.user_journey.plan_type IS
  'default = 90-day plan Vitana prepared; personalized = user negotiated a custom plan with Vitana (Slice E).';
COMMENT ON COLUMN public.user_journey.plan_summary IS
  '2-sentence summary stored by Slice E plan negotiation. NULL for default plans.';
COMMENT ON COLUMN public.user_journey.is_first_session IS
  'Trigger gate for the one-time first-session welcome (Slice C). Cleared at end of first session.';
COMMENT ON COLUMN public.user_journey.last_session_date IS
  'Date (in user TZ) of last completed session. Triggers daily morning greeting (Slice D) when current login date > this.';
COMMENT ON COLUMN public.user_journey.recent_greeting_openings IS
  'Anti-repetition memory for daily greetings. Capped at 5 entries by the service layer.';

CREATE INDEX IF NOT EXISTS user_journey_status_active_idx
  ON public.user_journey(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS user_journey_tenant_idx
  ON public.user_journey(tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_journey_last_session_idx
  ON public.user_journey(last_session_date) WHERE last_session_date IS NOT NULL;

CREATE OR REPLACE FUNCTION public.user_journey_touch_updated_at()
  RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_journey_updated_at_trigger ON public.user_journey;
CREATE TRIGGER user_journey_updated_at_trigger
  BEFORE UPDATE ON public.user_journey
  FOR EACH ROW
  EXECUTE FUNCTION public.user_journey_touch_updated_at();

ALTER TABLE public.user_journey ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_journey_select_own ON public.user_journey;
CREATE POLICY user_journey_select_own ON public.user_journey
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS user_journey_update_own ON public.user_journey;
CREATE POLICY user_journey_update_own ON public.user_journey
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- service_role bypasses RLS; the gateway writes via service_role.

-- ============================================================
-- Backfill existing users.
-- is_first_session = false so the one-time welcome (Slice C) does NOT
-- fire retroactively for users who have already used the platform.
-- ============================================================
INSERT INTO public.user_journey (user_id, tenant_id, started_at, is_first_session)
SELECT
  u.user_id,
  ut.tenant_id,
  COALESCE(u.created_at, now()),
  false
FROM public.app_users u
LEFT JOIN LATERAL (
  SELECT tenant_id FROM public.user_tenants
   WHERE user_id = u.user_id AND is_primary = true
   ORDER BY created_at ASC LIMIT 1
) ut ON true
ON CONFLICT (user_id) DO NOTHING;

COMMIT;
