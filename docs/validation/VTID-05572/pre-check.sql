-- VTID-05572 read-only PRE-check (run by Kiro through RUN-MIGRATION's read-only check, never from this PR).
-- Run BEFORE 20261102042100_vtid_05572_profiles_tenant_backfill_run.sql (and after the membership unification rows 14-16).
-- SELECT statements only.

-- 1. Profiles with and without tenant_id (plan premise 4: NULL for all members today).
SELECT count(*)                                     AS profiles,
       count(*) FILTER (WHERE tenant_id IS NULL)     AS profiles_without_tenant_id,
       count(*) FILTER (WHERE tenant_id IS NOT NULL) AS profiles_with_tenant_id
  FROM public.profiles;

-- 2. What the backfill would do: members by membership count (bots and service accounts excluded).
SELECT n AS memberships, count(*) AS profiles_with_null_tenant FROM (
  SELECT p.user_id, count(ut.id) AS n
    FROM public.profiles p LEFT JOIN public.user_tenants ut ON ut.user_id = p.user_id
   WHERE p.tenant_id IS NULL
     AND p.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
     AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = p.user_id)
   GROUP BY p.user_id) s
 GROUP BY n ORDER BY n;

-- 3. The column is nullable and must stay so.
SELECT is_nullable FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'tenant_id';
