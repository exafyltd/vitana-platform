-- VTID-05575 read-only check AFTER apply (SELECT only). Every row must say ok = true.
SELECT 'columns_present' AS check_name, count(*) = 2 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'daily_matches' AND column_name IN ('scope', 'tenant_id');
SELECT 'every_row_has_a_valid_scope' AS check_name, count(*) = 0 AS ok FROM public.daily_matches WHERE scope IS NULL OR scope NOT IN ('community', 'network');
SELECT 'no_unique_key_added' AS check_name, count(*) = 1 AS ok FROM pg_constraint WHERE conrelid = 'public.daily_matches'::regclass AND contype IN ('p', 'u');
SELECT 'no_health_reason_left' AS check_name, count(*) = 0 AS ok FROM public.daily_matches WHERE public.strip_health_match_reasons(match_reasons) IS DISTINCT FROM match_reasons;
SELECT 'community_rows_have_a_shared_real_tenant_or_none' AS check_name, count(*) = 0 AS ok FROM public.daily_matches dm
 WHERE dm.scope = 'community' AND dm.tenant_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM public.user_tenants a JOIN public.user_tenants b ON b.tenant_id = a.tenant_id
    WHERE a.tenant_id = dm.tenant_id AND a.user_id = dm.user_id AND b.user_id = dm.matched_user_id);
SELECT 'trigger_present' AS check_name, count(*) = 1 AS ok FROM pg_trigger WHERE tgrelid = 'public.daily_matches'::regclass AND tgname = 'trg_daily_matches_scope_guard' AND NOT tgisinternal;
SELECT 'helpers_definer_pinned' AS check_name, count(*) = 3 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('daily_matches_scope_guard', 'is_network_candidate', 'intent_pool_allows') AND p.prosecdef AND p.proconfig::text LIKE '%search_path%';
SELECT 'helpers_service_role_only' AS check_name,
  has_function_privilege('service_role', 'public.is_network_candidate(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.is_network_candidate(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.is_network_candidate(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.intent_pool_allows(uuid,uuid,uuid,text)', 'EXECUTE') AS ok;
SELECT 'matchers_scoped' AS check_name, count(*) = count(*) FILTER (WHERE pg_get_functiondef(p.oid) LIKE '%intent_pool_allows%'
  AND pg_get_functiondef(p.oid) !~ 'OR (p_visibility|src\.visibility) = ''public''\)' AND p.prosecdef) AS ok
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('search_intent_catalog', 'search_intent_catalog_v2', 'compute_intent_matches', 'compute_intent_matches_v2');
SELECT 'search_default_is_community' AS check_name, count(*) = count(*) FILTER (WHERE pg_get_function_arguments(p.oid) LIKE '%p_visibility text DEFAULT ''community''::text%') AS ok
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('search_intent_catalog', 'search_intent_catalog_v2');
-- Informational (not a pass/fail): backfilled network rows that point at a member who has not opted in. They are 24-hour rows
-- labelled by D15; the guard refuses new ones. A non-zero n here is expected on the first run and drains within a day.
SELECT 'info_network_rows_pointing_at_non_visible_members' AS check_name, count(*) AS n FROM public.daily_matches dm
 WHERE dm.scope = 'network' AND NOT EXISTS (SELECT 1 FROM public.global_community_profiles g WHERE g.user_id = dm.matched_user_id AND g.network_visible);
