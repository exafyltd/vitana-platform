-- impact-allow-solo-migration: rollback of this lane's own data move; no gateway or worker code reads the objects.
-- VTID-05571 rollback (pre-approved) of 20261102040300_vtid_05571_orphan_cleanup_run.sql.
--
-- Replay order: this file sorts before the forward file ("..._cleanup_rollback" < "..._cleanup_run"), so a full replay runs it
-- first; there is nothing to restore yet (empty snapshots, no quarantine rows), so it is a no-op there.
-- NOT a forward step: run it for real only through RUN-MIGRATION.yml, after the owner approves the rollback and the
-- target database (collaboration.md §7d).
-- Restores every touched table from its bak_mt_data_cleanup_<table> snapshot: rows that were quarantined (deleted
-- from the source) are re-inserted, rows that were remapped get their original tenant_id back, and this lane's rows
-- in mt_orphan_quarantine are removed. The snapshot tables are kept (30-day retention); a re-apply captures nothing
-- twice. Ends with a self-check that RAISEs (rolling the file back) unless every snapshot row is back in its table
-- with its original tenant_id and the quarantine holds no row of this lane.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '600s';

DO $rollback$
DECLARE
  v_res jsonb;
  v_left bigint;
BEGIN
  v_res := public.mt_orphan_restore();
  RAISE NOTICE 'VTID-05571 rollback: %', v_res;
  SELECT count(*) INTO v_left FROM public.mt_orphan_quarantine WHERE quarantined_by = 'VTID-05571';
  IF v_left > 0 THEN
    RAISE EXCEPTION 'VTID-05571 rollback: % quarantine rows of this lane remain', v_left;
  END IF;
END
$rollback$;

COMMIT;
