-- =============================================================================
-- Proactive Guide — Phase 0 schema foundation
-- Date: 2026-04-18
-- Plan: .claude/plans/lucent-stitching-sextant.md
--
-- Adds the schema primitives the Proactive Guide needs before any behavioral
-- code ships:
--   1. role_scope + contribution_vector on autopilot_recommendations
--   2. user_active_role — single source of truth for multi-role users
--   3. user_journey_overrides — per-user wave customization (Phase 8 Loop 3)
--   4. score_prosperity — 6th pillar on vitana_index_scores
--   5. vitana_index_baseline_survey — onboarding self-report → Day-0 Index
--   6. user_nudge_state — per-nudge rate-limiting + silencing
--   7. user_proactive_pause — the "back off" layer (candidate/session/time/topic)
--   8. system_controls flags for Phase 0.5 through Phase 9
--
-- Dismissal honor is a foundational principle (not a feature). The
-- user_proactive_pause table + flags land here so no proactive code can ship
-- without the respect layer wired.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. autopilot_recommendations: role scoping + Index contribution vectors
-- -----------------------------------------------------------------------------
ALTER TABLE autopilot_recommendations
  ADD COLUMN IF NOT EXISTS role_scope text NOT NULL DEFAULT 'any'
    CHECK (role_scope IN ('community','developer','admin','any'));

ALTER TABLE autopilot_recommendations
  ADD COLUMN IF NOT EXISTS contribution_vector jsonb;

CREATE INDEX IF NOT EXISTS idx_autopilot_recommendations_role_scope
  ON autopilot_recommendations (role_scope, status)
  WHERE status = 'new';

COMMENT ON COLUMN autopilot_recommendations.role_scope IS
  'community | developer | admin | any — clamps candidate to a role context. Default "any" preserves pre-Phase-0 behavior.';

COMMENT ON COLUMN autopilot_recommendations.contribution_vector IS
  'Declared Vitana Index contribution: {physical,mental,nutritional,social,environmental,prosperity, horizon, confidence, cost, goal_link}. Nullable until Phase 3. Used by Guide Engine scorer.';

-- -----------------------------------------------------------------------------
-- 2. user_active_role — SSOT for multi-role users. Role switch invalidates
--    Autopilot popup cache and forces context pack rebuild on next turn.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_active_role (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'community'
    CHECK (role IN ('community','developer','admin')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_active_role ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_active_role_self_rw"
  ON user_active_role FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE user_active_role IS
  'Single source of truth for a user''s currently-selected role. Changed via UI role selector or conversational intent. Triggers cache invalidation in Guide Engine.';

-- -----------------------------------------------------------------------------
-- 3. user_journey_overrides — per-user wave customization from D43 adaptation
--    plans (Phase 8 Loop 3) or manual edits.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_journey_overrides (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wave_id    text NOT NULL,
  overrides  jsonb NOT NULL DEFAULT '{}'::jsonb,
  source     text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','d43_adaptation','admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, wave_id)
);

ALTER TABLE user_journey_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_journey_overrides_self_rw"
  ON user_journey_overrides FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_user_journey_overrides_user_wave
  ON user_journey_overrides (user_id, wave_id);

COMMENT ON TABLE user_journey_overrides IS
  'Per-user wave customization read by journey-calendar-mapper on recompute. Source "d43_adaptation" means written by Phase 8 Loop 3 applier from approved adaptation_plans.';

-- -----------------------------------------------------------------------------
-- 4. Prosperity pillar on vitana_index_scores (6th pillar)
--    Max Index rescales from 999 (5 pillars × 200 - 1) to 1200 (6 × 200).
--    Default 100 = neutral until Phase 1c wires real signals.
-- -----------------------------------------------------------------------------
ALTER TABLE vitana_index_scores
  ADD COLUMN IF NOT EXISTS score_prosperity smallint NOT NULL DEFAULT 100
    CHECK (score_prosperity BETWEEN 0 AND 200);

COMMENT ON COLUMN vitana_index_scores.score_prosperity IS
  '6th Vitana Index pillar — Business Hub progress + marketplace earnings + reward accumulation. Hardcoded 100 until index_prosperity_pillar_enabled flag flips in Phase 1c.';

-- -----------------------------------------------------------------------------
-- 5. vitana_index_baseline_survey — onboarding self-report answers that seed
--    the user's Day-0 Index (Phase 2 of the plan).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vitana_index_baseline_survey (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  answers       jsonb NOT NULL,
  completed_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE vitana_index_baseline_survey ENABLE ROW LEVEL SECURITY;

CREATE POLICY "vitana_index_baseline_survey_self_rw"
  ON vitana_index_baseline_survey FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE vitana_index_baseline_survey IS
  'Onboarding survey answers seeded into Day-0 Index at registration. Phase 2 bootstrap. Self-reported → low confidence, replaced by real signals over time.';

-- -----------------------------------------------------------------------------
-- 6. user_nudge_state — per-nudge rate-limiting and silencing.
--    Used by Guide Engine to respect "skip it", prevent re-surfacing dismissed
--    candidates, and track per-candidate acceptance rates.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_nudge_state (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  nudge_key       text NOT NULL,
  last_shown_at   timestamptz,
  dismissed_at    timestamptz,
  silenced_until  timestamptz,
  show_count      int NOT NULL DEFAULT 0,
  accept_count    int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, nudge_key)
);

ALTER TABLE user_nudge_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_nudge_state_self_rw"
  ON user_nudge_state FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_user_nudge_state_silenced
  ON user_nudge_state (user_id, silenced_until)
  WHERE silenced_until IS NOT NULL;

COMMENT ON TABLE user_nudge_state IS
  'Per-candidate rate-limiting + dismissal state. "skip it" writes silenced_until = now + 24h. Accept/show counts feed Phase 8 Loop 4 learner.';

-- -----------------------------------------------------------------------------
-- 7. user_proactive_pause — dismissal honor system.
--
--    Scopes:
--      all          — blanket pause across all proactive openers
--      category     — mute a domain (e.g., scope_value = 'business_hub')
--      nudge_key    — mute a specific candidate type
--      channel      — mute on voice only or text only (scope_value = 'voice'|'text')
--
--    Voice trigger phrases map to rows here via Phase 0.5
--    dismissal-intent detector. Settings UI (Phase 7) also writes here.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_proactive_pause (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope         text NOT NULL
    CHECK (scope IN ('all','category','nudge_key','channel')),
  scope_value   text,
  paused_from   timestamptz NOT NULL DEFAULT now(),
  paused_until  timestamptz NOT NULL,
  reason        text,
  created_via   text NOT NULL DEFAULT 'voice'
    CHECK (created_via IN ('voice','text','settings')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_proactive_pause_value_required
    CHECK (scope = 'all' OR scope_value IS NOT NULL)
);

ALTER TABLE user_proactive_pause ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_proactive_pause_self_rw"
  ON user_proactive_pause FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Index on (user_id, paused_until) — query filters paused_until > now() at
-- read time; cannot use a partial WHERE clause here because now() is not
-- IMMUTABLE (Postgres rejects it in partial-index predicates).
CREATE INDEX IF NOT EXISTS idx_user_proactive_pause_user_until
  ON user_proactive_pause (user_id, paused_until);

CREATE INDEX IF NOT EXISTS idx_user_proactive_pause_scope
  ON user_proactive_pause (user_id, scope, scope_value, paused_until);

COMMENT ON TABLE user_proactive_pause IS
  'The "back off" layer. Guide Engine MUST check this before emitting any proactive opener. Expired pauses remain as history; app only reads rows with paused_until > now().';

-- -----------------------------------------------------------------------------
-- 8. Feature flags — system_controls
--    All proactive behavior gated. Dismissal honor defaults ENABLED so no
--    proactive code can ship without the respect layer active.
-- -----------------------------------------------------------------------------

INSERT INTO system_controls (key, enabled, scope, reason, expires_at, updated_by, updated_by_role, updated_at)
VALUES
  -- Phase 0.5 — thin proactive opener
  ('vitana_proactive_opener_enabled', FALSE,
   '{"environment": "dev-sandbox"}'::jsonb,
   'Phase 0.5 — thin proactive opener in ORB voice + Assistant. Reads life_compass + calendar_events + autopilot_recommendations.',
   NULL, 'migration', 'system', NOW()),

  -- Dismissal honor — DEFAULT ON. Proactive never ships without respect.
  ('vitana_proactive_dismissal_honor_enabled', TRUE,
   '{"environment": "dev-sandbox"}'::jsonb,
   'Respects "skip it", "not today", "give me space", etc. Writes to user_proactive_pause / user_nudge_state. Non-negotiable — ON from Phase 0.',
   NULL, 'migration', 'system', NOW()),

  -- Phase 1 — Index backbone completion
  ('index_social_pillar_enabled', FALSE,
   '{"environment": "dev-sandbox"}'::jsonb,
   'Phase 1a — compute Social pillar from relationship_nodes + community engagement (currently hardcoded 100).',
   NULL, 'migration', 'system', NOW()),

  ('index_environmental_pillar_enabled', FALSE,
   '{"environment": "dev-sandbox"}'::jsonb,
   'Phase 1b — compute Environmental pillar from health_features_daily + self-reported fields.',
   NULL, 'migration', 'system', NOW()),

  ('index_prosperity_pillar_enabled', FALSE,
   '{"environment": "dev-sandbox"}'::jsonb,
   'Phase 1c — compute Prosperity pillar from Business Hub + marketplace.commerce events + rewards.',
   NULL, 'migration', 'system', NOW()),

  ('index_weights_applied_enabled', FALSE,
   '{"environment": "dev-sandbox"}'::jsonb,
   'Phase 1d — health_compute_vitana_index() RPC multiplies pillars by vitana_index_config.algorithm_weights (currently ignored).',
   NULL, 'migration', 'system', NOW()),

  -- Phase 6 — Guide Engine
  ('vitana_guide_shadow', FALSE,
   '{"environment": "dev-sandbox"}'::jsonb,
   'Phase 6 pre-live — Guide Engine runs in log-only mode for quality review. No user-visible output.',
   NULL, 'migration', 'system', NOW()),

  ('vitana_guide_enabled', FALSE,
   '{"environment": "dev-sandbox"}'::jsonb,
   'Phase 6 — full Guide Engine: contribution-vector scoring, role_agenda in context pack, opener dispatch.',
   NULL, 'migration', 'system', NOW()),

  ('vitana_brain_role_agenda_enabled', FALSE,
   '{"environment": "dev-sandbox"}'::jsonb,
   'Phase 6 — inject role_agenda + active_goal blocks into context-pack-builder output.',
   NULL, 'migration', 'system', NOW()),

  ('agenda_analyzer_community_enabled', FALSE,
   '{"environment": "dev-sandbox"}'::jsonb,
   'Phase 6 — community-journey-analyzer writing to autopilot_recommendations with role_scope=community.',
   NULL, 'migration', 'system', NOW()),

  -- Phase 9 — role analyzers
  ('agenda_analyzer_developer_enabled', FALSE,
   '{"environment": "dev-sandbox"}'::jsonb,
   'Phase 9 — developer-agenda-analyzer (VTIDs, CI-CD, agents_registry, self-healing queue).',
   NULL, 'migration', 'system', NOW()),

  ('agenda_analyzer_admin_enabled', FALSE,
   '{"environment": "dev-sandbox"}'::jsonb,
   'Phase 9 — admin-agenda-analyzer (governance, policy reviews, tenant health).',
   NULL, 'migration', 'system', NOW())
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- =============================================================================
-- Rollback notes (manual — Supabase migrations do not auto-reverse):
--   DROP TABLE user_proactive_pause, user_nudge_state,
--              vitana_index_baseline_survey, user_journey_overrides,
--              user_active_role;
--   ALTER TABLE vitana_index_scores DROP COLUMN score_prosperity;
--   ALTER TABLE autopilot_recommendations
--     DROP COLUMN contribution_vector, DROP COLUMN role_scope;
--   DELETE FROM system_controls WHERE key IN (
--     'vitana_proactive_opener_enabled',
--     'vitana_proactive_dismissal_honor_enabled',
--     'index_social_pillar_enabled','index_environmental_pillar_enabled',
--     'index_prosperity_pillar_enabled','index_weights_applied_enabled',
--     'vitana_guide_shadow','vitana_guide_enabled',
--     'vitana_brain_role_agenda_enabled',
--     'agenda_analyzer_community_enabled',
--     'agenda_analyzer_developer_enabled',
--     'agenda_analyzer_admin_enabled'
--   );
-- =============================================================================
