-- VTID-05595 read-only POST-check AFTER apply (SELECT only). Every row must say ok = true.
SELECT 'column_present' AS check_name, count(*) = 1 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'app_users' AND column_name = 'health_home_tenant_id' AND is_nullable = 'YES';
SELECT 'index_present' AS check_name, count(*) = 1 AS ok FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_app_users_health_home_tenant';
SELECT 'fk_present' AS check_name, count(*) = 1 AS ok FROM pg_constraint WHERE conname = 'app_users_health_home_tenant_fkey' AND conrelid = 'public.app_users'::regclass;
SELECT 'functions_definer_pinned' AS check_name, count(*) = 2 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('health_home_tenant_id', 'backfill_health_home_tenant') AND p.prosecdef AND p.proconfig::text LIKE '%search_path%';
SELECT 'execute_service_role_only' AS check_name,
       has_function_privilege('service_role', 'public.health_home_tenant_id(uuid)', 'EXECUTE')
   AND NOT has_function_privilege('authenticated', 'public.health_home_tenant_id(uuid)', 'EXECUTE')
   AND NOT has_function_privilege('anon', 'public.health_home_tenant_id(uuid)', 'EXECUTE')
   AND NOT has_function_privilege('authenticated', 'public.backfill_health_home_tenant(integer)', 'EXECUTE') AS ok;
-- Every member has a home tenant (no member is left unresolved; the apply aborts otherwise).
SELECT 'every_member_has_a_home_tenant' AS check_name, count(*) = 0 AS ok
  FROM (SELECT DISTINCT user_id FROM public.user_tenants) m WHERE public.health_home_tenant_id(m.user_id) IS NULL;
SELECT 'frozen_equals_resolved_for_every_frozen_member' AS check_name, count(*) = 0 AS ok
  FROM public.app_users WHERE health_home_tenant_id IS NOT NULL AND public.health_home_tenant_id(user_id) IS DISTINCT FROM health_home_tenant_id;
SELECT 'snapshot_covers_every_backfilled_member' AS check_name, count(*) = 0 AS ok
  FROM public.app_users au WHERE au.health_home_tenant_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM legacy_archive.bak_05595_health_home_tenant b WHERE b.user_id = au.user_id);
SELECT 'snapshot_not_readable_by_members' AS check_name,
       NOT has_table_privilege('authenticated', 'legacy_archive.bak_05595_health_home_tenant', 'SELECT')
   AND NOT has_table_privilege('anon', 'legacy_archive.bak_05595_health_home_tenant', 'SELECT') AS ok;
