-- VTID-05124 — read-only verification after RUN-MIGRATION applied
-- data-fixups/20261012214500_vtid_05124_delete_orphan_memberships.sql.
-- Every statement is a SELECT; record the results in docs/validation/VTID-05124/outputs/.
-- Expected values assume live-before.sql showed 12 orphans and 235 rows; if it showed another
-- count N (10..14), expect N archived and 235 - N remaining.

-- 1. No orphan memberships left. Expect 0, 0.
SELECT (SELECT count(*) FROM public.memberships m
         WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = m.user_id)) AS orphans_no_auth,
       (SELECT count(*) FROM public.memberships m
         WHERE NOT EXISTS (SELECT 1 FROM public.app_users a WHERE a.user_id = m.user_id)) AS orphans_no_app_user;

-- 2. Archive holds the deleted rows, and none of them is still in memberships. Expect 12, 0.
SELECT (SELECT count(*) FROM legacy_archive.bak_fu8_orphan_memberships_20261012) AS archived,
       (SELECT count(*) FROM legacy_archive.bak_fu8_orphan_memberships_20261012 b
         JOIN public.memberships m ON m.id = b.id) AS archived_still_present;

-- 3. Remaining total. Expect 223.
SELECT count(*) AS memberships_total FROM public.memberships;

-- 4. Admin counts. Expect total_memberships and active_memberships each 12 lower than the
--    values recorded by live-before.sql query 5 (235 -> 223 for total).
SELECT h.total_memberships, h.active_memberships FROM public.admin_system_health h;

-- 5. The archive is not exposed. Expect false, false, false, false.
SELECT has_schema_privilege('anon', 'legacy_archive', 'usage')                                           AS anon_schema_usage,
       has_schema_privilege('authenticated', 'legacy_archive', 'usage')                                  AS authenticated_schema_usage,
       has_table_privilege('anon', 'legacy_archive.bak_fu8_orphan_memberships_20261012', 'select')       AS anon_select,
       has_table_privilege('authenticated', 'legacy_archive.bak_fu8_orphan_memberships_20261012', 'select') AS authenticated_select;
