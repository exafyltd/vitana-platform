-- =============================================================================
-- VTID-01936 (Companion Phase C): User routines extracted from calendar_events
-- Date: 2026-04-19
--
-- Stores routine/rhythm patterns the pattern-extractor derives from each
-- user's calendar_events history. Brain reads these to mention naturally
-- ("I noticed you usually do diary on Sundays — want to keep that rhythm?").
--
-- Why a NEW table instead of extending memory_garden_nodes:
-- The existing memory_garden_nodes table has TWO conflicting CREATE TABLE
-- migrations (vtid_01085 + vtid_01082) with different node_type CHECK
-- constraints. Reusing it would risk constraint violations. user_routines
-- is a clean surface for Phase C — pattern-extractor writes here exclusively.
--
-- routine_kind values:
--   time_of_day_preference  — user prefers morning/afternoon/evening for X
--   day_of_week_rhythm      — user reliably does X on Mondays/etc
--   category_affinity       — user engages with category Y much more than Z
--   wave_velocity           — user moves through 90-day waves faster/slower than median
--   completion_streak       — user has N-day completion streak in category
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS user_routines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  routine_kind    text NOT NULL
    CHECK (routine_kind IN (
      'time_of_day_preference',
      'day_of_week_rhythm',
      'category_affinity',
      'wave_velocity',
      'completion_streak'
    )),
  routine_key     text NOT NULL,                     -- stable per (user, kind)
  title           text NOT NULL,                     -- "morning preference"
  summary         text NOT NULL,                     -- "you do 80% of activities before 10am"
  evidence_count  int NOT NULL DEFAULT 1,
  confidence      numeric NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  metadata        jsonb DEFAULT '{}'::jsonb,
  first_observed  timestamptz NOT NULL DEFAULT now(),
  last_observed   timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, routine_kind, routine_key)
);

ALTER TABLE user_routines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_routines_self_rw"
  ON user_routines FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_user_routines_user_kind
  ON user_routines (user_id, routine_kind, confidence DESC);

COMMENT ON TABLE user_routines IS
  'VTID-01936 Companion Phase C — routine patterns extracted from calendar_events. Brain reads to weave naturally ("you usually X on Y day").';

COMMIT;
