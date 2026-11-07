-- VTID-05571 (mt-data-cleanup-r2 / orphan-analysis-and-quarantine, O4 apply): the data change of the lane.
-- Order inside this one transaction: check the canonical membership source is live -> snapshot every row that will
-- move into bak_mt_data_cleanup_<table> (O2) -> move in batches (dev user ...0099 and bot-on-dev-tenant rows and
-- 0/2+-membership owners to mt_orphan_quarantine, single-membership owners remapped; never Maxina) -> assert no
-- orphan row is left. Any failed check RAISEs and the whole file rolls back, leaving the database untouched.
-- Apply order and the dependency on mt-identity-r2 membership-unification: see
-- 20261102040000_vtid_05571_orphan_analysis.sql. Run off-peak, one RUN-MIGRATION dispatch, only after the owner
-- approves the file and the target database (collaboration.md §7d). Read-only pre-check first
-- (docs/validation/VTID-05571/pre-check.sql, must match the plan's premise-2 baseline), post-check after.
-- Rollback (pre-approved): 20261102040300_vtid_05571_orphan_cleanup_rollback.sql.
-- impact-allow-solo-migration: data move on existing tables; no code reads anything new.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '600s';

DO $apply$
DECLARE
  v_members  bigint;
  v_snap     jsonb;
  v_run      jsonb;
  v_left     bigint;
  v_blocked  bigint;
BEGIN
  -- The remap reads the unified membership store; an empty store would quarantine every owner.
  IF to_regclass('public.user_tenants') IS NULL THEN
    RAISE EXCEPTION 'VTID-05571: public.user_tenants is missing; apply mt-identity-r2 membership-unification first';
  END IF;
  -- An empty store is allowed only when nothing would be quarantined as no_membership because of it (a fresh local
  -- stack has no members and no such rows); otherwise the remap would send every owner to quarantine.
  SELECT count(*) INTO v_members FROM public.user_tenants;
  IF v_members = 0 AND EXISTS (SELECT 1 FROM public.analyze_orphan_rows() a WHERE a.decision = 'no_membership' AND a.row_count > 0) THEN
    RAISE EXCEPTION 'VTID-05571: public.user_tenants is empty but orphan rows have owners; apply mt-identity-r2 membership-unification (backfill) first';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('table', s.table_name, 'captured', s.captured)), '[]'::jsonb)
    INTO v_snap FROM public.mt_orphan_snapshot_all() s;
  RAISE NOTICE 'VTID-05571 snapshot: %', v_snap;

  v_run := public.mt_orphan_cleanup_run(2000);
  RAISE NOTICE 'VTID-05571 move: %', v_run;

  SELECT coalesce(sum(a.row_count), 0) INTO v_left
    FROM public.analyze_orphan_rows() a
   WHERE a.decision IS NOT NULL AND a.decision <> 'keep';
  IF v_left > 0 THEN
    SELECT count(*) INTO v_blocked FROM public.mt_orphan_quarantine q
     WHERE q.quarantined_by = 'VTID-05571' AND q.reason = 'move_blocked' AND NOT q.source_deleted;
    RAISE EXCEPTION 'VTID-05571: % orphan rows remain after the move (% blocked, see mt_orphan_quarantine reason move_blocked); rolling back', v_left, v_blocked;
  END IF;
END
$apply$;

COMMIT;
