-- VTID-05573 read-only check AFTER apply of all four files (SELECT only). Every row with an ok column must say true.
SELECT 'legacy_tables_gone' AS check_name, count(*) = 0 AS ok FROM pg_class WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('messages', 'message_threads', 'global_message_threads', 'global_messages');
SELECT 'bak_tables_present_rls_no_client_grant' AS check_name,
  count(*) = 6 AND bool_and(relrowsecurity)
  AND NOT bool_or(has_table_privilege('anon', oid, 'SELECT') OR has_table_privilege('authenticated', oid, 'SELECT')) AS ok
  FROM pg_class WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('bak_messages', 'bak_message_threads', 'bak_global_messages', 'bak_global_message_threads', 'bak_thread_participants', 'bak_global_thread_participants');
-- Pre/post row counts: the snapshot is the "before" figure; migrated rows carry metadata.legacy_source.
SELECT 'snapshot_row_counts' AS check_name,
  (SELECT count(*) FROM public.bak_messages) AS messages, (SELECT count(*) FROM public.bak_message_threads) AS message_threads,
  (SELECT count(*) FROM public.bak_global_message_threads) AS global_message_threads, (SELECT count(*) FROM public.bak_global_messages) AS global_messages;
SELECT 'migrated_row_counts' AS check_name,
  (SELECT count(*) FROM public.chat_messages WHERE metadata ->> 'legacy_source' = 'messages') AS from_messages,
  (SELECT count(*) FROM public.chat_messages WHERE metadata ->> 'legacy_source' = 'global_messages') AS from_global_messages,
  (SELECT count(*) FROM public.chat_groups WHERE metadata ->> 'legacy_source' IS NOT NULL) AS groups,
  (SELECT count(*) FROM public.chat_group_members m JOIN public.chat_groups g ON g.id = m.group_id WHERE g.metadata ->> 'legacy_source' IS NOT NULL) AS group_members;
SELECT 'migrated_by_scope' AS check_name, scope, count(*) AS n FROM public.chat_messages WHERE metadata ->> 'legacy_source' IS NOT NULL GROUP BY scope ORDER BY scope;
SELECT 'every_migrated_row_has_valid_scope' AS check_name, count(*) = 0 AS ok FROM public.chat_messages
 WHERE metadata ->> 'legacy_source' IS NOT NULL AND (scope IS NULL OR scope NOT IN ('community', 'network'));
SELECT 'no_listed_account_migrated' AS check_name, count(*) = 0 AS ok FROM public.chat_messages c
 WHERE c.metadata ->> 'legacy_source' IS NOT NULL AND (public.is_network_excluded_account(c.sender_id) OR public.is_network_excluded_account(c.receiver_id));
SELECT 'no_listed_group_member' AS check_name, count(*) = 0 AS ok FROM public.chat_group_members m JOIN public.chat_groups g ON g.id = m.group_id
 WHERE g.metadata ->> 'legacy_source' IS NOT NULL AND public.is_network_excluded_account(m.user_id);
SELECT 'no_platform_tenant_on_migrated_content' AS check_name, count(*) = 0 AS ok FROM public.chat_messages c JOIN public.tenants t ON t.tenant_id = c.tenant_id
 WHERE c.metadata ->> 'legacy_source' IS NOT NULL AND t.is_platform;
SELECT 'functions_service_role_only' AS check_name, count(*) = 4 AS ok FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('mt_legacy_messages_migrate', 'mt_legacy_messages_assert_ready', 'mt_legacy_common_tenant', 'mt_legacy_context_tenant')
   AND p.prosecdef AND p.proconfig::text LIKE '%search_path%' AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE');
