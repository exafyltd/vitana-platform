-- VTID-05491 rollback-check: READ-ONLY (SELECT only). After the three rollback files ran (070600, 070150, 070100).
-- Expect: no tenant_id column, none of the five functions, no new trigger, the original three content_reports policies and the
-- original moderation_actions policy not referencing the flag. The snapshot tables remain.
SELECT table_name, count(*) FILTER (WHERE column_name = 'tenant_id') AS has_tenant_id
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('content_reports', 'moderation_actions') GROUP BY table_name ORDER BY 1;
SELECT count(*) AS leftover_functions FROM pg_proc WHERE pronamespace = 'public'::regnamespace
   AND proname IN ('is_tenant_moderator', 'moderation_home_tenant', 'moderation_list_reports', 'moderation_resolve_report', 'moderator_tenant_scope_enabled', 'content_reports_stamp_tenant', 'content_reports_review_guard');
SELECT count(*) AS leftover_triggers FROM pg_trigger WHERE tgname IN ('trg_content_reports_stamp_tenant', 'trg_content_reports_review_guard') AND NOT tgisinternal;
SELECT tablename, policyname, cmd, (coalesce(qual, '') LIKE '%moderator_tenant_scope_enabled%') AS scope_aware
  FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('content_reports', 'moderation_actions') ORDER BY 1, 2;
