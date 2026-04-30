-- =============================================================================
-- Routines Catalog — persistent record of every Claude Code daily routine
-- =============================================================================
-- A "routine" is a remote Claude Code agent that runs on a cron schedule in an
-- isolated sandbox. It calls Vitana gateway APIs read-only and posts its
-- findings back via POST /api/v1/routines/:name/runs (start) and
-- PATCH /api/v1/routines/:name/runs/:id (finish).
--
-- The Command Hub > Routines screen reads from these two tables.
-- =============================================================================

CREATE TABLE IF NOT EXISTS routines (
  name                  TEXT PRIMARY KEY,
  display_name          TEXT NOT NULL,
  description           TEXT,
  cron_schedule         TEXT NOT NULL,
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_id           UUID,
  last_run_at           TIMESTAMPTZ,
  last_run_status       TEXT
                        CHECK (last_run_status IN ('running', 'success', 'failure', 'partial')),
  last_run_summary      TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS routine_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_name  TEXT NOT NULL REFERENCES routines(name) ON DELETE CASCADE,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  status        TEXT NOT NULL
                CHECK (status IN ('running', 'success', 'failure', 'partial')),
  trigger       TEXT NOT NULL DEFAULT 'cron'
                CHECK (trigger IN ('cron', 'manual')),
  summary       TEXT,
  findings      JSONB,
  artifacts     JSONB,
  error         TEXT,
  duration_ms   INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_routine_runs_routine_started
  ON routine_runs(routine_name, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_routine_runs_status
  ON routine_runs(status);

ALTER TABLE routines       ENABLE ROW LEVEL SECURITY;
ALTER TABLE routine_runs   ENABLE ROW LEVEL SECURITY;

-- Service role has full access (gateway uses SUPABASE_SERVICE_ROLE).
-- Authenticated users get read access via the gateway, not directly.

-- Seed: routine #1 — Self-Healing Pending-Approval Triage
INSERT INTO routines (name, display_name, description, cron_schedule)
VALUES (
  'self-healing-triage',
  'Self-Healing Pending-Approval Triage',
  'Pre-digests every sub-0.8 quarantined fix from the self-healing reconciler into a 6-line Approval Brief with recommendation, rationale, risk note, and similar-fix history. Cuts review time from minutes per row to seconds.',
  '0 4 * * *'
)
ON CONFLICT (name) DO NOTHING;
