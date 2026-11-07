-- VTID-05570 (mt-data-cleanup-r2 / memory-facts-supersede-merge, M1 apply): the data change of the lane.
-- Inside this one transaction: snapshot the duplicate groups into bak_mt_data_cleanup_memory_facts_merge, supersede the
-- older current facts of each (tenant_id, user_id, fact_key, entity) group by the newest, then assert that no group
-- has more than one current fact. A failed assertion RAISEs and the whole file rolls back.
-- Apply order: after 20261102041000_vtid_05570_memfacts_merge_functions.sql and after the VTID-05571 rows (21-25), so
-- the reassigned facts already sit under real tenants. Run off-peak, one RUN-MIGRATION dispatch, only after the owner
-- approves the file and the target database (collaboration.md §7d). Read-only pre-check first
-- (docs/validation/VTID-05570/pre-check.sql), post-check after.
-- Rollback (pre-approved): 20261102041100_vtid_05570_memfacts_merge_rollback.sql.
-- impact-allow-solo-migration: data change on an existing table through the lane's own function; no code reads anything new.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '600s';

DO $apply$
DECLARE
  v_run  jsonb;
  v_left bigint;
BEGIN
  v_run := public.mt_memfacts_merge();
  RAISE NOTICE 'VTID-05570 merge: %', v_run;

  SELECT count(*) INTO v_left FROM (
    SELECT 1 FROM public.memory_facts
     WHERE superseded_by IS NULL
     GROUP BY tenant_id, user_id, fact_key, entity
    HAVING count(*) > 1) d;
  IF v_left > 0 THEN
    RAISE EXCEPTION 'VTID-05570: % (tenant,user,fact_key,entity) groups still have more than one current fact; rolling back', v_left;
  END IF;
END
$apply$;

COMMIT;
