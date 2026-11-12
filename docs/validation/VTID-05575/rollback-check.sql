-- VTID-05575 read-only check AFTER a full rollback (SELECT only). Every row must say ok = true.
SELECT 'columns_gone' AS check_name, count(*) = 0 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'daily_matches' AND column_name IN ('scope', 'tenant_id');
SELECT 'functions_gone' AS check_name, count(*) = 0 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('is_network_candidate', 'strip_health_match_reasons', 'daily_matches_scope_guard', 'intent_pool_allows');
SELECT 'trigger_gone' AS check_name, count(*) = 0 AS ok FROM pg_trigger WHERE tgname = 'trg_daily_matches_scope_guard';
SELECT 'matchers_back_to_public_pool' AS check_name, count(*) = count(*) FILTER (WHERE pg_get_functiondef(p.oid) ~ 'OR (p_visibility|src\.visibility) = ''public''\)') AS ok
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('search_intent_catalog', 'search_intent_catalog_v2', 'compute_intent_matches', 'compute_intent_matches_v2');
SELECT 'search_default_is_public_again' AS check_name, count(*) = count(*) FILTER (WHERE pg_get_function_arguments(p.oid) LIKE '%p_visibility text DEFAULT ''public''::text%') AS ok
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('search_intent_catalog', 'search_intent_catalog_v2');
