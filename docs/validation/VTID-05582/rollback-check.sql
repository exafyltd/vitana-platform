-- VTID-05582 read-only check AFTER a rollback (SELECT only). Every row must say ok = true.
SELECT 'columns_gone' AS check_name, count(*) = 0 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'global_community_profiles' AND column_name IN ('network_visible', 'network_visible_decided_at', 'messaging_preference');
SELECT 'functions_gone' AS check_name, count(*) = 0 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('request_connection', 'respond_connection', 'is_network_excluded_account', 'gcp_network_visible_guard');
SELECT 'trigger_gone' AS check_name, count(*) = 0 AS ok FROM pg_trigger WHERE tgname = 'trg_gcp_network_visible_guard';
SELECT 'client_write_restored' AS check_name, has_table_privilege('authenticated', 'public.connection_requests', 'INSERT') AND has_table_privilege('authenticated', 'public.connection_requests', 'UPDATE') AS ok;