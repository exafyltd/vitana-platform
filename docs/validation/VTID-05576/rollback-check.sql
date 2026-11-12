-- VTID-05576 read-only check AFTER a full rollback (SELECT only). Every row must say ok = true.
SELECT 'scope_column_gone' AS check_name, count(*) = 0 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'chat_messages' AND column_name = 'scope';
SELECT 'functions_gone' AS check_name, count(*) = 0 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('send_message', 'send_message_as', 'chat_send_message_core', 'chat_messages_scope_guard');
SELECT 'trigger_gone' AS check_name, count(*) = 0 AS ok FROM pg_trigger WHERE tgname = 'trg_chat_messages_scope_guard';
SELECT 'original_client_policies_back' AS check_name, count(*) = 5 AS ok FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chat_messages'
 AND policyname IN ('users_read_own_messages', 'users_send_messages', 'users_mark_received_read', 'users_read_group_messages', 'users_send_group_messages');
SELECT 'catch_all_policy_still_gone' AS check_name, count(*) = 0 AS ok FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chat_messages' AND policyname = 'service_role_manage_chat';
SELECT 'client_write_restored' AS check_name, has_table_privilege('authenticated', 'public.chat_messages', 'INSERT') AND has_table_privilege('authenticated', 'public.chat_messages', 'UPDATE') AS ok;
