-- VTID-05573 read-only check AFTER a full rollback (SELECT only). Every row with an ok column must say true.
SELECT 'legacy_tables_back' AS check_name, count(*) = 4 AS ok FROM pg_class WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('messages', 'message_threads', 'global_message_threads', 'global_messages');
SELECT 'exact_row_counts_restored' AS check_name,
  (SELECT count(*) FROM public.messages) = (SELECT count(*) FROM public.bak_messages)
  AND (SELECT count(*) FROM public.message_threads) = (SELECT count(*) FROM public.bak_message_threads)
  AND (SELECT count(*) FROM public.global_message_threads) = (SELECT count(*) FROM public.bak_global_message_threads)
  AND (SELECT count(*) FROM public.global_messages) = (SELECT count(*) FROM public.bak_global_messages) AS ok;
SELECT 'exact_rows_restored' AS check_name,
  NOT EXISTS (SELECT 1 FROM (SELECT * FROM public.bak_messages EXCEPT SELECT * FROM public.messages) d)
  AND NOT EXISTS (SELECT 1 FROM (SELECT * FROM public.bak_global_messages EXCEPT SELECT * FROM public.global_messages) d) AS ok;
SELECT 'migrated_rows_gone' AS check_name,
  (SELECT count(*) FROM public.chat_messages WHERE metadata ->> 'legacy_source' IS NOT NULL) = 0
  AND (SELECT count(*) FROM public.chat_groups WHERE metadata ->> 'legacy_source' IS NOT NULL) = 0 AS ok;
SELECT 'functions_gone' AS check_name, count(*) = 0 AS ok FROM pg_proc WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('mt_legacy_messages_migrate', 'mt_legacy_messages_assert_ready', 'mt_legacy_common_tenant', 'mt_legacy_context_tenant');
SELECT 'restored_tables_not_client_readable' AS check_name,
  NOT (has_table_privilege('anon', 'public.messages', 'SELECT') OR has_table_privilege('authenticated', 'public.messages', 'SELECT')
    OR has_table_privilege('authenticated', 'public.global_messages', 'SELECT')) AS ok;
SELECT 'snapshots_kept' AS check_name, count(*) = 6 AS ok FROM pg_class WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('bak_messages', 'bak_message_threads', 'bak_global_messages', 'bak_global_message_threads', 'bak_thread_participants', 'bak_global_thread_participants');
