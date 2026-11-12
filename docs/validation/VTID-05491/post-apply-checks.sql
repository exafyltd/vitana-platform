-- VTID-05491 post-apply-checks: READ-ONLY (SELECT only). Run after 070100, 070150 and 070600.
-- Expect: both tenant_id columns present; helper/RPC/flag functions listed; both triggers present; the three content_reports policies
-- and the moderation_actions policy present and referencing moderator_tenant_scope_enabled (except the INSERT policy);
-- snapshot row counts equal the pre-change counts; no flagged tenant yet (flag off = today's behaviour).
SELECT table_name, count(*) FILTER (WHERE column_name = 'tenant_id') AS has_tenant_id
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('content_reports', 'moderation_actions') GROUP BY table_name ORDER BY 1;
SELECT proname, prosecdef AS security_definer FROM pg_proc WHERE pronamespace = 'public'::regnamespace
   AND proname IN ('is_tenant_moderator', 'moderation_home_tenant', 'moderation_list_reports', 'moderation_resolve_report', 'moderator_tenant_scope_enabled', 'content_reports_stamp_tenant', 'content_reports_review_guard') ORDER BY 1;
SELECT tgname, tgrelid::regclass AS on_table FROM pg_trigger WHERE tgname IN ('trg_content_reports_stamp_tenant', 'trg_content_reports_review_guard') AND NOT tgisinternal ORDER BY 1;
SELECT tablename, policyname, cmd, (coalesce(qual, '') LIKE '%moderator_tenant_scope_enabled%') AS scope_aware
  FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('content_reports', 'moderation_actions') ORDER BY 1, 2;
SELECT (SELECT count(*) FROM legacy_archive.bak_05491_content_reports) AS snapshot_reports, (SELECT count(*) FROM public.content_reports) AS reports,
       (SELECT count(*) FROM legacy_archive.bak_05491_moderation_actions) AS snapshot_actions, (SELECT count(*) FROM public.moderation_actions) AS actions;
SELECT (SELECT count(*) FROM public.content_reports WHERE tenant_id IS NULL) AS reports_null_tenant,
       (SELECT count(*) FROM public.moderation_actions WHERE tenant_id IS NULL) AS actions_null_tenant;
SELECT count(*) AS tenants_with_flag_on FROM public.tenant_settings WHERE feature_flags -> 'mt' ->> 'moderator_tenant_scope' = 'true';
