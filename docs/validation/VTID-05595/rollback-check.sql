-- VTID-05595 read-only check AFTER a rollback (SELECT only). Every row must say ok = true.
SELECT 'column_gone' AS check_name, count(*) = 0 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'app_users' AND column_name = 'health_home_tenant_id';
SELECT 'index_gone' AS check_name, count(*) = 0 AS ok FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_app_users_health_home_tenant';
SELECT 'functions_gone' AS check_name, count(*) = 0 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('health_home_tenant_id', 'backfill_health_home_tenant');
SELECT 'snapshot_kept' AS check_name, to_regclass('legacy_archive.bak_05595_health_home_tenant') IS NOT NULL AS ok;
