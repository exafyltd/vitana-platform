-- VTID-05575 read-only check BEFORE apply (run by Kiro through RUN-MIGRATION's read-only check; SELECT only).
SELECT 'columns_absent' AS check_name, count(*) = 0 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'daily_matches' AND column_name IN ('scope', 'tenant_id');
SELECT 'functions_absent' AS check_name, count(*) = 0 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('is_network_candidate', 'strip_health_match_reasons', 'daily_matches_scope_guard', 'intent_pool_allows');
SELECT 'dependency_network_visible_present' AS check_name, count(*) = 1 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'global_community_profiles' AND column_name = 'network_visible';
SELECT 'daily_matches_rows' AS check_name, count(*) AS n FROM public.daily_matches;
-- approximate (the text also matches parameters); the post-apply check is exact
SELECT 'daily_matches_rows_mentioning_health_words' AS check_name, count(*) AS n FROM public.daily_matches WHERE match_reasons::text ~* '(index|pillar|health)';
SELECT 'matchers_with_public_pool' AS check_name, p.proname, (pg_get_functiondef(p.oid) ~ 'OR (p_visibility|src\.visibility) = ''public''\)') AS has_public_pool
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('search_intent_catalog', 'search_intent_catalog_v2', 'compute_intent_matches', 'compute_intent_matches_v2') ORDER BY p.proname;
