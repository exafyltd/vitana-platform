-- VTID-05582 read-only check AFTER apply (SELECT only). Every row must say ok = true.
SELECT 'columns_present' AS check_name, count(*) = 3 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'global_community_profiles' AND column_name IN ('network_visible', 'network_visible_decided_at', 'messaging_preference');
SELECT 'nobody_opted_in_by_the_migration' AS check_name, count(*) = 0 AS ok FROM public.global_community_profiles WHERE network_visible AND network_visible_decided_at IS NULL;
SELECT 'no_excluded_account_visible' AS check_name, NOT EXISTS (
  SELECT 1 FROM public.global_community_profiles g WHERE g.network_visible AND (
    EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = g.user_id)
 OR EXISTS (SELECT 1 FROM public.notification_test_actors t WHERE t.user_id = g.user_id))) AS ok;
SELECT 'trigger_present' AS check_name, count(*) = 1 AS ok FROM pg_trigger WHERE tgrelid = 'public.global_community_profiles'::regclass AND tgname = 'trg_gcp_network_visible_guard' AND NOT tgisinternal;
SELECT 'client_write_revoked' AS check_name, NOT has_table_privilege('authenticated', 'public.connection_requests', 'INSERT') AND NOT has_table_privilege('authenticated', 'public.connection_requests', 'UPDATE') AND NOT has_table_privilege('anon', 'public.connection_requests', 'INSERT') AND NOT has_table_privilege('anon', 'public.connection_requests', 'UPDATE') AS ok;
SELECT 'rpcs_definer_pinned' AS check_name, count(*) = 3 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('request_connection', 'respond_connection', 'is_network_excluded_account') AND p.prosecdef AND p.proconfig::text LIKE '%search_path%';
SELECT 'rpc_execute_grants' AS check_name, has_function_privilege('authenticated', 'public.request_connection(uuid,text,text)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.request_connection(uuid,text,text)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.is_network_excluded_account(uuid)', 'EXECUTE') AS ok;
SELECT 'connection_requests_rows_unchanged_shape' AS check_name, count(*) = count(*) FILTER (WHERE status IN ('pending', 'accepted', 'declined')) AS ok FROM public.connection_requests;