-- VTID-05579 read-only check AFTER apply of all three files (SELECT only). Every row must say ok = true.
SELECT 'scope_columns' AS check_name, count(*) = 2 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name IN ('chat_groups', 'chat_group_members') AND column_name = 'scope'
   AND data_type = 'text' AND is_nullable = 'NO' AND column_default LIKE '%community%';
SELECT 'constraints' AS check_name, count(*) = 4 AS ok FROM pg_constraint
 WHERE conname IN ('chat_groups_scope_check', 'chat_group_members_scope_check', 'chat_groups_network_not_system', 'chat_group_members_network_no_bot');
SELECT 'every_group_has_a_scope' AS check_name, count(*) = 0 AS ok FROM public.chat_groups WHERE scope IS NULL OR scope NOT IN ('community', 'network');
SELECT 'legacy_groups_backfilled' AS check_name, count(*) = 0 AS ok FROM public.chat_groups
 WHERE metadata ->> 'legacy_scope' = 'network' AND scope <> 'network';
SELECT 'members_follow_their_group' AS check_name, count(*) = 0 AS ok FROM public.chat_group_members m
 JOIN public.chat_groups g ON g.id = m.group_id WHERE m.scope IS DISTINCT FROM g.scope;
SELECT 'network_groups_are_not_system_and_have_no_bot' AS check_name,
  (SELECT count(*) FROM public.chat_groups WHERE scope = 'network' AND is_system) = 0
  AND (SELECT count(*) FROM public.chat_group_members WHERE scope = 'network' AND role = 'bot') = 0 AS ok;
SELECT 'no_rule_43_45_member_in_a_network_group' AS check_name, count(*) = 0 AS ok FROM public.chat_group_members m
 WHERE m.scope = 'network' AND public.is_network_excluded_account(m.user_id);
SELECT 'no_function_created_group_over_20' AS check_name, count(*) = 0 AS ok FROM (
  SELECT g.id FROM public.chat_groups g JOIN public.chat_group_members m ON m.group_id = g.id
   WHERE g.scope = 'network' AND coalesce(g.metadata ->> 'legacy_scope', '') <> 'network' GROUP BY g.id HAVING count(*) > 20) x;
SELECT 'triggers' AS check_name, count(*) = 3 AS ok FROM pg_trigger
 WHERE tgrelid IN ('public.chat_groups'::regclass, 'public.chat_group_members'::regclass) AND NOT tgisinternal
   AND tgname IN ('trg_chat_groups_scope_guard', 'trg_chat_groups_scope_sync', 'trg_chat_group_members_scope_guard');
SELECT 'functions_definer_pinned' AS check_name, count(*) = 6 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('create_network_group', 'create_network_group_as', 'add_group_member', 'add_group_member_as',
   'chat_group_create_core', 'chat_group_add_member_core') AND p.prosecdef AND p.proconfig::text LIKE '%search_path%';
SELECT 'execute_grants' AS check_name,
  has_function_privilege('authenticated', 'public.create_network_group(text,text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.add_group_member(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.create_network_group(text,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.add_group_member(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.create_network_group_as(uuid,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.add_group_member_as(uuid,uuid,uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.create_network_group_as(uuid,text,text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.add_group_member_as(uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.chat_group_add_member_core(uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.chat_group_create_core(uuid,text,text)', 'EXECUTE') AS ok;
SELECT 'read_policies_participant_only' AS check_name, count(*) = 2 AS ok FROM pg_policies
 WHERE schemaname = 'public' AND tablename IN ('chat_groups', 'chat_group_members') AND cmd = 'SELECT'
   AND qual ~ 'is_chat_group_member' AND qual ~ 'SELECT auth\.uid\(\)';
SELECT 'no_allow_all_or_write_policy' AS check_name, count(*) = 0 AS ok FROM pg_policies
 WHERE schemaname = 'public' AND tablename IN ('chat_groups', 'chat_group_members')
   AND (cmd <> 'SELECT' OR qual = 'true' OR with_check = 'true' OR policyname IN ('chat_groups_service_role', 'chat_group_members_service_role'));
SELECT 'no_allow_all_on_chat_messages' AS check_name, count(*) = 0 AS ok FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'chat_messages' AND (qual = 'true' OR with_check = 'true' OR (cmd = 'ALL' AND roles && ARRAY['public', 'authenticated', 'anon']::name[]));
SELECT 'no_bare_current_tenant_id_policy' AS check_name, count(*) = 0 AS ok FROM pg_policies
 WHERE schemaname = 'public' AND tablename IN ('chat_groups', 'chat_group_members') AND (coalesce(qual, '') ~ 'current_tenant_id' OR coalesce(with_check, '') ~ 'current_tenant_id');
