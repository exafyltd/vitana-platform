-- =============================================================================
-- Containment: pause Dev Autopilot auto-approve + arm kill switch
-- =============================================================================
-- We discovered Dev Autopilot has been generating low-quality, duplicate, and
-- in some cases dangerous PRs (modified an applied migration, proposed wrong
-- column rename `vitana_id` -> `vuid`, opened 6 identical middleware refactor
-- PRs against the same finding).
--
-- Root causes (to be fixed in follow-up PRs):
--   1. No "finding -> completed" state transition after PR merges, so
--      autoApproveTick() re-approves the same finding and opens N PRs.
--   2. Planner prompt has zero live DB schema context -> hallucinated columns.
--   3. No plan-vs-diff validator -> dead-code placeholders shipped as PRs.
--
-- Until the fixes land, this migration disarms the autopilot:
--   * auto_approve_enabled = FALSE  -> autoApproveTick() becomes a no-op
--   * kill_switch          = TRUE   -> belt-and-suspenders panic flag
--
-- Reversal: re-run a follow-up migration that flips both back, OR call the
-- existing POST /api/v1/dev-autopilot/config/kill-switch endpoint with
-- {"armed": false} once the fixes are deployed.
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN;

UPDATE public.dev_autopilot_config
   SET auto_approve_enabled = FALSE,
       kill_switch          = TRUE,
       updated_at           = NOW()
 WHERE id = 1;

DO $$
DECLARE
  v_auto_approve BOOLEAN;
  v_kill_switch  BOOLEAN;
BEGIN
  SELECT auto_approve_enabled, kill_switch
    INTO v_auto_approve, v_kill_switch
    FROM public.dev_autopilot_config
   WHERE id = 1;

  IF v_auto_approve IS NULL THEN
    RAISE EXCEPTION 'dev_autopilot_config row id=1 not found - migration aborted';
  END IF;

  IF v_auto_approve <> FALSE THEN
    RAISE EXCEPTION 'auto_approve_enabled did not flip to FALSE (got %)', v_auto_approve;
  END IF;

  IF v_kill_switch <> TRUE THEN
    RAISE EXCEPTION 'kill_switch did not flip to TRUE (got %)', v_kill_switch;
  END IF;

  RAISE NOTICE 'Containment applied: auto_approve_enabled=%, kill_switch=%',
               v_auto_approve, v_kill_switch;
END $$;

COMMIT;
