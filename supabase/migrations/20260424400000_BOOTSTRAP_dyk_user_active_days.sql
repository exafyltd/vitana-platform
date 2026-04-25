-- =============================================================================
-- user_active_days — distinct active usage-day tracker for the Did-You-Know tour
-- Plan: .claude/plans/proactive-did-you-generic-sifakis.md
-- Date: 2026-04-24
-- BOOTSTRAP-DYK-TOUR
--
-- Why: the Proactive "Did You Know" 30-day guided tour must gate on *usage*
-- days, not calendar days. A user who signs up, uses the app once, then
-- returns a month later is on usage-day 2 of the tour — not day 31. We need
-- a cheap distinct-days-active counter per user.
--
-- Write path: the JWT auth middleware fires `INSERT ... ON CONFLICT DO NOTHING`
-- on every authenticated request. The (user_id, active_date) composite PK
-- dedupes within the same UTC date — at most one row per user per day, at
-- most one no-op collision per subsequent request.
--
-- Read path: `SELECT count(*) FROM user_active_days WHERE user_id = ?`.
-- The primary-key index covers the filter; no additional index needed.
--
-- Retention: none. One row per user per active date is ~365 rows/user/year,
-- trivial. If pruning is ever needed, deleting rows older than (signup + 30d)
-- only affects tour logic, not any other feature.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_active_days (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  active_date DATE NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, active_date)
);

COMMENT ON TABLE public.user_active_days IS
  'Distinct UTC dates on which a user had an authenticated session. Drives the Did-You-Know 30-usage-day tour curriculum gating. Upserted from gateway JWT auth middleware.';
COMMENT ON COLUMN public.user_active_days.first_seen_at IS
  'First authenticated request timestamp for this user on this UTC date.';

-- RLS: read-only for the user themselves; the auth middleware writes via
-- SUPABASE_SERVICE_ROLE which bypasses RLS.
ALTER TABLE public.user_active_days ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_active_days_self_read ON public.user_active_days;
CREATE POLICY user_active_days_self_read ON public.user_active_days
  FOR SELECT
  USING (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- Feature flag: vitana_did_you_know_enabled (default FALSE)
-- Flipped to TRUE via system_controls UI after Phase 2 voice smoke test.
-- Checked in presence-did-you-know route AND in orb-live.ts tour_hint injection.
-- -----------------------------------------------------------------------------
INSERT INTO public.system_controls (key, enabled, scope, reason, expires_at, updated_by, updated_by_role, updated_at)
VALUES (
  'vitana_did_you_know_enabled',
  FALSE,
  '{"environment": "dev-sandbox"}'::jsonb,
  'BOOTSTRAP-DYK-TOUR — Proactive "Did You Know" 30-usage-day guided tour. Index-centric curriculum, voice-first via ORB with silent card fallback. Plan: .claude/plans/proactive-did-you-generic-sifakis.md',
  NULL,
  'migration',
  'system',
  NOW()
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
