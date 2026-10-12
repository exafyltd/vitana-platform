-- VTID-05098 — Loop Engineering Phase 2 (Simplify): retire five dead or
-- duplicate routines. Data only, idempotent.
--
-- We UPDATE and never DELETE: routine_runs.routine_name references
-- routines(name) ON DELETE CASCADE (20260427130000_vtid_01981_routines_catalog.sql),
-- so a DELETE would drop each routine's run history.
--
-- Their claude.ai triggers are disabled separately (evidence:
-- docs/validation/VTID-05098/acceptance.md). Why each one goes:
--   orb-audio-smoke            duplicate of the registry "ORB Live" check; its
--                              Vertex fields breach falsely since GCP is off
--   push-pipeline-probe        push dispatch is covered by /ops/health/push-dispatch
--   migration-backlog          its file-vs-schema_migrations diff always breaches;
--                              MIGRATION-DRIFT-CHECK is the real check
--   cloud-run-frontend-health  duplicate of the registry Gateway Alive /
--                              Frontend Prod / Frontend Staging checks
--   self-healing-triage        inert (approve/reject reject its token); the
--                              in-gateway triage agent and the reconciler do this

BEGIN;

UPDATE routines
SET enabled     = false,
    description = COALESCE(description, '') ||
                  ' [Retired VTID-05098: duplicate or dead check — see docs/autonomy/LOOP-ENGINEERING.md §5]',
    updated_at  = NOW()
WHERE name IN (
  'orb-audio-smoke',
  'push-pipeline-probe',
  'migration-backlog',
  'cloud-run-frontend-health',
  'self-healing-triage'
)
AND COALESCE(description, '') NOT LIKE '%[Retired VTID-05098:%';

COMMIT;
