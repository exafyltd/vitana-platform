-- VTID-02955 (PR-L1.1): fix test_contracts migration.
--
-- The original migration (20260521000000_VTID_02954_test_contracts.sql)
-- used a GENERATED ALWAYS AS expression on the dedupe_key column that
-- cast an enum to text:
--   dedupe_key TEXT GENERATED ALWAYS AS (
--     capability || ':' || service || ':' || contract_type::text
--   ) STORED
-- Postgres rejected with `generation expression is not immutable` because
-- enum-to-text via ::text isn't an IMMUTABLE function (enum labels can
-- theoretically be renamed). The entire CREATE TABLE rolled back, leaving
-- the table missing from production despite RUN-MIGRATION reporting
-- success (the documented psql -f silent-ROLLBACK trap).
--
-- Fix: drop the generated column entirely; use a composite UNIQUE
-- constraint on (capability, service, contract_type) which gives the
-- same dedupe semantics without the IMMUTABLE requirement. The Phase 2
-- missing-test scanner can query by those three columns directly.
--
-- This migration creates the full table from scratch (the original
-- rolled back, so there's nothing to clean up). The original migration
-- file is left in place as a historical record of the wrong approach.

-- ============================================================
-- Enums (re-created idempotently — original migration may have
-- created them before the table CREATE failed)
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'test_contract_type') THEN
    CREATE TYPE test_contract_type AS ENUM (
      'jest',
      'typecheck',
      'live_probe',
      'workflow_check'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'test_contract_status') THEN
    CREATE TYPE test_contract_status AS ENUM (
      'unknown',
      'pass',
      'fail',
      'pending',
      'quarantined'
    );
  END IF;
END $$;

-- ============================================================
-- test_contracts (no generated dedupe_key — UNIQUE on triple instead)
-- ============================================================

CREATE TABLE IF NOT EXISTS test_contracts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  capability               TEXT NOT NULL UNIQUE,
  contract_type            test_contract_type NOT NULL,
  command_key              TEXT NOT NULL,

  -- Target scope
  service                  TEXT NOT NULL,
  environment              TEXT NOT NULL DEFAULT 'dev',
  target_file              TEXT,
  target_endpoint          TEXT,

  -- Contract definition
  expected_behavior        JSONB NOT NULL,
  owner                    TEXT NOT NULL,

  -- Lifecycle state
  status                   test_contract_status NOT NULL DEFAULT 'unknown',
  branch_or_sha            TEXT,
  last_passing_sha         TEXT,
  last_failure_signature   TEXT,
  last_run_at              TIMESTAMPTZ,
  last_status              test_contract_status,

  -- Self-healing posture
  repairable               BOOLEAN NOT NULL DEFAULT true,

  -- Audit
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Dedupe: (capability, service, contract_type) is unique. The Phase 2
  -- missing-test scanner queries by these three columns to avoid creating
  -- duplicate VTIDs for the same capability. capability is ALSO unique
  -- on its own (above), so this constraint is conservative redundancy
  -- against future capability-name collisions where service/type differ.
  CONSTRAINT test_contracts_dedupe_unique UNIQUE (capability, service, contract_type)
);

CREATE INDEX IF NOT EXISTS idx_test_contracts_status        ON test_contracts (status);
CREATE INDEX IF NOT EXISTS idx_test_contracts_service_env   ON test_contracts (service, environment);
CREATE INDEX IF NOT EXISTS idx_test_contracts_owner         ON test_contracts (owner);
CREATE INDEX IF NOT EXISTS idx_test_contracts_last_run_at   ON test_contracts (last_run_at DESC);

-- updated_at trigger
CREATE OR REPLACE FUNCTION test_contracts_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_test_contracts_set_updated_at ON test_contracts;
CREATE TRIGGER trg_test_contracts_set_updated_at
BEFORE UPDATE ON test_contracts
FOR EACH ROW EXECUTE FUNCTION test_contracts_set_updated_at();

-- ============================================================
-- Seed: 6 high-confidence contracts. command_key MUST match an entry
-- in services/gateway/src/services/test-contract-commands.ts COMMAND_ALLOWLIST.
-- ============================================================

INSERT INTO test_contracts (
  capability, contract_type, command_key, service, environment,
  target_file, target_endpoint, expected_behavior, owner, repairable
) VALUES
  (
    'gateway_alive',
    'live_probe',
    'gateway.alive',
    'gateway',
    'dev',
    'services/gateway/src/index.ts',
    '/alive',
    '{"status": 200, "content_type_prefix": "application/json", "json_must_contain": {"status": "ok", "service": "gateway"}}'::jsonb,
    'gateway-core',
    true
  ),
  (
    'canary_target_disarmed_health',
    'live_probe',
    'canary_target.disarmed_health',
    'gateway',
    'dev',
    'services/gateway/src/routes/canary-target.ts',
    '/api/v1/canary-target/health',
    '{"status": 200, "content_type_prefix": "application/json", "json_must_contain": {"ok": true}, "notes": "Asserts the route is mounted and the disarmed path works. Armed-path behavior is exercised via jest, not via live_probe."}'::jsonb,
    'self-healing',
    true
  ),
  (
    'canary_target_status',
    'live_probe',
    'canary_target.status',
    'gateway',
    'dev',
    'services/gateway/src/routes/canary-target.ts',
    '/api/v1/canary-target/status',
    '{"status": 200, "content_type_prefix": "application/json", "json_must_contain": {"ok": true, "config_key": "self_healing_canary_armed"}}'::jsonb,
    'self-healing',
    true
  ),
  (
    'self_healing_active_route_mounted',
    'live_probe',
    'self_healing.active_route_mounted',
    'gateway',
    'dev',
    'services/gateway/src/routes/self-healing.ts',
    '/api/v1/self-healing/active',
    '{"status": [200, 401], "content_type_prefix": "application/json", "notes": "401 is acceptable (auth required) — proves the route is mounted. text/html 404 means the route is NOT mounted."}'::jsonb,
    'self-healing',
    true
  ),
  (
    'oasis_vtid_terminalize_validates_payload',
    'live_probe',
    'oasis.vtid_terminalize_validates_payload',
    'gateway',
    'dev',
    'services/gateway/src/routes/vtid-terminalize.ts',
    '/api/v1/oasis/vtid/terminalize',
    '{"status": [400, 404], "content_type_prefix": "application/json", "notes": "Probed with an intentionally invalid VTID. We assert the gate validates: 400 (VALIDATION_FAILED / INVALID_VTID_FORMAT) or 404 (NOT_FOUND). A 200 here would mean the gate is broken — exact failure mode that hit us today before PR-J."}'::jsonb,
    'self-healing',
    true
  ),
  (
    'worker_orchestrator_await_autopilot_requires_auth',
    'live_probe',
    'worker_orchestrator.await_autopilot_requires_auth',
    'gateway',
    'dev',
    'services/gateway/src/routes/worker-orchestrator.ts',
    '/api/v1/worker/orchestrator/await-autopilot-execution',
    '{"status": [400, 401], "content_type_prefix": "application/json", "notes": "Probed with missing worker_id. We assert auth gating: 400 (missing vtid/exec_id) or 401 (missing worker_id). A 200 would mean the auth gate dropped — security regression."}'::jsonb,
    'self-healing',
    true
  )
ON CONFLICT (capability) DO NOTHING;

-- ============================================================
-- RLS: service_role bypasses; no per-user policies needed.
-- ============================================================

ALTER TABLE test_contracts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE test_contracts IS
  'VTID-02954: Test Contract Registry — the autonomy spine. Every capability has a contract; failures trigger self-healing; missing contracts are scanned and filled. Fixed by VTID-02955 (PR-L1.1).';
