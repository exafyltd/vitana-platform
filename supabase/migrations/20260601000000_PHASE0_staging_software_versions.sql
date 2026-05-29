-- Phase 0 staging build (handoff brief P0.4):
-- Extend software_versions to track Cloud Run revision identity, the
-- source-stage revision a publish was promoted from, and the admin user UUID
-- that initiated a publish/revert.
--
-- Strictly additive: all three columns are nullable with no default and no
-- backfill — existing rows continue to work, existing TS code that doesn't
-- know these columns continues to work. The deploy_type CHECK constraint is
-- NOT modified; new flow encodes "staging-publish" / "revert" / "staging-deploy"
-- as a derived display label computed from (deploy_type, environment,
-- source_revision) in the API layer (see /api/v1/operator/deployments).
--
-- Rollback: drop the three columns (safe — no data depends on them yet).

ALTER TABLE software_versions
  ADD COLUMN IF NOT EXISTS cloud_run_revision text,
  ADD COLUMN IF NOT EXISTS source_revision text,
  ADD COLUMN IF NOT EXISTS initiator_id uuid;

COMMENT ON COLUMN software_versions.cloud_run_revision IS
  'Cloud Run revision name that THIS row represents (e.g. gateway-00123-xyz). Set by STAGE-DEPLOY / EXEC-DEPLOY post-deploy bookkeeping and by /operator/publish + /operator/revert.';
COMMENT ON COLUMN software_versions.source_revision IS
  'For deploy_type=normal rows triggered by a staging publish: the gateway-staging revision that was promoted. Drives the "staging-publish" derived label in the CLOCK history view.';
COMMENT ON COLUMN software_versions.initiator_id IS
  'Admin user UUID that initiated a publish or revert via the Command Hub. Existing initiator column stays a category enum (user|agent); this carries the actual identity for audit.';
