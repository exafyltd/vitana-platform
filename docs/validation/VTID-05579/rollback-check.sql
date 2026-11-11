-- VTID-05579 read-only check AFTER a full rollback (SELECT only). Every row must say ok = true.
SELECT 'scope_columns_gone' AS check_name, count(*) = 0 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name IN ('chat_groups', 'chat_group_members') AND column_name = 'scope';
SELECT 'constraints_gone' AS check_name, count(*) = 0 AS ok FROM pg_constraint
 WHERE conname IN ('chat_groups_scope_check', 'chat_group_members_scope_check', 'chat_groups_network_not_system', 'chat_group_members_network_no_bot');
SELECT 'triggers_gone' AS check_name, count(*) = 0 AS ok FROM pg_trigger
 WHERE tgname IN ('trg_chat_groups_scope_guard', 'trg_chat_groups_scope_sync', 'trg_chat_group_members_scope_guard');
SELECT 'functions_gone' AS check_name, count(*) = 0 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('create_network_group', 'create_network_group_as', 'add_group_member', 'add_group_member_as',
   'chat_group_create_core', 'chat_group_add_member_core', 'chat_groups_scope_guard', 'chat_groups_scope_sync', 'chat_group_members_scope_guard');
SELECT 'read_policies_back_to_per_row_form' AS check_name, count(*) = 2 AS ok FROM pg_policies
 WHERE schemaname = 'public' AND tablename IN ('chat_groups', 'chat_group_members') AND cmd = 'SELECT'
   AND qual ~ 'is_chat_group_member' AND qual !~ 'SELECT auth\.uid\(\)';
SELECT 'catch_all_policies_still_gone' AS check_name, count(*) = 0 AS ok FROM pg_policies
 WHERE schemaname = 'public' AND tablename IN ('chat_groups', 'chat_group_members') AND (cmd <> 'SELECT' OR qual = 'true' OR with_check = 'true');
SELECT 'no_group_or_member_lost' AS check_name, (SELECT count(*) FROM public.chat_groups) > 0 AND (SELECT count(*) FROM public.chat_group_members) > 0 AS ok;
