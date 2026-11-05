-- VTID-05466 — read-only pre-apply checks for 20261102031000 / 20261102031200 (SELECT only).
-- Run in the RUN-MIGRATION pre-check, after the owner approves the files and the target database
-- (collaboration.md §7d). Expected values come from the VTID-05043 / VTID-05124 records; any
-- difference is reported to the owner before the apply.

-- 1. Rows the backfill would insert (expected 0; the migration aborts above 30).
SELECT count(*) AS to_backfill
  FROM public.memberships m
 WHERE m.status = 'active'
   AND m.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
   AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = m.user_id)
   AND EXISTS (SELECT 1 FROM public.app_users au WHERE au.user_id = m.user_id)
   AND NOT EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.tenant_id = m.tenant_id AND ut.user_id = m.user_id);

-- 2. Stranded: auth user without app_users (expected 0; the migration aborts otherwise).
SELECT count(*) AS stranded
  FROM public.memberships m
 WHERE m.status = 'active'
   AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = m.user_id)
   AND NOT EXISTS (SELECT 1 FROM public.app_users au WHERE au.user_id = m.user_id)
   AND NOT EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.tenant_id = m.tenant_id AND ut.user_id = m.user_id);

-- 3. Both drift directions and the non-active rows (informational).
SELECT (SELECT count(*) FROM public.memberships) AS memberships_total,
       (SELECT count(*) FROM public.memberships WHERE status <> 'active') AS memberships_not_active,
       (SELECT count(*) FROM public.user_tenants ut
         WHERE NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id = ut.tenant_id AND m.user_id = ut.user_id)) AS user_tenants_not_in_memberships;

-- 4. The four side-effect triggers still carry the suppression guard.
SELECT tgname, pg_get_triggerdef(t.oid) LIKE '%membership_side_effects_suppressed()%' AS guarded
  FROM pg_trigger t
 WHERE t.tgrelid = 'public.user_tenants'::regclass
   AND tgname IN ('welcome_chat_on_primary_membership', 'founding_seat_on_primary_membership',
                  'seed_onboarding_autopilot_on_primary_membership', 'trg_create_user_live_room');

-- 5. Nothing of this lane exists yet.
SELECT to_regclass('legacy_archive.bak_05466_backfill_log_20261102') AS backfill_log,
       to_regclass('public.membership_drift_reports') AS drift_table,
       to_regprocedure('public.membership_drift_report()') AS drift_fn,
       to_regprocedure('public.memberships_dualwrite_user_tenants()') AS dualwrite_fn;

-- 6. memberships is still a table and carries no insert trigger yet (expected relkind r, 0 triggers).
SELECT (SELECT relkind FROM pg_class WHERE oid = 'public.memberships'::regclass) AS relkind,
       (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.memberships'::regclass AND NOT tgisinternal) AS triggers;
