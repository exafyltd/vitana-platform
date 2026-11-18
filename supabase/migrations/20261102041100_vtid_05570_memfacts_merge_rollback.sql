-- impact-allow-solo-migration: rollback of this lane's own data change; no gateway or worker code reads the objects.
-- VTID-05570 rollback (pre-approved) of 20261102041200_vtid_05570_memfacts_merge_run.sql.
--
-- Replay order: this file sorts before the forward run file ("..._rollback" < "..._run" at version 041100 < 041200), and
-- after the function file (041000), so a full replay runs it first; no snapshot exists yet there, so it is a no-op.
-- NOT a forward step: run it for real only through RUN-MIGRATION.yml, after the owner approves the rollback and the
-- target database (collaboration.md §7d).
-- Resets superseded_by / superseded_at of every row in bak_mt_data_cleanup_memory_facts_merge to its snapshot value,
-- which reinstates the duplicate current facts. The snapshot is kept (30-day retention). Ends with a self-check inside
-- mt_memfacts_restore() that RAISEs (rolling the file back) unless every snapshot row matches its snapshot state.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '600s';

DO $rollback$
DECLARE
  v_res jsonb;
BEGIN
  v_res := public.mt_memfacts_restore();
  RAISE NOTICE 'VTID-05570 rollback: %', v_res;
END
$rollback$;

COMMIT;
