-- =============================================================================
-- Dev Autopilot — partial unique index preventing concurrent inflight execs
-- per finding (VTID-AUTOPILOT-RACE)
-- =============================================================================
-- Bug: Cloud Run scales the gateway to N instances. Each instance runs
-- `autoApproveTick` independently every 30 seconds. The picker's dedup
-- logic is:
--
--   SELECT id FROM dev_autopilot_executions
--   WHERE finding_id = $1 AND status IN ('cooling','running','ci',
--                                        'merging','deploying','verifying')
--   LIMIT 1;
--
--   -- if empty, then INSERT a new cooling row.
--
-- That SELECT and INSERT are NOT in a transaction, and there is no row-
-- level lock. Two instances ticking at slightly different times can BOTH
-- see no inflight exec, both INSERT, and both proceed — producing two
-- parent executions for the same finding within seconds.
--
-- Observed 2026-05-05 06:42 drain: finding 6beb8aa7 produced 4 parent
-- execs in 90 seconds (one every ~30s tick), opening PRs
-- #1829/#1831/#1832/#1833 in rapid sequence. #1829 merged; the other
-- three could not be merged because their target file had already
-- changed in main, and were closed manually.
--
-- Fix: enforce uniqueness at the database level via a PARTIAL UNIQUE
-- INDEX. Postgres rejects the second concurrent INSERT with a 23505
-- unique-violation error code (HTTP 409 via PostgREST). The picker code
-- treats that error as a benign "another instance got here first" skip.
--
-- Why partial: terminal-state rows (`completed`, `failed`, `reverted`,
-- `auto_archived`, `failed_escalated`, `cancelled`, `self_healed`) MUST
-- continue to allow many rows per finding for retry chains and history.
-- Only inflight states need the uniqueness guarantee.
--
-- Idempotent: `IF NOT EXISTS` makes re-runs no-ops. Safe to apply to a
-- live system because no inflight rows are deleted/modified.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS dev_autopilot_executions_finding_inflight_uniq
  ON public.dev_autopilot_executions (finding_id)
  WHERE status IN (
    'cooling',
    'running',
    'ci',
    'merging',
    'deploying',
    'verifying'
  );

COMMENT ON INDEX public.dev_autopilot_executions_finding_inflight_uniq IS
  'VTID-AUTOPILOT-RACE — prevents multi-instance autoApproveTick from creating concurrent parent execs for the same finding. Companion gateway code catches 23505 as benign skip.';
