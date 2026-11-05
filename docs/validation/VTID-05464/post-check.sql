-- VTID-05464 read-only checks. pre: before the apply; post: after both forward
-- files. Read-only: catalog reads only, no DML, no DDL. Run in the owner-approved
-- RUN-MIGRATION.yml window (collaboration.md §7d), never from the PR.

-- pre (expect: both NULL — nothing to clobber; the version range is free)
SELECT to_regprocedure('public.custom_access_token_hook_shadow(jsonb)') AS hook,
       to_regclass('public.tenant_claim_mismatch_log')                  AS log;

-- pre (expect: user_tenants still has idx_user_tenants_user, the hook's lookup index)
SELECT indexname, indexdef FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'user_tenants' ORDER BY indexname;

-- post: hook attributes and grants
SELECT p.prosecdef, p.provolatile, p.proconfig,
       has_function_privilege('supabase_auth_admin', p.oid, 'EXECUTE') AS auth_admin_exec,  -- expect true
       has_function_privilege('authenticated',       p.oid, 'EXECUTE') AS authenticated_exec, -- expect false
       has_function_privilege('anon',                p.oid, 'EXECUTE') AS anon_exec,           -- expect false
       has_function_privilege('service_role',        p.oid, 'EXECUTE') AS service_role_exec    -- expect false
  FROM pg_proc p WHERE p.oid = 'public.custom_access_token_hook_shadow(jsonb)'::regprocedure;

-- post: log is service-role-only, RLS on, no policy, empty (nothing calls the hook)
SELECT c.relrowsecurity,
       has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_select,  -- expect false
       has_table_privilege('anon',          c.oid, 'SELECT') AS anon_select,           -- expect false
       has_table_privilege('service_role',  c.oid, 'SELECT') AS service_role_select,   -- expect true
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tenant_claim_mismatch_log') AS policies, -- expect 0
       (SELECT count(*) FROM public.tenant_claim_mismatch_log) AS rows                 -- expect 0
  FROM pg_class c WHERE c.oid = 'public.tenant_claim_mismatch_log'::regclass;

-- post: the hook is NOT enabled in Auth. Confirm in the Supabase dashboard
-- (Authentication > Hooks: no custom access token hook pointing at
-- custom_access_token_hook_shadow). This lane changes no Auth config.
