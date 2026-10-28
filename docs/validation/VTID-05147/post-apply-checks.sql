-- VTID-05147 (Track S / S-M) — post-apply checks. READ-ONLY (SELECT only).
-- Run against the production project right after RUN-MIGRATION applied
-- 20261013233000_vtid_05147_s_m_membership_role_lockdown.sql. Then re-run
-- section 2 of pre-apply-checks.sql (STOP conditions, must be 0 rows).

-- 1. Privilege matrix. Expected: anon/authenticated INSERT/UPDATE/DELETE/TRUNCATE
--    all false; authenticated SELECT true; service_role INSERT/UPDATE/DELETE true.
SELECT t AS table_name, r AS grantee,
       has_table_privilege(r, t, 'SELECT')   AS sel,
       has_table_privilege(r, t, 'INSERT')   AS ins,
       has_table_privilege(r, t, 'UPDATE')   AS upd,
       has_table_privilege(r, t, 'DELETE')   AS del,
       has_table_privilege(r, t, 'TRUNCATE') AS trunc
  FROM unnest(ARRAY['public.user_tenants', 'public.role_preferences', 'public.user_active_roles',
                    'public.user_permitted_roles', 'public.memberships', 'public.app_users']) AS t,
       unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r
 ORDER BY 1, 2;

-- 2. Policies left on the four tables. Expected: SELECT policies, plus ALL
--    policies TO service_role only; none of user_tenants_update_own,
--    rp_upsert_self, rp_update_self, rp_delete_self, user_active_roles_insert,
--    user_active_roles_update.
SELECT tablename, policyname, cmd, roles
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('user_tenants', 'role_preferences', 'user_active_roles', 'user_permitted_roles')
 ORDER BY 1, 2;

-- 3. set_role_preference: anon false, authenticated true, membership check present.
SELECT has_function_privilege('anon', 'public.set_role_preference(uuid, text)', 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', 'public.set_role_preference(uuid, text)', 'EXECUTE') AS auth_exec,
       has_function_privilege('authenticated', 'public.me_set_active_role(text)', 'EXECUTE') AS me_set_exec,
       has_function_privilege('authenticated', 'public.switch_to_tenant_by_slug(text)', 'EXECUTE') AS switch_exec,
       position('Not a member of this tenant' IN pg_get_functiondef('public.set_role_preference(uuid, text)'::regprocedure)) > 0
         AS membership_check;

-- 4. Data unchanged (compare with pre-apply section 1).
SELECT 'user_tenants' AS t, count(*) FROM public.user_tenants
UNION ALL SELECT 'role_preferences', count(*) FROM public.role_preferences
UNION ALL SELECT 'user_active_roles', count(*) FROM public.user_active_roles
UNION ALL SELECT 'user_permitted_roles', count(*) FROM public.user_permitted_roles;
