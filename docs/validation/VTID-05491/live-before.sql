-- VTID-05491 live-before: READ-ONLY (SELECT only). Run before 20261102070100 to record the starting state.
SELECT to_regclass('public.content_reports') AS content_reports, to_regclass('public.moderation_actions') AS moderation_actions,
       to_regclass('public.memberships') AS memberships, to_regclass('public.user_tenants') AS user_tenants;
SELECT table_name, count(*) FILTER (WHERE column_name = 'tenant_id') AS has_tenant_id
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('content_reports', 'moderation_actions') GROUP BY table_name ORDER BY 1;
SELECT (SELECT count(*) FROM public.content_reports) AS reports, (SELECT count(*) FROM public.moderation_actions) AS actions;
SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('content_reports', 'moderation_actions') ORDER BY 1, 2;
SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
   AND proname IN ('is_tenant_moderator', 'moderation_home_tenant', 'moderation_list_reports', 'moderation_resolve_report', 'moderator_tenant_scope_enabled');
