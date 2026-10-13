-- VTID-05149 pre-check, READ-ONLY. Run right before the apply window (M1 → M2 → M3)
-- and continue only if every result matches the expectation in its comment.
-- Evidence baseline: 2026-10-13, project inmkhvwdcuyhnxkgfvsb.

-- 1. Tenants: exactly maxina + alkalma, both open and active, same created_at,
--    and no is_default / is_platform columns yet.
SELECT tenant_id, slug, created_at, is_active, open_signup FROM public.tenants ORDER BY slug;
--    expected: alkalma 73cc592f-… and maxina 2e7528b8-…, created_at 2025-08-30 16:27:07.760873+00, true, true
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name IN ('is_default', 'is_platform');
--    expected: 0 rows

-- 2. The signup trigger functions still match the captured definitions (M2's guard).
SELECT md5(pg_get_functiondef('public.handle_new_user()'::regprocedure))         AS handle_new_user,          -- 9599cfbfa7d9f8532ea1564df99e430f
       md5(pg_get_functiondef('public.provision_platform_user()'::regprocedure)) AS provision_platform_user;  -- 6254e35b2765d8edd5976ec5b9eec4f3
--    If either differs: STOP. Follow the drift runbook in the M2 header (rebuild, re-run the harness, follow-up PR).

-- 3. Triggers: 7 AFTER INSERT on auth.users (+ the BEFORE DELETE cleanup), 4 AFTER INSERT on user_tenants.
SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid)
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE NOT t.tgisinternal
   AND ((n.nspname = 'auth' AND c.relname = 'users') OR (n.nspname = 'public' AND c.relname IN ('user_tenants', 'tenants')))
 ORDER BY 1, 2;
--    expected auth.users AFTER INSERT: on_auth_user_created, on_auth_user_created_generate_discount,
--      on_auth_user_created_preferences, on_auth_user_created_wallet, on_auth_user_phone_verification
--      (INSERT OR UPDATE), on_auth_user_platform_provision, on_user_journey_created;
--      BEFORE DELETE before_auth_user_delete_cleanup_contacts.
--    expected user_tenants: founding_seat_on_primary_membership, seed_onboarding_autopilot_on_primary_membership,
--      trg_create_user_live_room, welcome_chat_on_primary_membership (each WHEN is_primary AND NOT suppressed).
--    expected tenants: none.

-- 4. Primary memberships: no user with 0 or 2+ primaries.
SELECT count(*) FILTER (WHERE primaries = 0) AS users_zero_primary,   -- 0
       count(*) FILTER (WHERE primaries > 1) AS users_multi_primary   -- 0
  FROM (SELECT user_id, count(*) FILTER (WHERE is_primary) AS primaries FROM public.user_tenants GROUP BY user_id) s;

-- 5. Today's oldest-tenant answer (what M2 replaces).
SELECT slug FROM public.tenants ORDER BY created_at LIMIT 1;  -- maxina
