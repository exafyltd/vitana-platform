-- BOOTSTRAP-ADMIN-KPI-AA follow-up: pg_cron retention schedule (the prior
-- migration errored on the inline $$…$$ string because both the DO block
-- and the cron body tried to use the same dollar-quote delimiter).
-- Tables/indexes/policies from the prior migration applied successfully;
-- only the retention schedule was missed. This file ships the fix using
-- distinct delimiters so both quote levels nest cleanly.

\set ON_ERROR_STOP on

DO $outer$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'tenant-kpi-daily-retention',
      '17 3 * * *',
      $cron$DELETE FROM public.tenant_kpi_daily WHERE snapshot_date < (NOW() - INTERVAL '90 days')::date;$cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END
$outer$;
