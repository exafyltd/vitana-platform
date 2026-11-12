-- VTID-05572 read-only POST-check (run through RUN-MIGRATION's read-only check after 20261102042100_..._run.sql).
-- SELECT statements only. Every "bad_*" value must be 0.

SELECT count(*)                                     AS profiles,
       count(*) FILTER (WHERE tenant_id IS NULL)     AS profiles_without_tenant_id,
       count(*) FILTER (WHERE tenant_id IS NOT NULL) AS profiles_with_tenant_id
  FROM public.profiles;

-- Backfilled profiles that do not hold their single membership tenant.
SELECT count(*) AS bad_backfilled
  FROM legacy_archive.mt_profiles_tenant_backfill_log l
  JOIN public.profiles p ON p.user_id = l.user_id
 WHERE p.tenant_id IS DISTINCT FROM l.tenant_id
    OR NOT EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = p.user_id AND ut.tenant_id = p.tenant_id);

-- Single-membership members still NULL (service accounts and the bot excluded).
SELECT count(*) AS bad_single_membership_still_null
  FROM public.profiles p
 WHERE p.tenant_id IS NULL
   AND p.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
   AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = p.user_id)
   AND (SELECT count(*) FROM public.user_tenants ut WHERE ut.user_id = p.user_id) = 1;

-- The review list: members left NULL, by reason.
SELECT reason, count(*) AS members FROM legacy_archive.mt_profiles_tenant_unresolved GROUP BY reason ORDER BY reason;

SELECT is_nullable AS tenant_id_nullable FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'tenant_id';
