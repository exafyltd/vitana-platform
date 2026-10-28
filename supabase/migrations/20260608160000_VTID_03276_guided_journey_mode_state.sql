-- =============================================================================
-- VTID-03276 — Guided Journey: durable Guided/Full mode + onboarding state (P1)
-- -----------------------------------------------------------------------------
-- The Guided Journey is an ADDITIVE onboarding UX layer over the existing Full
-- App. This table holds the durable, per-user UX state that drives it:
--   * mode                — 'guided' | 'full' (which UX shell the user sees)
--   * onboarding lifecycle — not_started → in_progress → qualified/skipped/completed
--   * practice progress    — current usage session + completed topics/practice count
--   * qualification        — threshold + the moment the user qualified
--   * audit timestamps     — first full-mode entry, return-to-guided, skip
--
-- BOUNDARY CONTRACT (from the design spec — do NOT violate):
--   This is PRODUCT/UX state ONLY. It must never hold or be conflated with:
--     - subscription        (commercial entitlement)  → its own billing system
--     - feature_permission  (access control / release) → its own system
--   Journey mode is never derived from, and never derives, those two. Switching
--   mode NEVER deletes progress (completed topics, current session, qualification
--   all survive a guided⇄full round-trip).
--
-- DIAGNOSE-BEFORE-EDIT: production already has user_journey (ORB/voice journey
-- state: waves, milestones, greeting cadence) and user_journey_foundation
-- (VTID-03255 thin foundation-steps holder). Neither models guided/full UX mode,
-- so this is a NEW dedicated table rather than an overload of either — keeping
-- the four state boundaries (mode / progress / subscription / permission) clean.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS user_guided_journey_state (
  user_id                  uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Which UX shell the user is in. New users start guided; existing/qualified
  -- users live in full. Switching is reversible and lossless.
  mode                     text NOT NULL DEFAULT 'guided'
    CHECK (mode IN ('guided','full')),
  -- Onboarding lifecycle. 'skipped' = chose Full App before qualifying;
  -- 'qualified' = hit the practice threshold; 'completed' = finished curriculum.
  onboarding_status        text NOT NULL DEFAULT 'not_started'
    CHECK (onboarding_status IN ('not_started','in_progress','qualified','skipped','completed')),
  -- Usage session the user is currently on (NOT a calendar day). Always >= 1.
  current_session          integer NOT NULL DEFAULT 1
    CHECK (current_session >= 1),
  -- Topic IDs whose guided-practice action is done. Denormalized convenience for
  -- the catalog; per-topic granular progress lands with the checklist (P2/P5).
  completed_topic_ids      text[] NOT NULL DEFAULT '{}',
  -- Count of completed guided-practice actions (drives qualification).
  completed_practice_count integer NOT NULL DEFAULT 0
    CHECK (completed_practice_count >= 0),
  -- First-stage qualification target (spec default: 60 practice actions).
  qualification_threshold  integer NOT NULL DEFAULT 60
    CHECK (qualification_threshold >= 1),
  -- Set when completed_practice_count first reaches the threshold.
  qualified_at             timestamptz,
  -- Set the first time the user chooses Full App before qualifying.
  skipped_onboarding_at    timestamptz,
  -- Set the first time the user enters Full App mode.
  entered_full_mode_at     timestamptz,
  -- Set whenever the user switches back to Guided.
  returned_to_guided_at    timestamptz,
  -- Resume hint: last topic the user opened.
  last_opened_topic_id     text,
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_guided_journey_state ENABLE ROW LEVEL SECURITY;

-- Per-user self read/write. The gateway uses the service-role key (bypasses RLS);
-- this policy guards any direct anon/auth client access to a user's own row only.
DROP POLICY IF EXISTS "user_guided_journey_state_self_rw" ON user_guided_journey_state;
CREATE POLICY "user_guided_journey_state_self_rw"
  ON user_guided_journey_state FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE user_guided_journey_state IS
  'VTID-03276 — Guided Journey durable per-user UX state: guided|full mode + onboarding lifecycle + practice qualification. PRODUCT/UX state ONLY; never holds subscription (commercial entitlement) or feature_permission (access control), and mode is never derived from either. Switching mode never deletes progress.';

COMMIT;
