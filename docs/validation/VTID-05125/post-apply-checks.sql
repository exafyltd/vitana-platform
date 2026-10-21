-- VTID-05125 post-apply verification — READ-ONLY (catalog SELECTs only).
-- Run against project inmkhvwdcuyhnxkgfvsb after RUN-MIGRATION of
-- supabase/migrations/20261013090000_vtid_05125_memory_functions_revoke_migrate.sql.
-- Effect-based: never reads supabase_migrations.schema_migrations.
-- Done when: exactly 4 rows, migrate_x = false, service_x = true,
-- auth_x = anon_x = false, and acl no longer contains `migrate=`.
SELECT p.oid::regprocedure AS fn, p.proacl::text AS acl,
  has_function_privilege('migrate', p.oid, 'EXECUTE')       AS migrate_x,
  has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_x,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
  has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_x
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
WHERE p.proname IN ('write_fact','get_current_facts','recall_at_time_range','memory_facts_semantic_search')
ORDER BY 1;

-- Single-row verdict.
SELECT count(*) = 4
   AND bool_and(NOT has_function_privilege('migrate', p.oid, 'EXECUTE'))
   AND bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE'))
   AND bool_and(NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'))
   AND bool_and(NOT has_function_privilege('anon', p.oid, 'EXECUTE')) AS vtid_05125_ok
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
WHERE p.proname IN ('write_fact','get_current_facts','recall_at_time_range','memory_facts_semantic_search');
