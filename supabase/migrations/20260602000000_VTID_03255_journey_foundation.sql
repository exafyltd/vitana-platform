-- =============================================================================
-- VTID-03255 — Journey Foundation (P1, read path)
-- -----------------------------------------------------------------------------
-- The Journey Foundation is the goal-gated, dual-axis (health + longevity
-- economy) guided onboarding path. Vitana drives it by voice; the "My Journey"
-- / "Meine Reise" screens mirror it. The single source of truth for whether a
-- foundation STEP is done stays with each feature's own table (life_compass,
-- reminders, memory_diary_entries, calendar_events, vitana_index_baseline_survey,
-- autopilot_recommendations, user_connections, profiles) — the verifier reads
-- them live every request. These two tables hold ONLY thin journey state:
--   1. user_journey_foundation  — one row/user: gate state + cursor + economy
--      intent. completed_steps_cache is a hint, never authoritative.
--   2. journey_session_updates  — one row/voice-session: what got done, what's
--      next, and a one-line summary surfaced on the next "Meine Reise" open.
--
-- NOTE (diagnose-before-edit): life_compass already carries target_date /
-- target_value / target_unit / starting_value in production, so days_left is
-- derived from the existing column set — this migration adds NO life_compass
-- columns. economic_axis on autopilot_recommendations is a recommendation
-- labeling column with different semantics; the user's economy stance lives in
-- user_journey_foundation.economic_intent and is never conflated with it.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. user_journey_foundation — one row per user
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_journey_foundation (
  user_id               uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Set the moment the dual-axis gate passes (health goal AND economic_intent
  -- present). NULL means the journey has not started yet.
  journey_started_at    timestamptz,
  -- Cursor hint for the current next step. Authoritative next-step is computed
  -- live by journey-foundation-next-step; this caches the last computed value
  -- so the screen can render instantly before the verifier completes.
  current_next_step     text,
  -- Gate beat B: the user's economy stance. 'curious' satisfies the gate —
  -- nobody is blocked, but everybody declares a stance.
  economic_intent       text
    CHECK (economic_intent IS NULL OR economic_intent IN
      ('build_business','passive_income','earn_recommendations','curious')),
  -- Weakest-habit answer (Tier 1) — pillar key the user named as blocking them
  -- most. Later refined by the Vitana Index weakest_pillar.
  focus_pillar          text,
  -- Hint cache of step keys the verifier last reported done. NEVER trusted for
  -- gating — verify-live against each feature table is the source of truth.
  completed_steps_cache text[] NOT NULL DEFAULT '{}',
  metadata              jsonb  NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_journey_foundation ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_journey_foundation_self_rw" ON user_journey_foundation;
CREATE POLICY "user_journey_foundation_self_rw"
  ON user_journey_foundation FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE user_journey_foundation IS
  'VTID-03255 — thin per-user Journey Foundation state (gate + cursor + economy intent). Step completion is verified live against each feature table, never read from completed_steps_cache.';

-- -----------------------------------------------------------------------------
-- 2. journey_session_updates — one row per voice session
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journey_session_updates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id      text,
  completed_steps text[] NOT NULL DEFAULT '{}',
  next_step       text,
  summary         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE journey_session_updates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "journey_session_updates_self_rw" ON journey_session_updates;
CREATE POLICY "journey_session_updates_self_rw"
  ON journey_session_updates FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_journey_session_updates_user_created
  ON journey_session_updates (user_id, created_at DESC);

COMMENT ON TABLE journey_session_updates IS
  'VTID-03255 — per-session journey summary written at voice-session end (P3). The most recent row feeds the "Seit dem letzten Gespraech erledigt: ..." line on the next Meine Reise open and the morning greeting.';

COMMIT;
