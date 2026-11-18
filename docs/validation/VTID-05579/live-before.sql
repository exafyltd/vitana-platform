-- VTID-05579 read-only check BEFORE apply (run by Kiro through RUN-MIGRATION's read-only check; SELECT only).
SELECT 'scope_columns_absent' AS check_name, count(*) = 0 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name IN ('chat_groups', 'chat_group_members') AND column_name = 'scope';
SELECT 'functions_absent' AS check_name, count(*) = 0 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('create_network_group', 'create_network_group_as', 'add_group_member', 'add_group_member_as',
   'chat_group_create_core', 'chat_group_add_member_core', 'chat_groups_scope_guard', 'chat_groups_scope_sync', 'chat_group_members_scope_guard');
SELECT 'prereq_is_network_excluded_account' AS check_name, count(*) = 1 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'is_network_excluded_account';
SELECT 'prereq_network_visible_column' AS check_name, count(*) = 1 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'global_community_profiles' AND column_name = 'network_visible';
SELECT 'prereq_connection_requests' AS check_name, count(*) = 1 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'connection_requests' AND column_name = 'status';
-- Groups the backfill will mark network (written by VTID-05573, row 4 of the legacy migration). 0 means 054000 runs before the
-- legacy data move was applied: apply the legacy rows first.
SELECT 'legacy_network_groups_to_backfill' AS check_name, count(*) AS n FROM public.chat_groups WHERE metadata ->> 'legacy_scope' = 'network';
-- These would make a CHECK fail and roll 054000 back: must be 0.
SELECT 'legacy_network_groups_that_are_system' AS check_name, count(*) = 0 AS ok FROM public.chat_groups
 WHERE metadata ->> 'legacy_scope' = 'network' AND is_system;
SELECT 'legacy_network_groups_with_bot_member' AS check_name, count(*) = 0 AS ok FROM public.chat_group_members m
 JOIN public.chat_groups g ON g.id = m.group_id WHERE g.metadata ->> 'legacy_scope' = 'network' AND m.role = 'bot';
-- Information: a legacy network group over 20 members keeps its members (the cap applies to new members only).
SELECT 'legacy_network_groups_over_20_members' AS check_name, g.id, count(*) AS members FROM public.chat_group_members m
 JOIN public.chat_groups g ON g.id = m.group_id WHERE g.metadata ->> 'legacy_scope' = 'network' GROUP BY g.id HAVING count(*) > 20;
-- Information: listed accounts that are members of a legacy network group (rule 43-45; VTID-05573 should have left none).
SELECT 'legacy_network_members_that_are_excluded' AS check_name, count(*) AS n FROM public.chat_group_members m
 JOIN public.chat_groups g ON g.id = m.group_id
 WHERE g.metadata ->> 'legacy_scope' = 'network' AND public.is_network_excluded_account(m.user_id);
SELECT 'groups_and_members' AS check_name, (SELECT count(*) FROM public.chat_groups) AS groups, (SELECT count(*) FROM public.chat_group_members) AS members;
-- Information: any trigger on the two tables fires on the backfill UPDATE.
SELECT 'triggers_on_group_tables' AS check_name, tgrelid::regclass AS tbl, tgname FROM pg_trigger
 WHERE tgrelid IN ('public.chat_groups'::regclass, 'public.chat_group_members'::regclass) AND NOT tgisinternal ORDER BY 2, 3;
SELECT 'group_policies' AS check_name, tablename, policyname, cmd, qual FROM pg_policies
 WHERE schemaname = 'public' AND tablename IN ('chat_groups', 'chat_group_members') ORDER BY tablename, policyname;
SELECT 'allow_all_policies_already_gone' AS check_name, count(*) = 0 AS ok FROM pg_policies
 WHERE schemaname = 'public' AND tablename IN ('chat_groups', 'chat_group_members', 'chat_messages')
   AND (qual = 'true' OR with_check = 'true' OR (cmd = 'ALL' AND roles && ARRAY['public', 'authenticated', 'anon']::name[]));
-- Apply precondition of 20261102054200: the exact predicate of its closing assertion. ok must be true BEFORE apply, otherwise
-- the file raises and rolls back (any policy on the two tables with a command other than SELECT, USING (true), WITH CHECK (true),
-- or one of the two dropped catch-all names is listed; the two catch-alls are dropped by the file itself first).
SELECT 'p054200_assertion_would_trip' AS check_name, tablename, policyname, cmd, qual, with_check FROM pg_policies
 WHERE schemaname = 'public' AND tablename IN ('chat_groups', 'chat_group_members')
   AND policyname NOT IN ('chat_groups_service_role', 'chat_group_members_service_role', 'chat_groups_member_read', 'chat_group_members_read')
   AND (cmd <> 'SELECT' OR qual = 'true' OR with_check = 'true');
SELECT 'table_grants' AS check_name, relname, relacl FROM pg_class
 WHERE oid IN ('public.chat_groups'::regclass, 'public.chat_group_members'::regclass) ORDER BY relname;
