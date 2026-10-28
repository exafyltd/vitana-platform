-- VTID-05149 post-checks, READ-ONLY. Run after each migration of the apply window
-- (the section for that migration) and record the results in acceptance.md.

-- After M1: maxina is the only default, no platform tenant, the invariant machinery exists.
SELECT slug, is_default, is_platform FROM public.tenants ORDER BY slug;
--   expected: alkalma f f / maxina t f
SELECT conname FROM pg_constraint WHERE conrelid = 'public.tenants'::regclass AND conname = 'tenants_default_not_platform';
SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'tenants_one_default';
SELECT tgname, tgdeferrable, tginitdeferred FROM pg_trigger WHERE tgname = 'tenants_exactly_one_default';  -- t t
SELECT has_function_privilege('authenticated', 'public.tenants_assert_one_default()', 'EXECUTE') AS authenticated_exec;  -- f

-- After M2: record the new md5s. Expected (computed by the harness on postgres:16;
-- verify that live, PG 17, reports the same):
--   handle_new_user         eb88ecd1e6bff6baba33f1b069361052
--   provision_platform_user 3fbcafeb65604e1a06fb7c66bbbac24d
SELECT md5(pg_get_functiondef('public.handle_new_user()'::regprocedure))         AS handle_new_user,
       md5(pg_get_functiondef('public.provision_platform_user()'::regprocedure)) AS provision_platform_user;
SELECT p.proname,
       position('is_default' IN pg_get_functiondef(p.oid)) > 0       AS uses_default,      -- t
       position('open_signup' IN pg_get_functiondef(p.oid)) > 0      AS uses_open_signup,  -- t
       position('created_at ASC' IN pg_get_functiondef(p.oid)) > 0   AS oldest_fallback    -- f
  FROM pg_proc p WHERE p.oid IN ('public.handle_new_user()'::regprocedure, 'public.provision_platform_user()'::regprocedure);

-- After M3: members cannot call it, service_role can, and it answers with every key.
SELECT has_function_privilege('anon', 'public.ci_tenant_isolation_health()', 'EXECUTE')          AS anon,           -- f
       has_function_privilege('authenticated', 'public.ci_tenant_isolation_health()', 'EXECUTE') AS authenticated,  -- f
       has_function_privilege('service_role', 'public.ci_tenant_isolation_health()', 'EXECUTE')  AS service_role;   -- t
SELECT public.ci_tenant_isolation_health();
--   expected: every key present; foreign_tenant_rows ≈ 3,628; null_tenant_rows ≈ 2,158;
--   users_zero_primary 0; users_multi_primary 0; default_tenant_count 1; platform_tenant_count 0; scan_errors [].

-- 24 h after M2: every auth.users row created since the apply has exactly one primary
-- user_tenants row (maxina, or its open slug's tenant) and a memberships row in the same tenant.
-- Replace :applied_at with the M2 apply timestamp.
SELECT u.id,
       u.raw_user_meta_data ->> 'tenant_slug'                                              AS slug,
       (SELECT count(*) FROM public.user_tenants ut WHERE ut.user_id = u.id AND ut.is_primary) AS primaries,  -- 1
       (SELECT t.slug FROM public.user_tenants ut JOIN public.tenants t USING (tenant_id)
         WHERE ut.user_id = u.id AND ut.is_primary LIMIT 1)                                AS primary_tenant,
       EXISTS (SELECT 1 FROM public.memberships m JOIN public.user_tenants ut
                 ON ut.user_id = m.user_id AND ut.tenant_id = m.tenant_id AND ut.is_primary
                WHERE m.user_id = u.id)                                                    AS memberships_same_tenant  -- t
  FROM auth.users u
 WHERE u.created_at >= :'applied_at'::timestamptz
 ORDER BY u.created_at;
