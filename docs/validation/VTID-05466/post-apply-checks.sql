-- VTID-05466 — read-only post-apply checks (SELECT only), after 20261102031000 and 20261102031200.

-- 1. The backfill log matches what was inserted, and holds no bot or service account.
SELECT count(*) AS logged,
       count(*) FILTER (WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid
                           OR user_id IN (SELECT user_id FROM public.service_bot_accounts)) AS bots_logged
  FROM legacy_archive.bak_05466_backfill_log_20261102;

-- 2. No side effect for a backfilled user (expected 0 on every column).
SELECT (SELECT count(*) FROM public.chat_messages c JOIN legacy_archive.bak_05466_backfill_log_20261102 l
          ON c.sender_id = l.user_id AND c.created_at >= l.logged_at) AS welcome_chats,
       (SELECT count(*) FROM public.founding_members f JOIN legacy_archive.bak_05466_backfill_log_20261102 l
          ON f.user_id = l.user_id AND f.created_at >= l.logged_at) AS founding_seats,
       (SELECT count(*) FROM public.live_rooms r JOIN legacy_archive.bak_05466_backfill_log_20261102 l
          ON r.host_user_id = l.user_id AND r.created_at >= l.logged_at) AS live_rooms;

-- 3. The drift report: memberships_not_in_user_tenants = 0.
SELECT public.membership_drift_report();

-- 4. Service-role-only and VTID-05147 AC-5 (every value false except the last two).
SELECT has_table_privilege('authenticated', 'public.membership_drift_reports', 'SELECT') AS auth_reads_reports,
       has_table_privilege('anon', 'public.membership_drift_reports', 'SELECT') AS anon_reads_reports,
       has_function_privilege('authenticated', 'public.membership_drift_report()', 'EXECUTE') AS auth_runs_report,
       has_function_privilege('authenticated', 'public.mt_backfill_memberships_to_user_tenants()', 'EXECUTE') AS auth_runs_backfill,
       has_table_privilege('authenticated', 'public.user_tenants', 'INSERT')
         OR has_table_privilege('authenticated', 'public.user_tenants', 'UPDATE') AS auth_writes_user_tenants,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'membership_drift_reports') AS report_policies,
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.membership_drift_reports'::regclass) AS report_rls_on,
       has_table_privilege('service_role', 'public.membership_drift_reports', 'SELECT') AS service_reads_reports;

-- 5. The deferred dual-write trigger (expected: one row, deferrable, initially deferred; memberships relkind r).
SELECT tgname, tgdeferrable, tginitdeferred,
       (SELECT relkind FROM pg_class WHERE oid = 'public.memberships'::regclass) AS memberships_relkind,
       has_function_privilege('authenticated', 'public.memberships_dualwrite_user_tenants()', 'EXECUTE') AS auth_runs_dualwrite
  FROM pg_trigger WHERE tgrelid = 'public.memberships'::regclass AND tgname = 'memberships_dualwrite_user_tenants';

-- 6. The nightly job (where pg_cron exists).
SELECT jobname, schedule, command FROM cron.job WHERE jobname = 'membership-drift-report-nightly';
