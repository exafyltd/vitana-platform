-- impact-allow-solo-migration: rollback of this lane's own data backfill; no gateway or worker code reads the objects.
-- VTID-05572 rollback (pre-approved) of 20261102042100_vtid_05572_profiles_tenant_backfill_run.sql.
-- NOT a forward migration and not under supabase/migrations: run it only through RUN-MIGRATION.yml, after the owner
-- approves it and the target database (collaboration.md §7d). Restores profiles.tenant_id from
-- legacy_archive.bak_mt_data_cleanup_profiles for exactly the profiles the backfill set (and only while they still hold
-- the value it set), and clears the review list. The snapshot table is kept for 30 days. Ends with a self-check.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '300s';
DO $rollback$
DECLARE
  v_res jsonb;
  v_left bigint;
BEGIN
  v_res := public.mt_profiles_tenant_restore();
  RAISE NOTICE 'VTID-05572 rollback: %', v_res;
  SELECT count(*) INTO v_left FROM legacy_archive.mt_profiles_tenant_unresolved;
  IF v_left > 0 THEN
    RAISE EXCEPTION 'VTID-05572 rollback: % review-list rows remain', v_left;
  END IF;
END
$rollback$;
COMMIT;
