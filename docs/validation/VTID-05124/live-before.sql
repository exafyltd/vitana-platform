-- VTID-05124 — read-only pre-check, re-run right before RUN-MIGRATION applies
-- data-fixups/20261012214500_vtid_05124_delete_orphan_memberships.sql.
-- Every statement is a SELECT. Proceed ONLY if query 1 shows 10..14 orphans, query 3 shows 0 FK
-- dependents and query 4 shows 0 live identities. Below 10 or above 14: abandon, do not widen the
-- bounds, do not apply; report the new count to the owner.
--
-- Captured 2026-10-12 against project inmkhvwdcuyhnxkgfvsb (expected values on each query):
--   total 235, orphans 12 (maxina 11, alkalma 1), 0 FK dependents, 0 triggers, 0 live identities,
--   archive table absent, admin_system_health.total_memberships 235.

-- 1. Totals. Expect total = 235, orphans = 12, orphans_no_auth = 12.
SELECT (SELECT count(*) FROM public.memberships) AS total,
       (SELECT count(*) FROM public.memberships m
         WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = m.user_id)
           AND NOT EXISTS (SELECT 1 FROM public.app_users a WHERE a.user_id = m.user_id)) AS orphans,
       (SELECT count(*) FROM public.memberships m
         WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = m.user_id)) AS orphans_no_auth;

-- 2. The orphan rows themselves. Expect 12 rows, ids starting 2f8a7363, 4ff64983, 27f7fabd,
--    fabf5609, 719384c1, 85a06581, c58d9a65, 7991f567, cdecbdd8, 1d69bb22, 59eb8d06, 89ccdbb5;
--    maxina 11 / alkalma 1; roles 11 community, 1 reseller; updated_at = created_at.
SELECT m.id, t.slug, m.user_id, m.role, m.status, m.created_at, m.updated_at
  FROM public.memberships m
  JOIN public.tenants t ON t.tenant_id = m.tenant_id
 WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = m.user_id)
   AND NOT EXISTS (SELECT 1 FROM public.app_users a WHERE a.user_id = m.user_id)
 ORDER BY t.slug, m.created_at;

-- 3. Dependents and triggers. Expect fk_dependents = 0, triggers = 0.
SELECT (SELECT count(*) FROM pg_constraint
         WHERE contype = 'f' AND confrelid = 'public.memberships'::regclass) AS fk_dependents,
       (SELECT count(*) FROM pg_trigger
         WHERE tgrelid = 'public.memberships'::regclass AND NOT tgisinternal) AS triggers;

-- 4. No live identity among the orphans (user_tenants / profiles). Expect 0.
SELECT count(*) AS live_identities
  FROM public.memberships m
 WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = m.user_id)
   AND NOT EXISTS (SELECT 1 FROM public.app_users a WHERE a.user_id = m.user_id)
   AND (EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = m.user_id)
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = m.user_id OR p.id = m.user_id));

-- 5. The archive does not exist yet, and the admin baseline. Expect archive_table = NULL,
--    total_memberships = 235 (record active_memberships too: post-apply expects both to drop by 12).
SELECT to_regclass('legacy_archive.bak_fu8_orphan_memberships_20261012') AS archive_table,
       h.total_memberships, h.active_memberships
  FROM public.admin_system_health h;
