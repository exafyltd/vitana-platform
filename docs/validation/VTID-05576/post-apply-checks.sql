-- VTID-05576 read-only check AFTER apply of all three files (SELECT only). Every row must say ok = true.
SELECT 'scope_column' AS check_name, count(*) = 1 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'chat_messages' AND column_name = 'scope' AND is_nullable = 'NO' AND column_default IS NULL;
SELECT 'scope_check' AS check_name, count(*) = 1 AS ok FROM pg_constraint WHERE conrelid = 'public.chat_messages'::regclass AND conname = 'chat_messages_scope_check';
SELECT 'every_row_has_a_scope' AS check_name, count(*) = 0 AS ok FROM public.chat_messages WHERE scope IS NULL OR scope NOT IN ('community', 'network');
SELECT 'guard_trigger' AS check_name, count(*) = 1 AS ok FROM pg_trigger WHERE tgrelid = 'public.chat_messages'::regclass AND tgname = 'trg_chat_messages_scope_guard' AND NOT tgisinternal;
SELECT 'functions_definer_pinned' AS check_name, count(*) = 3 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('send_message', 'send_message_as', 'chat_send_message_core') AND p.prosecdef AND p.proconfig::text LIKE '%search_path%';
SELECT 'execute_grants' AS check_name, has_function_privilege('authenticated', 'public.send_message(uuid,uuid,text,text,text,jsonb,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.send_message(uuid,uuid,text,text,text,jsonb,uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.send_message_as(uuid,uuid,uuid,text,text,text,jsonb,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.send_message_as(uuid,uuid,uuid,text,text,text,jsonb,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.chat_send_message_core(uuid,uuid,uuid,text,text,text,jsonb,uuid)', 'EXECUTE') AS ok;
SELECT 'catch_all_policy_gone' AS check_name, count(*) = 0 AS ok FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'chat_messages' AND (policyname = 'service_role_manage_chat' OR cmd IN ('ALL', 'INSERT') OR qual = 'true' OR with_check = 'true');
SELECT 'narrow_policies' AS check_name, count(*) = 3 AS ok FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chat_messages'
 AND policyname IN ('chat_messages_participant_read', 'chat_messages_recipient_mark_read', 'users_read_group_messages');
SELECT 'client_write_revoked' AS check_name, NOT has_table_privilege('authenticated', 'public.chat_messages', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.chat_messages', 'INSERT') AND NOT has_table_privilege('authenticated', 'public.chat_messages', 'UPDATE')
  AND has_column_privilege('authenticated', 'public.chat_messages', 'read_at', 'UPDATE')
  AND NOT has_column_privilege('authenticated', 'public.chat_messages', 'content', 'UPDATE') AS ok;
