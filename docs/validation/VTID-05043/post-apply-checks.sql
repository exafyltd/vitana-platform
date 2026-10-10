-- VTID-05043 — read-only verification after Migrations A, B, C are applied to production.
-- Every statement is a SELECT; run each and record the result in post-apply-results.md.
-- Expected values are on the line above each query.

-- 1. Four primary-membership triggers present, enabled ('O'), guarded. Expect 4 rows, all
--    tgenabled = 'O' and def containing "membership_side_effects_suppressed()".
SELECT t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS def,
       pg_get_triggerdef(t.oid) ~ 'NOT (public\.)?membership_side_effects_suppressed\(\)' AS guarded
  FROM pg_trigger t
 WHERE t.tgrelid = 'public.user_tenants'::regclass AND NOT t.tgisinternal
   AND t.tgname IN ('welcome_chat_on_primary_membership', 'founding_seat_on_primary_membership',
                    'seed_onboarding_autopilot_on_primary_membership', 'trg_create_user_live_room')
 ORDER BY 1;

-- 2. The guard is off outside a fix-up transaction. Expect false.
SELECT public.membership_side_effects_suppressed() AS suppressed_now;

-- 3. open_signup = exactly {alkalma, maxina}. Expect 2 rows.
SELECT slug FROM public.tenants WHERE open_signup ORDER BY slug;

-- 4. Drift: active legacy memberships of existing users with no user_tenants row. Expect 0.
SELECT count(*) AS drift
  FROM public.memberships m
 WHERE m.status = 'active'
   AND EXISTS (SELECT 1 FROM public.app_users au WHERE au.user_id = m.user_id)
   AND NOT EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.tenant_id = m.tenant_id AND ut.user_id = m.user_id);

-- 4b. Informational: orphaned legacy memberships of deleted accounts (no auth.users row). Expect 12.
SELECT count(*) AS orphaned_legacy_memberships
  FROM public.memberships m
 WHERE m.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = m.user_id)
   AND NOT EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.tenant_id = m.tenant_id AND ut.user_id = m.user_id);

-- 5. Claims without a membership (exafy_admin excluded). Expect 0.
SELECT count(*) AS bad_claims
  FROM auth.users u
 WHERE u.raw_app_meta_data->>'active_tenant_id' IS NOT NULL
   AND NOT coalesce(u.raw_app_meta_data->>'exafy_admin' = 'true', false)
   AND NOT EXISTS (SELECT 1 FROM public.user_tenants ut
                    WHERE ut.user_id = u.id AND ut.tenant_id::text = u.raw_app_meta_data->>'active_tenant_id');

-- 6. Snapshot sizes. Expect drift snapshot 15 (3 with has_app_user), claims snapshot 0.
SELECT (SELECT count(*) FROM legacy_archive.bak_s3_drift_20261010)                     AS drift_snapshot,
       (SELECT count(*) FROM legacy_archive.bak_s3_drift_20261010 WHERE has_app_user)  AS drift_backfilled,
       (SELECT count(*) FROM legacy_archive.bak_s3_claims_20261010)                    AS claims_snapshot;

-- 7. No side effect from the backfill: no user_tenants row B inserted is primary. Expect 0.
SELECT count(*) AS backfilled_primary
  FROM public.user_tenants ut
  JOIN legacy_archive.bak_s3_drift_20261010 b
    ON b.tenant_id = ut.tenant_id AND b.user_id = ut.user_id AND ut.created_at = b.captured_at
 WHERE ut.is_primary;

-- 8. Function privileges. Expect anon = false, public (via a fresh role check) = false,
--    authenticated = true, security definer = true, body references open_signup.
SELECT has_function_privilege('anon', 'public.switch_to_tenant_by_slug(text)', 'execute')          AS anon_exec,
       has_function_privilege('authenticated', 'public.switch_to_tenant_by_slug(text)', 'execute') AS authenticated_exec,
       p.proacl::text                                                                             AS acl,
       p.prosecdef                                                                                AS security_definer,
       pg_get_functiondef(p.oid) LIKE '%open_signup%'                                             AS has_open_signup_check,
       pg_get_functiondef(p.oid) LIKE '%tenant_record.id %'                                       AS still_reads_missing_id
  FROM pg_proc p
 WHERE p.oid = 'public.switch_to_tenant_by_slug(text)'::regprocedure;

-- 9. The snapshot schema is not exposed. Expect false, false.
SELECT has_schema_privilege('anon', 'legacy_archive', 'usage')          AS anon_usage,
       has_schema_privilege('authenticated', 'legacy_archive', 'usage') AS authenticated_usage;
