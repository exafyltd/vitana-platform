-- VTID-02958 (PR-L3): Failure Scanner — test_contract_runs history table.
--
-- Per-run record so the scheduled runner can:
--   1. Detect consecutive same-signature failures (debounce against flake)
--   2. Count repair attempts per contract (auto-quarantine on 3 in 24h)
--   3. Show a run-history mini-timeline on the cockpit
--
-- Per the test-contract-backbone plan, PR-L3 is the moment the loop
-- actually closes: contracts run on schedule → failures trigger repair
-- VTIDs → existing dev_autopilot pipeline produces a real PR → reconciler
-- terminalizes when CI + deploy + verify pass and the contract returns
-- to status='pass'.

CREATE TABLE IF NOT EXISTS test_contract_runs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id              UUID NOT NULL REFERENCES test_contracts(id) ON DELETE CASCADE,

  -- Result
  passed                   BOOLEAN NOT NULL,
  status_code              INTEGER,
  content_type             TEXT,
  duration_ms              INTEGER NOT NULL DEFAULT 0,
  failure_reason           TEXT,
  body_excerpt             TEXT,
  -- sha256(command_key + first error line) — identical signatures across
  -- consecutive runs mean "same failure, not flake" → repair worth attempting
  failure_signature        TEXT,

  -- Provenance
  dispatched_by            TEXT NOT NULL DEFAULT 'scheduled_runner',
    -- 'scheduled_runner' | 'manual_admin' | 'self_healing_reconciler'
  dispatched_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Linkage to repair work (filled in when a failure triggers a VTID)
  repair_vtid              TEXT,
  repair_recommendation_id UUID,

  -- Free-form context the failing-test repair LLM uses (e.g. expected_behavior
  -- at time of run, body diff vs last_passing_sha if available, etc.)
  run_metadata             JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_test_contract_runs_contract_id_recent
  ON test_contract_runs (contract_id, dispatched_at DESC);

CREATE INDEX IF NOT EXISTS idx_test_contract_runs_failure_signature
  ON test_contract_runs (failure_signature)
  WHERE failure_signature IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_test_contract_runs_repair_vtid
  ON test_contract_runs (repair_vtid)
  WHERE repair_vtid IS NOT NULL;

-- Service-role accesses directly; no per-user reads expected.
ALTER TABLE test_contract_runs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE test_contract_runs IS
  'VTID-02958: per-run history of test_contracts executions. Drives debounce (consecutive failures), quarantine (3 repair attempts in 24h), and the cockpit history strip.';
