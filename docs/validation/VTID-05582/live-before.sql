-- VTID-05582 read-only check BEFORE apply (run by Kiro through RUN-MIGRATION's read-only check; SELECT only).
SELECT 'columns_absent' AS check_name, count(*) = 0 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'global_community_profiles' AND column_name IN ('network_visible', 'network_visible_decided_at', 'messaging_preference');
SELECT 'rpcs_absent' AS check_name, count(*) = 0 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('request_connection', 'respond_connection', 'is_network_excluded_account');
SELECT 'profile_rows' AS check_name, count(*) AS n FROM public.global_community_profiles;
SELECT 'connection_requests_by_status' AS check_name, status, count(*) AS n FROM public.connection_requests GROUP BY status ORDER BY status;
SELECT 'authenticated_can_write_connection_requests' AS check_name, has_table_privilege('authenticated', 'public.connection_requests', 'INSERT') AS can_insert, has_table_privilege('authenticated', 'public.connection_requests', 'UPDATE') AS can_update;
