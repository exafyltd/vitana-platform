-- After a refused 130100: nothing changed (read-only).
SELECT 'resolver_not_created' AS check_name, to_regprocedure('public.health_home_tenant_id(uuid)') IS NULL AS ok;
SELECT 'backfill_not_created' AS check_name, to_regprocedure('public.backfill_health_home_tenant(integer)') IS NULL AS ok;
SELECT 'no_column_value_written' AS check_name, count(*) = 0 AS ok FROM public.app_users WHERE health_home_tenant_id IS NOT NULL;
SELECT 'snapshot_not_created' AS check_name, to_regclass('legacy_archive.bak_05595_health_home_tenant') IS NULL AS ok;
