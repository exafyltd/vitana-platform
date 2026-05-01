-- =============================================================================
-- VTID-02639: autopilot_recommendations — add 'completed' status + PR backref
-- =============================================================================
-- Root cause: dev autopilot's autoApproveTick() filters findings by
-- status='new'. After a successful execution merges a PR, the corresponding
-- autopilot_recommendations row is never updated — so on the next tick it
-- gets re-approved and a fresh PR is opened against the same finding. This
-- is why the 2026-04-30 sweep had to close 6 identical
-- "Refactor admin-notification-categories to use middleware" PRs that all
-- targeted the same finding.
--
-- This migration:
--   1. Extends the status CHECK constraint to allow 'completed'.
--   2. Adds backref columns so we know which PR closed which finding:
--        merged_pr_url    TEXT
--        merged_pr_number INTEGER
--        completed_at     TIMESTAMPTZ
--   3. Adds a partial index for fast "what did we ship?" queries.
--
-- The gateway code change in dev-autopilot-execute.ts (this same VTID) is
-- what actually flips the finding to 'completed' inside patchExecution() —
-- the centralized chokepoint for execution-status updates. A defense-in-
-- depth guard inside approveAutoExecute() refuses to re-approve any finding
-- whose status is not 'new'.
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- 1. Extend the status enum.
-- The existing constraint is:
--   CHECK (status IN ('new', 'activated', 'rejected', 'snoozed'))
-- Drop and re-create with 'completed' added.
ALTER TABLE public.autopilot_recommendations
  DROP CONSTRAINT IF EXISTS autopilot_recommendations_status_check;

ALTER TABLE public.autopilot_recommendations
  ADD CONSTRAINT autopilot_recommendations_status_check
    CHECK (status IN ('new', 'activated', 'rejected', 'snoozed', 'completed'));

-- 2. Backref columns. NULLable — populated only when the autopilot's
--    execution loop successfully merges a PR for this finding.
ALTER TABLE public.autopilot_recommendations
  ADD COLUMN IF NOT EXISTS merged_pr_url    TEXT,
  ADD COLUMN IF NOT EXISTS merged_pr_number INTEGER,
  ADD COLUMN IF NOT EXISTS completed_at     TIMESTAMPTZ;

-- 3. Partial index for "completed in the last N days" telemetry queries
--    (Command Hub Autopilot dashboard, OASIS retention reports). Partial
--    so we don't pay storage for the (much larger) population of 'new' rows.
CREATE INDEX IF NOT EXISTS idx_autopilot_recommendations_completed_at
  ON public.autopilot_recommendations (completed_at DESC NULLS LAST)
  WHERE status = 'completed';

-- 4. Verify the constraint and columns are in place. Reads from pg_catalog
--    instead of an INSERT smoke test so we don't have to track NOT NULL /
--    REFERENCES constraints that may evolve on this table.
DO $$
DECLARE
  v_constraint_def TEXT;
  v_url_col_count   INTEGER;
  v_num_col_count   INTEGER;
  v_at_col_count    INTEGER;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO v_constraint_def
    FROM pg_constraint
   WHERE conname = 'autopilot_recommendations_status_check'
     AND conrelid = 'public.autopilot_recommendations'::regclass;

  IF v_constraint_def IS NULL THEN
    RAISE EXCEPTION 'autopilot_recommendations_status_check constraint missing after migration';
  END IF;
  IF position('completed' in v_constraint_def) = 0 THEN
    RAISE EXCEPTION 'status CHECK constraint did not pick up completed: %', v_constraint_def;
  END IF;

  SELECT count(*) INTO v_url_col_count FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'autopilot_recommendations'
     AND column_name = 'merged_pr_url';
  SELECT count(*) INTO v_num_col_count FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'autopilot_recommendations'
     AND column_name = 'merged_pr_number';
  SELECT count(*) INTO v_at_col_count FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'autopilot_recommendations'
     AND column_name = 'completed_at';

  IF v_url_col_count = 0 OR v_num_col_count = 0 OR v_at_col_count = 0 THEN
    RAISE EXCEPTION 'backref columns missing: merged_pr_url=%, merged_pr_number=%, completed_at=%',
                    v_url_col_count, v_num_col_count, v_at_col_count;
  END IF;

  RAISE NOTICE 'VTID-02639 applied: status enum extended (constraint=%), backref columns present',
               v_constraint_def;
END $$;

COMMIT;
