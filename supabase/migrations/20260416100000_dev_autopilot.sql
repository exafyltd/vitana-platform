-- =============================================================================
-- Developer Autopilot — queue, planning, execution, failure bridge
-- =============================================================================
-- Adds the schema for the self-improving loop:
--   dev_autopilot_runs         — one row per 2x/day scan
--   dev_autopilot_signals      — raw scanner output, deduped by fingerprint
--   dev_autopilot_plan_versions — versioned plan_markdown per finding
--   dev_autopilot_executions   — approved auto-exec lifecycle rows (including
--                                self-heal child attempts linked via
--                                parent_execution_id / auto_fix_depth)
--   dev_autopilot_config       — singleton config row (kill switch, budgets,
--                                allow/deny scope, concurrency, depth cap)
--
-- Extends autopilot_recommendations with columns so Dev Autopilot findings live
-- in the same queue as community recommendations but carry full lineage back
-- to their source scan run + forward to PR / deploy / self-heal outcomes.
--
-- Registers the Dev Autopilot agent in agents_registry as a scheduled-tier
-- agent with 12h heartbeat decay (runs 2x/day).
--
-- Plan: /home/dstev/.claude/plans/quirky-jumping-fairy.md
-- =============================================================================

-- =============================================================================
-- Step 1: Extend autopilot_recommendations for dev_autopilot source
-- =============================================================================
ALTER TABLE autopilot_recommendations
  ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'community'
    CHECK (source_type IN ('community', 'dev_autopilot', 'system')),
  ADD COLUMN IF NOT EXISTS source_run_id UUID,
  ADD COLUMN IF NOT EXISTS risk_class TEXT
    CHECK (risk_class IN ('low', 'medium', 'high')),
  ADD COLUMN IF NOT EXISTS auto_exec_eligible BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pr_url TEXT,
  ADD COLUMN IF NOT EXISTS pr_merged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deploy_status TEXT,
  ADD COLUMN IF NOT EXISTS deploy_outcome_event_id UUID,
  ADD COLUMN IF NOT EXISTS seen_count INT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS auto_archive_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS signal_fingerprint TEXT;

-- Extend status enum to allow dev-autopilot-specific states without breaking
-- existing rows. The original constraint stays logically intact for
-- source_type='community' rows because they only use {new,activated,rejected,snoozed}.
ALTER TABLE autopilot_recommendations DROP CONSTRAINT IF EXISTS autopilot_recommendations_status_check;
ALTER TABLE autopilot_recommendations
  ADD CONSTRAINT autopilot_recommendations_status_check
  CHECK (status IN ('new', 'activated', 'rejected', 'snoozed', 'auto_archived'));

-- Queue-level dedup: same fingerprint never re-inserts while finding is live.
-- Partial unique index so activated/rejected rows don't block future rescans.
CREATE UNIQUE INDEX IF NOT EXISTS uq_autopilot_dev_fingerprint_active
  ON autopilot_recommendations(source_type, signal_fingerprint)
  WHERE source_type = 'dev_autopilot'
    AND signal_fingerprint IS NOT NULL
    AND status IN ('new', 'snoozed');

CREATE INDEX IF NOT EXISTS idx_autopilot_dev_queue
  ON autopilot_recommendations(source_type, status, last_seen_at DESC)
  WHERE source_type = 'dev_autopilot';

CREATE INDEX IF NOT EXISTS idx_autopilot_dev_archive
  ON autopilot_recommendations(source_type, status, last_seen_at)
  WHERE source_type = 'dev_autopilot' AND status = 'new';

-- =============================================================================
-- Step 2: Scan runs
-- =============================================================================
CREATE TABLE IF NOT EXISTS dev_autopilot_runs (
  run_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'ingesting', 'ranking', 'planning', 'done', 'failed')),
  signal_count        INT NOT NULL DEFAULT 0,
  new_finding_count   INT NOT NULL DEFAULT 0,
  updated_finding_count INT NOT NULL DEFAULT 0,
  ranking_session_id  TEXT,
  triggered_by        TEXT,                     -- github_actions | manual | api
  error               TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_dev_autopilot_runs_started
  ON dev_autopilot_runs(started_at DESC);

-- =============================================================================
-- Step 3: Raw signals from scanners (preserved for dedup + audit)
-- =============================================================================
CREATE TABLE IF NOT EXISTS dev_autopilot_signals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              UUID NOT NULL REFERENCES dev_autopilot_runs(run_id) ON DELETE CASCADE,
  type                TEXT NOT NULL,
  severity            TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  file_path           TEXT,
  line_number         INT,
  message             TEXT NOT NULL,
  suggested_action    TEXT,
  fingerprint         TEXT NOT NULL,
  scanner             TEXT,                     -- knip | ts-prune | madge | sonarjs | depcheck | codebase-analyzer
  raw                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dev_autopilot_signals_run
  ON dev_autopilot_signals(run_id);
CREATE INDEX IF NOT EXISTS idx_dev_autopilot_signals_fingerprint
  ON dev_autopilot_signals(fingerprint);

-- =============================================================================
-- Step 4: Plan versions
-- =============================================================================
CREATE TABLE IF NOT EXISTS dev_autopilot_plan_versions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id          UUID NOT NULL REFERENCES autopilot_recommendations(id) ON DELETE CASCADE,
  version             INT NOT NULL,
  plan_markdown       TEXT NOT NULL,
  plan_html           TEXT,                     -- server-rendered sanitized HTML for UI
  planning_session_id TEXT,                     -- Managed Agents session id
  feedback_note       TEXT,                     -- user's "continue planning" feedback for v > 1
  files_referenced    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (finding_id, version)
);

CREATE INDEX IF NOT EXISTS idx_dev_autopilot_plan_versions_finding
  ON dev_autopilot_plan_versions(finding_id, version DESC);

-- =============================================================================
-- Step 5: Executions (root + self-heal children)
-- =============================================================================
CREATE TABLE IF NOT EXISTS dev_autopilot_executions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id                UUID NOT NULL REFERENCES autopilot_recommendations(id) ON DELETE CASCADE,
  plan_version              INT NOT NULL,

  -- Lifecycle
  status                    TEXT NOT NULL DEFAULT 'queued'
                              CHECK (status IN (
                                'queued',        -- awaiting concurrency slot
                                'cooling',       -- in 10-min cancel window
                                'cancelled',
                                'running',       -- execution agent editing + pushing
                                'ci',            -- waiting on CI checks
                                'merging',       -- auto-merging after CI green
                                'deploying',     -- AUTO-DEPLOY → EXEC-DEPLOY
                                'verifying',     -- post-deploy verification window
                                'completed',     -- clean deploy, verification passed
                                'failed',        -- terminal failure outside bridge scope
                                'reverted',      -- auto-revert ran, bridged to self-healing
                                'self_healed',   -- self-heal child succeeded; this lineage closed
                                'failed_escalated' -- depth cap or hard fail, escalated as new finding
                              )),

  -- Scheduling / safety
  approved_by               UUID,                -- user_id who approved
  approved_at               TIMESTAMPTZ,
  execute_after             TIMESTAMPTZ,         -- approved_at + cooldown_minutes
  cancelled_at              TIMESTAMPTZ,
  execution_session_id      TEXT,                -- Managed Agents session id

  -- Output
  branch                    TEXT,
  pr_url                    TEXT,
  pr_number                 INT,
  revert_pr_url             TEXT,

  -- Failure bridge
  failure_stage             TEXT CHECK (failure_stage IN ('ci', 'deploy', 'verification')),
  failure_event_id          UUID,
  parent_execution_id       UUID REFERENCES dev_autopilot_executions(id),
  auto_fix_depth            INT NOT NULL DEFAULT 0,
  self_healing_vtid         TEXT,
  triage_report             JSONB,

  -- Timestamps
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at              TIMESTAMPTZ,

  metadata                  JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_dev_autopilot_exec_finding
  ON dev_autopilot_executions(finding_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dev_autopilot_exec_status
  ON dev_autopilot_executions(status, execute_after);
CREATE INDEX IF NOT EXISTS idx_dev_autopilot_exec_parent
  ON dev_autopilot_executions(parent_execution_id);
CREATE INDEX IF NOT EXISTS idx_dev_autopilot_exec_self_healing_vtid
  ON dev_autopilot_executions(self_healing_vtid)
  WHERE self_healing_vtid IS NOT NULL;

-- Keep updated_at fresh
CREATE OR REPLACE FUNCTION touch_dev_autopilot_executions()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_dev_autopilot_executions ON dev_autopilot_executions;
CREATE TRIGGER trg_touch_dev_autopilot_executions
  BEFORE UPDATE ON dev_autopilot_executions
  FOR EACH ROW EXECUTE FUNCTION touch_dev_autopilot_executions();

-- =============================================================================
-- Step 6: Singleton config
-- =============================================================================
CREATE TABLE IF NOT EXISTS dev_autopilot_config (
  id                                      INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  kill_switch                             BOOLEAN NOT NULL DEFAULT FALSE,
  daily_budget                            INT NOT NULL DEFAULT 10,
  cooldown_minutes                        INT NOT NULL DEFAULT 10,
  concurrency_cap                         INT NOT NULL DEFAULT 2,
  auto_archive_days                       INT NOT NULL DEFAULT 30,
  reject_suppression_days                 INT NOT NULL DEFAULT 30,
  eager_plan_top_k                        INT NOT NULL DEFAULT 5,
  select_all_cap                          INT NOT NULL DEFAULT 20,
  max_auto_fix_depth                      INT NOT NULL DEFAULT 2,
  post_deploy_verification_window_minutes INT NOT NULL DEFAULT 15,
  allow_scope                             JSONB NOT NULL DEFAULT
    '["services/gateway/src/routes/**",
      "services/gateway/src/services/**",
      "services/gateway/src/types/**",
      "services/gateway/src/frontend/command-hub/**",
      "services/gateway/test/**",
      "services/gateway/tests/**",
      "services/agents/**"]'::jsonb,
  deny_scope                              JSONB NOT NULL DEFAULT
    '["supabase/migrations/**",
      "**/auth*",
      "**/orb-live.ts",
      ".github/workflows/**",
      "services/gateway/src/lib/supabase.ts",
      "**/.env*",
      "**/credentials*"]'::jsonb,
  updated_at                              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO dev_autopilot_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- Step 7: RLS — service role writes, authenticated dev role reads
-- =============================================================================
ALTER TABLE dev_autopilot_runs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_autopilot_signals       ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_autopilot_plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_autopilot_executions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_autopilot_config        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dev_autopilot_runs_service ON dev_autopilot_runs;
CREATE POLICY dev_autopilot_runs_service ON dev_autopilot_runs FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS dev_autopilot_signals_service ON dev_autopilot_signals;
CREATE POLICY dev_autopilot_signals_service ON dev_autopilot_signals FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS dev_autopilot_plan_versions_service ON dev_autopilot_plan_versions;
CREATE POLICY dev_autopilot_plan_versions_service ON dev_autopilot_plan_versions FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS dev_autopilot_executions_service ON dev_autopilot_executions;
CREATE POLICY dev_autopilot_executions_service ON dev_autopilot_executions FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS dev_autopilot_config_service ON dev_autopilot_config;
CREATE POLICY dev_autopilot_config_service ON dev_autopilot_config FOR ALL TO service_role USING (true);

-- =============================================================================
-- Step 8: Auto-archive job (daily via pg_cron if available; no-op if absent)
-- =============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'dev-autopilot-auto-archive',
      '23 3 * * *',  -- daily 03:23 UTC
      $cron$
        UPDATE autopilot_recommendations
        SET status = 'auto_archived',
            updated_at = NOW()
        WHERE source_type = 'dev_autopilot'
          AND status = 'new'
          AND last_seen_at < NOW() - (
            COALESCE((SELECT auto_archive_days FROM dev_autopilot_config WHERE id = 1), 30)
            * INTERVAL '1 day'
          );
      $cron$
    );
  END IF;
END $$;

-- =============================================================================
-- Step 9: Register Dev Autopilot in agents_registry (scheduled tier)
-- =============================================================================
INSERT INTO agents_registry
  (agent_id, display_name, description, tier, role, llm_provider, llm_model, source_path, health_endpoint, metadata)
VALUES
  ('dev-autopilot',
   'Developer Autopilot',
   'Twice-daily codebase scan + plan + autonomous execution loop. Routes failures into self-healing via processExecutionFailure.',
   'scheduled', 'self-improvement', 'claude', 'managed-agents',
   'services/gateway/src/services/dev-autopilot-synthesis.ts', '/api/v1/dev-autopilot/runs',
   jsonb_build_object(
     'cron', '0 6,18 * * *',
     'decay_hours', 12,
     'plan', '.claude/plans/quirky-jumping-fairy.md'
   ))
ON CONFLICT (agent_id) DO UPDATE SET
  description = EXCLUDED.description,
  source_path = EXCLUDED.source_path,
  health_endpoint = EXCLUDED.health_endpoint,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- =============================================================================
-- End of Dev Autopilot migration
-- =============================================================================
