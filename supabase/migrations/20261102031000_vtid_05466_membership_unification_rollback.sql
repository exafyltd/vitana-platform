-- impact-allow-solo-migration: rollback of this lane's own migrations; no gateway or worker code reads the objects it drops.
-- VTID-05466 rollback (pre-approved) for the membership-unification lane:
--   20261102031200_vtid_05466_membership_drift_report.sql     (undone first)
--   20261102031100_vtid_05466_memberships_view_dualwrite.sql  (undone second)
--   20261102031000_vtid_05466_user_tenants_canonical.sql      (undone third)
--
-- NOT a forward migration: run it only through RUN-MIGRATION.yml, after the owner approves the rollback
-- and the target database (collaboration.md §7d). It restores the state before the lane exactly:
--  * the drift report: pg_cron job, both functions and public.membership_drift_reports are removed;
--  * the dual-write: trigger memberships_dualwrite_user_tenants and its function are dropped. user_tenants
--    rows it wrote while it was live are real memberships (their memberships row exists) and are kept;
--    deleting them would remove members from the canonical store;
--  * the backfill: exactly the user_tenants rows the backfill logged are deleted (DELETE fires none of
--    the four AFTER INSERT side-effect triggers), app_users.welcome_chat_sent goes back to its logged
--    value, the user_tenants comment goes back to its captured text, the backfill function is dropped;
--  * the legacy_archive tables 20261102031000 created are dropped last, so the lane can be re-applied.
--    They only hold copies of rows that are back in their live tables at that point.
-- Each step is guarded, so the file also runs clean when only part of the lane was applied.
-- Ends with a self-check that RAISEs (rolling everything back) if the prior state is not reached.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

-- 1. Drift report (20261102031200) ----------------------------------------------------------------
DO $cron$
BEGIN
  -- Nested on purpose: cron.job is only parsed where pg_cron exists.
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'membership-drift-report-nightly') THEN
      PERFORM cron.unschedule('membership-drift-report-nightly');
    END IF;
  END IF;
END
$cron$;

DROP FUNCTION IF EXISTS public.record_membership_drift_report();
DROP FUNCTION IF EXISTS public.membership_drift_report();
DROP TABLE IF EXISTS public.membership_drift_reports;

-- 2. Dual-write (20261102031100) ------------------------------------------------------------------
DROP TRIGGER IF EXISTS memberships_dualwrite_user_tenants ON public.memberships;
DROP FUNCTION IF EXISTS public.memberships_dualwrite_user_tenants();

-- 3. Backfill (20261102031000) --------------------------------------------------------------------
DO $undo$
DECLARE logged int; deleted int; v_comment text;
BEGIN
  IF to_regclass('legacy_archive.bak_05466_backfill_log_20261102') IS NULL THEN
    RAISE NOTICE 'VTID-05466 rollback: 20261102031000 was not applied, nothing to undo';
    RETURN;
  END IF;

  SELECT count(*) INTO logged FROM legacy_archive.bak_05466_backfill_log_20261102;

  DELETE FROM public.user_tenants ut
   USING legacy_archive.bak_05466_backfill_log_20261102 l
   WHERE ut.id = l.user_tenant_id;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  IF deleted <> logged THEN
    RAISE EXCEPTION 'VTID-05466 rollback: deleted % user_tenants rows, logged % — aborting', deleted, logged;
  END IF;

  UPDATE public.app_users au
     SET welcome_chat_sent = l.welcome_chat_sent_before
    FROM (SELECT DISTINCT ON (user_id) user_id, welcome_chat_sent_before
            FROM legacy_archive.bak_05466_backfill_log_20261102
           ORDER BY user_id, logged_at) l
   WHERE au.user_id = l.user_id
     AND au.welcome_chat_sent IS DISTINCT FROM l.welcome_chat_sent_before;

  SELECT value INTO v_comment FROM legacy_archive.bak_05466_meta_20261102 WHERE key = 'user_tenants_comment';
  EXECUTE format('COMMENT ON TABLE public.user_tenants IS %L', v_comment);

  RAISE NOTICE 'VTID-05466 rollback: removed % backfilled user_tenants rows', deleted;
END
$undo$;

DROP FUNCTION IF EXISTS public.mt_backfill_memberships_to_user_tenants();

DROP TABLE IF EXISTS legacy_archive.bak_05466_backfill_log_20261102;
DROP TABLE IF EXISTS legacy_archive.bak_05466_meta_20261102;
DROP TABLE IF EXISTS legacy_archive.bak_05466_user_tenants_20261102;
DROP TABLE IF EXISTS legacy_archive.bak_05466_memberships_20261102;
-- legacy_archive itself predates this lane (VTID-05043) and stays.

-- 4. Self-check -----------------------------------------------------------------------------------
DO $check$
BEGIN
  IF to_regclass('public.membership_drift_reports') IS NOT NULL
     OR to_regprocedure('public.membership_drift_report()') IS NOT NULL
     OR to_regprocedure('public.record_membership_drift_report()') IS NOT NULL
     OR to_regprocedure('public.mt_backfill_memberships_to_user_tenants()') IS NOT NULL
     OR to_regprocedure('public.memberships_dualwrite_user_tenants()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'memberships_dualwrite_user_tenants')
     OR to_regclass('legacy_archive.bak_05466_backfill_log_20261102') IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-05466 rollback self-check: a lane object is still present';
  END IF;
  IF obj_description('public.user_tenants'::regclass, 'pg_class') LIKE '%VTID-05466%' THEN
    RAISE EXCEPTION 'VTID-05466 rollback self-check: user_tenants comment not restored';
  END IF;
END
$check$;

COMMIT;
