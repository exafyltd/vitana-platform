-- VTID-02970 (PR-L5): Pattern memory — the autonomy-spine multiplier.
--
-- Phase 5 of the Test Contract Backbone plan. Every successful repair
-- (failure scanner allocates VTID → autopilot writes PR → CI green →
-- deploy → contract returns to pass) is anchored to a fault_signature
-- and a fix_diff. We store both. The next time the same signature
-- shows up — possibly on a DIFFERENT capability whose target_file
-- shares the same anti-pattern — we can fast-track the repair using
-- the known-good diff instead of starting LLM diagnosis from scratch.
--
-- This migration ships the storage. PR-L5 v1 wires the LOOKUP into the
-- failure scanner so a matched pattern gets included in the LLM's
-- repair spec as additional context. Direct application without LLM
-- review (skipping the autopilot bridge) is deliberately out of scope
-- for v1 — it requires a high-confidence threshold + safety gates that
-- v1 doesn't have. The LLM-with-pattern-context approach is already a
-- meaningful win without that risk.

CREATE TABLE IF NOT EXISTS repair_patterns (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity / matching
  -- The fault_signature pattern matches the format used by
  -- test-contract-failure-scanner.computeFailureSignature():
  --   "<command_key>:<first error line>"
  -- Example: "gateway.alive:status_mismatch: got 500, expected 200"
  fault_signature          TEXT NOT NULL,
  capability               TEXT NOT NULL,
  target_file              TEXT,

  -- The fix
  -- Stored as a unified diff (or the repair LLM's full file rewrite if
  -- diff isn't available). The pattern matcher will inject this verbatim
  -- into the next repair spec for the same signature.
  fix_diff                 TEXT NOT NULL,
  source_pr_url            TEXT,
  source_repair_vtid       TEXT,

  -- Track-record
  success_count            INTEGER NOT NULL DEFAULT 1,
  failure_count            INTEGER NOT NULL DEFAULT 0,
  -- Two consecutive failures auto-quarantine. Operator re-arms by
  -- PATCHing quarantined=false (PR-L5.1+; v1 just records).
  quarantined              BOOLEAN NOT NULL DEFAULT false,

  last_used_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup index: most queries hit this table by fault_signature, ordered
-- by success_count desc to prefer the most-proven pattern.
CREATE INDEX IF NOT EXISTS idx_repair_patterns_signature_success
  ON repair_patterns (fault_signature, success_count DESC)
  WHERE quarantined = false;

-- Maintenance index: surface "patterns that have been failing" to
-- operators without a full table scan.
CREATE INDEX IF NOT EXISTS idx_repair_patterns_failure_count
  ON repair_patterns (failure_count DESC)
  WHERE failure_count > 0;

CREATE INDEX IF NOT EXISTS idx_repair_patterns_last_used_at
  ON repair_patterns (last_used_at DESC NULLS LAST);

-- Service role only — operational table, not user-readable.
ALTER TABLE repair_patterns ENABLE ROW LEVEL SECURITY;

-- updated_at trigger
CREATE OR REPLACE FUNCTION repair_patterns_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_repair_patterns_set_updated_at ON repair_patterns;
CREATE TRIGGER trg_repair_patterns_set_updated_at
BEFORE UPDATE ON repair_patterns
FOR EACH ROW EXECUTE FUNCTION repair_patterns_set_updated_at();

COMMENT ON TABLE repair_patterns IS
  'VTID-02970 (PR-L5): pattern memory for the test-contract autonomy spine. Every verified successful repair is anchored to (fault_signature, capability, target_file, fix_diff). The failure scanner consults this table before allocating a fresh repair VTID — a known-pattern hit short-circuits the diagnose-then-LLM loop.';
