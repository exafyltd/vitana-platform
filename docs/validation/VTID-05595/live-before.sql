-- VTID-05595 read-only PRE-check BEFORE apply (run by Kiro through RUN-MIGRATION's read-only check; SELECT only).
SELECT 'column_absent' AS check_name, count(*) = 0 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'app_users' AND column_name = 'health_home_tenant_id';
SELECT 'functions_absent' AS check_name, count(*) = 0 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('health_home_tenant_id', 'backfill_health_home_tenant');
SELECT 'is_primary_present' AS check_name, count(*) = 1 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'user_tenants' AND column_name = 'is_primary';
-- The guard in 20261102130100 aborts unless this is 0. A non-zero count means mt-identity-r2 membership unification
-- (queue rows 14-16) has not run yet: do NOT apply 130100; list the members below for quarantine first.
SELECT 'members_without_exactly_one_primary' AS check_name, count(*) AS n FROM (
  SELECT user_id FROM public.user_tenants GROUP BY user_id HAVING count(*) FILTER (WHERE is_primary) <> 1) s;
SELECT 'members_with_zero_primary' AS check_name, count(*) AS n FROM (
  SELECT user_id FROM public.user_tenants GROUP BY user_id HAVING count(*) FILTER (WHERE is_primary) = 0) s;
SELECT 'members_with_two_or_more_primary' AS check_name, count(*) AS n FROM (
  SELECT user_id FROM public.user_tenants GROUP BY user_id HAVING count(*) FILTER (WHERE is_primary) > 1) s;
SELECT 'members_total' AS check_name, count(DISTINCT user_id) AS n FROM public.user_tenants;
SELECT 'ambiguous_member_ids' AS check_name, user_id, count(*) FILTER (WHERE is_primary) AS primary_rows
  FROM public.user_tenants GROUP BY user_id HAVING count(*) FILTER (WHERE is_primary) <> 1 ORDER BY user_id LIMIT 100;
