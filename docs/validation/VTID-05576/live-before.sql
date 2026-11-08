-- VTID-05576 read-only check BEFORE apply (run by Kiro through RUN-MIGRATION's read-only check; SELECT only).
SELECT 'scope_column_absent' AS check_name, count(*) = 0 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'chat_messages' AND column_name = 'scope';
SELECT 'rpcs_absent' AS check_name, count(*) = 0 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('send_message', 'send_message_as', 'chat_send_message_core', 'chat_messages_scope_guard');
SELECT 'catch_all_policy_already_gone' AS check_name, count(*) = 0 AS ok FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'chat_messages' AND (policyname = 'service_role_manage_chat' OR cmd = 'ALL' OR qual = 'true' OR with_check = 'true');
SELECT 'chat_messages_policies' AS check_name, policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chat_messages' ORDER BY policyname;
SELECT 'chat_messages_rows' AS check_name, count(*) AS n FROM public.chat_messages;
SELECT 'client_grants' AS check_name, has_table_privilege('authenticated', 'public.chat_messages', 'INSERT') AS auth_insert,
       has_table_privilege('authenticated', 'public.chat_messages', 'UPDATE') AS auth_update,
       has_table_privilege('anon', 'public.chat_messages', 'INSERT') AS anon_insert;
SELECT 'network_inputs_present' AS check_name, count(*) = 3 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'global_community_profiles' AND column_name IN ('network_visible', 'network_visible_decided_at', 'messaging_preference');
