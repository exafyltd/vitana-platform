-- VTID-05573 read-only check BEFORE apply (run by Kiro through RUN-MIGRATION's read-only check; SELECT only).
-- Row counts to compare with the plan's figures (12 / 5 / 60 / 379) and with the post-apply counts.
SELECT 'legacy_row_counts' AS check_name,
  (SELECT count(*) FROM public.messages) AS messages, (SELECT count(*) FROM public.message_threads) AS message_threads,
  (SELECT count(*) FROM public.global_message_threads) AS global_message_threads, (SELECT count(*) FROM public.global_messages) AS global_messages,
  (SELECT count(*) FROM public.thread_participants) AS thread_participants, (SELECT count(*) FROM public.global_thread_participants) AS global_thread_participants;
SELECT 'chat_rows_before' AS check_name, (SELECT count(*) FROM public.chat_messages) AS chat_messages, (SELECT count(*) FROM public.chat_groups) AS chat_groups,
  (SELECT count(*) FROM public.chat_group_members) AS chat_group_members;
SELECT 'bak_absent' AS check_name, count(*) = 0 AS ok FROM pg_class WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('bak_messages', 'bak_message_threads', 'bak_global_messages', 'bak_global_message_threads', 'bak_thread_participants', 'bak_global_thread_participants');
SELECT 'migrate_functions_absent' AS check_name, count(*) = 0 AS ok FROM pg_proc WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('mt_legacy_messages_migrate', 'mt_legacy_messages_assert_ready', 'mt_legacy_common_tenant', 'mt_legacy_context_tenant');
SELECT 'dependencies_present' AS check_name,
  (SELECT count(*) = 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chat_messages' AND column_name = 'scope') AS chat_messages_scope,
  to_regprocedure('public.is_network_excluded_account(uuid)') IS NOT NULL AS exclusion_helper;
-- Anything besides the participant tables that depends on the four tables would make the drop fail (by design): list it now.
SELECT 'fks_onto_legacy' AS check_name, c.conrelid::regclass::text AS from_table, c.conname, c.confrelid::regclass::text AS onto
  FROM pg_constraint c WHERE c.contype = 'f' AND c.confrelid::regclass::text IN ('messages', 'message_threads', 'global_messages', 'global_message_threads', 'public.messages', 'public.message_threads', 'public.global_messages', 'public.global_message_threads');
SELECT 'views_or_policies_naming_legacy' AS check_name, 'view' AS kind, schemaname || '.' || viewname AS name FROM pg_views
  WHERE definition ~* '\y(global_messages|global_message_threads|message_threads)\y' OR definition ~* 'public\.messages\y'
UNION ALL SELECT 'views_or_policies_naming_legacy', 'policy', schemaname || '.' || tablename || ':' || policyname FROM pg_policies
  WHERE tablename NOT IN ('messages', 'message_threads', 'global_messages', 'global_message_threads')
    AND (coalesce(qual, '') || coalesce(with_check, '')) ~* '\y(global_messages|global_message_threads|message_threads)\y';
-- Triggers on the targets: a backfill insert fires them (notifications, welcome-chat, counters). Review before apply.
SELECT 'target_triggers' AS check_name, event_object_table, trigger_name, action_timing, event_manipulation
  FROM information_schema.triggers WHERE event_object_schema = 'public' AND event_object_table IN ('chat_messages', 'chat_groups', 'chat_group_members')
 ORDER BY 2, 3;
-- Rule 43-45 impact: how many legacy rows involve a listed account (they are NOT migrated).
SELECT 'legacy_rows_with_listed_accounts' AS check_name,
  (SELECT count(*) FROM public.messages m WHERE public.is_network_excluded_account(m.sender_id) OR public.is_network_excluded_account(m.recipient_id)) AS messages,
  (SELECT count(*) FROM public.global_messages g WHERE public.is_network_excluded_account(g.sender_id)) AS global_messages;
-- Grants as they are now: 052000 keeps these in the bak_* comment and rollback-052000 restores them. PUBLIC shows as grantee 0.
SELECT 'legacy_table_acl' AS check_name, c.relname, c.relacl::text AS acl
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
   AND c.relname IN ('messages', 'message_threads', 'global_message_threads', 'global_messages', 'thread_participants', 'global_thread_participants') ORDER BY 2;
-- PRECONDITION of owner approval: target_triggers above lists only trg_chat_messages_scope_guard (VTID-05576), fks_onto_legacy and
-- views_or_policies_naming_legacy list nothing unexpected. See acceptance.md "Apply preconditions".
