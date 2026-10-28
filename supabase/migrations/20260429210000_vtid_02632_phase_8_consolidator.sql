-- =============================================================================
-- VTID-02632 — Phase 8 — Nightly consolidator + Loops 3/4/10-14 + Cognee deprecation
--
-- Final phase of the Memory Architecture Rebuild plan. Adds:
--
--   1) consolidator_runs           — audit log for every nightly job execution
--   2) index_delta_observations    — Loop 4 (Index-Delta-Learner): per-completion
--                                    pillar delta observations that calibrate the
--                                    autopilot ranker priors over time
--   3) vitana_index_trajectory_snapshots — Loop 4: rolled-up daily snapshots that
--                                    power the journey/narrative views
--   4) drift_adaptation_plans      — Loop 3 (D43→journey): when D43 detects drift
--                                    on a Life Compass goal, an adaptation plan
--                                    is queued here for the autopilot brain to
--                                    pick up at next session
--
-- All tables are tenant+user scoped, RLS-enabled, and have indexes for the
-- per-user time-series queries the consolidator and brain perform.
--
-- Plan reference: .claude/plans/the-vitana-system-has-wild-puffin.md (Part 8 — Phase 8)
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- consolidator_runs — every nightly run leaves a row here
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consolidator_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by    text NOT NULL CHECK (triggered_by IN ('cron', 'admin', 'self_heal')),
  triggered_at    timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  status          text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'success', 'partial', 'failed')),
  -- Per-loop summary: { loop_10_diary: { processed: N, errors: 0 }, ... }
  summary         jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message   text,
  -- Tenant scope: NULL = all tenants in one run; UUID = scoped run
  tenant_id       uuid
);

CREATE INDEX IF NOT EXISTS idx_consolidator_runs_triggered_at
  ON consolidator_runs (triggered_at DESC);

COMMENT ON TABLE consolidator_runs IS
  'VTID-02632 — Phase 8 — audit log for nightly consolidator runs. Each loop reports its processed count + error count into summary jsonb.';

-- -----------------------------------------------------------------------------
-- index_delta_observations — Loop 4: action -> pillar delta
-- -----------------------------------------------------------------------------
-- One row per autopilot action completion. Captures the Index pillar movement
-- attributed to that action so the ranker can update its priors.
CREATE TABLE IF NOT EXISTS index_delta_observations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  user_id               uuid NOT NULL,
  -- Source action that produced the observation
  recommendation_id     uuid,
  action_kind           text NOT NULL,        -- e.g. 'autopilot_completion', 'diary_entry', 'manual_log'
  pillar                text NOT NULL,        -- nutrition | hydration | exercise | sleep | mental
  -- Observed Index movement
  pillar_score_before   numeric,
  pillar_score_after    numeric,
  pillar_delta          numeric,              -- after - before
  -- Total Index movement (informational; the ranker uses pillar_delta)
  total_score_before    numeric,
  total_score_after     numeric,
  total_delta           numeric,
  -- Ranker context — what priors were active when this action was suggested
  ranker_config_version text,
  observed_at           timestamptz NOT NULL DEFAULT now(),
  -- Free-form provenance
  source_engine         text,
  notes                 text
);

CREATE INDEX IF NOT EXISTS idx_index_delta_obs_user
  ON index_delta_observations (tenant_id, user_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_index_delta_obs_pillar
  ON index_delta_observations (pillar, observed_at DESC);

ALTER TABLE index_delta_observations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "index_delta_obs_self" ON index_delta_observations;
CREATE POLICY "index_delta_obs_self"
  ON index_delta_observations FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE index_delta_observations IS
  'VTID-02632 Loop 4 — per-action Index pillar deltas. Ranker priors are recalibrated nightly off these observations.';

-- -----------------------------------------------------------------------------
-- vitana_index_trajectory_snapshots — Loop 4: daily rolled-up snapshots
-- -----------------------------------------------------------------------------
-- One row per (user, day). Powers the 30/90-day trajectory views and the
-- agent profile's "30-day movement" line.
CREATE TABLE IF NOT EXISTS vitana_index_trajectory_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  user_id         uuid NOT NULL,
  snapshot_date   date NOT NULL,
  score_total     numeric,
  score_pillars   jsonb NOT NULL DEFAULT '{}'::jsonb,    -- { nutrition: 80, ... }
  balance_factor  numeric,
  tier            text,
  -- Number of rolling-30-day actions that contributed
  actions_30d     int NOT NULL DEFAULT 0,
  source_engine   text,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_index_trajectory_user_date
  ON vitana_index_trajectory_snapshots (tenant_id, user_id, snapshot_date DESC);

ALTER TABLE vitana_index_trajectory_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "vitana_idx_traj_self" ON vitana_index_trajectory_snapshots;
CREATE POLICY "vitana_idx_traj_self"
  ON vitana_index_trajectory_snapshots FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE vitana_index_trajectory_snapshots IS
  'VTID-02632 Loop 4 — daily Vitana Index snapshot per user. Cheaper to query than aggregating raw events for trajectory views.';

-- -----------------------------------------------------------------------------
-- drift_adaptation_plans — Loop 3 (D43 drift -> adaptation plan)
-- -----------------------------------------------------------------------------
-- When the D43 drift detector observes goal-trajectory drift, it queues a
-- plan here. The autopilot brain reads pending plans at session open and
-- adapts the next-action recommendations accordingly.
CREATE TABLE IF NOT EXISTS drift_adaptation_plans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  user_id           uuid NOT NULL,
  goal_id           uuid,                                -- life_compass_goals.id
  drift_kind        text NOT NULL,                       -- 'pillar_decline' | 'engagement_drop' | 'streak_lost'
  detected_pillar   text,                                -- which pillar drifted
  drift_magnitude   numeric,                             -- how much, signed
  observation_window_days int NOT NULL DEFAULT 14,
  recommended_actions jsonb NOT NULL DEFAULT '[]'::jsonb, -- array of action descriptors
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'applied', 'expired', 'cancelled')),
  detected_at       timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  applied_at        timestamptz,
  source_engine     text NOT NULL DEFAULT 'consolidator.loop_3'
);

CREATE INDEX IF NOT EXISTS idx_drift_plans_user_status
  ON drift_adaptation_plans (tenant_id, user_id, status, detected_at DESC);

ALTER TABLE drift_adaptation_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "drift_plans_self" ON drift_adaptation_plans;
CREATE POLICY "drift_plans_self"
  ON drift_adaptation_plans FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE drift_adaptation_plans IS
  'VTID-02632 Loop 3 — D43 drift events promoted to adaptation plans. Brain reads pending plans at session open.';

-- -----------------------------------------------------------------------------
-- Seed default flags for Phase 8 (idempotent). system_controls schema is
-- (key, enabled bool, scope jsonb, reason text, ...).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='system_controls') THEN
    RAISE NOTICE 'system_controls table not present — skipping flag seed';
    RETURN;
  END IF;

  INSERT INTO system_controls (key, enabled, scope, reason)
  VALUES
    ('consolidator_enabled', true, '{"environment":"production"}'::jsonb,
     'Phase 8 — master flag for the nightly consolidator. Off = manual admin runs only.'),
    ('cognee_extraction_enabled', false, '{"environment":"production"}'::jsonb,
     'Phase 8 — Cognee deprecation flag. When false, cognee-extractor-client becomes a no-op (legacy code frozen per CLAUDE.md governance).'),
    ('index_delta_learner_enabled', true, '{"environment":"production"}'::jsonb,
     'Phase 8 Loop 4 — write index_delta_observations on autopilot completion.')
  ON CONFLICT (key) DO NOTHING;
END $$;

COMMIT;
