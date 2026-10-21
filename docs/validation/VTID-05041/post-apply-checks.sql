-- VTID-05041 post-apply verification — READ-ONLY (catalog SELECTs only).
-- Run against project inmkhvwdcuyhnxkgfvsb after RUN-MIGRATION of
-- 20261008170000_vtid_04981_consume_credits_lockdown.sql and then
-- 20261010164100_vtid_05041_definer_functions_lockdown.sql. Effect-based:
-- never reads supabase_migrations.schema_migrations (not authoritative here).

-- Q1. Every overload of the four memory functions and fn_consume_credits:
--     expect auth_x = false, anon_x = false, public_x = false, service_x = true.
SELECT p.oid::regprocedure::text AS fn,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_x,
       EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_x,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_x
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
WHERE p.proname IN ('write_fact', 'get_current_facts', 'recall_at_time_range',
                    'memory_facts_semantic_search', 'fn_consume_credits')
ORDER BY 1;

-- Q2. The public profile lookup: expect anon_x/auth_x/service_x = true,
--     public_x = false, returns_email = false, still SECURITY DEFINER.
SELECT p.oid::regprocedure::text AS fn,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_x,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_x,
       EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_x,
       pg_get_function_result(p.oid) ILIKE '%email%'             AS returns_email,
       p.prosecdef                                               AS security_definer
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
WHERE p.proname = 'get_user_profile_by_identifier';

-- Q3. Exact return columns of the profile lookup (expect 40 columns, no email).
SELECT pg_get_function_result('public.get_user_profile_by_identifier(text)'::regprocedure) AS returns;

-- Q4. One boolean for the whole slice (expect true).
SELECT bool_and(ok) AS vtid_05041_ok FROM (
  SELECT NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
         AND has_function_privilege('service_role', p.oid, 'EXECUTE') AS ok
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname IN ('write_fact', 'get_current_facts', 'recall_at_time_range',
                      'memory_facts_semantic_search', 'fn_consume_credits')
  UNION ALL
  SELECT has_function_privilege('anon', 'public.get_user_profile_by_identifier(text)', 'EXECUTE')
         AND pg_get_function_result('public.get_user_profile_by_identifier(text)'::regprocedure) NOT ILIKE '%email%'
) s;

-- Optional (plan §5, read-only): the unauthenticated PostgREST read the plan
-- names. STAGING-VERIFY's runner only targets the staging gateway/frontend
-- hosts, so it cannot carry this probe; run it by hand after the apply. It
-- reads the production project (staging has no separate database). Expect
-- HTTP 200, a row with "display_name" and no "email" key.
--   curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/get_user_profile_by_identifier" \
--     -H "apikey: $SUPABASE_ANON_KEY" -H "content-type: application/json" \
--     -d '{"identifier":"<a public member handle>"}' \
--   | jq '.[0] | {has_display_name: has("display_name"), has_email: has("email")}'
