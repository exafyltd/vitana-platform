-- VTID-05467 (role-source-and-bootstrap): read-only checks after the apply (RUN-MIGRATION post-check).
-- SELECT statements only. Nothing in this file writes. Compare the first two counts with live-before.sql.
--
-- Expected after 20261102033000 and 20261102033100: every check reads as stated in its name.

SELECT 'derivation trigger is installed and enabled' AS check_name,
       (SELECT count(*) FROM pg_trigger
         WHERE tgrelid = 'public.user_tenants'::regclass
           AND tgname = 'user_tenants_derive_role_preference'
           AND tgenabled <> 'D') AS n
UNION ALL SELECT 'snapshot user_tenants rows (equal to user_tenants at apply)',
       (SELECT count(*) FROM "legacy_archive".bak_05467_user_tenants)
UNION ALL SELECT 'snapshot role_preferences rows (equal to role_preferences at apply)',
       (SELECT count(*) FROM "legacy_archive".bak_05467_role_preferences)
UNION ALL SELECT 'snapshot user_active_roles rows (equal to user_active_roles at apply)',
       (SELECT count(*) FROM "legacy_archive".bak_05467_user_active_roles)
UNION ALL SELECT 'set_role_preference writes user_tenants (1 = yes)',
       (SELECT CASE WHEN position('UPDATE public.user_tenants' IN pg_get_functiondef(
                 'public.set_role_preference(uuid, text)'::regprocedure)) > 0 THEN 1 ELSE 0 END)
UNION ALL SELECT 'me_set_active_role writes user_tenants (1 = yes)',
       (SELECT CASE WHEN position('UPDATE public.user_tenants' IN pg_get_functiondef(
                 'public.me_set_active_role(text)'::regprocedure)) > 0 THEN 1 ELSE 0 END)
UNION ALL SELECT 'bootstrap_admin_user pins no tenant name (1 = yes)',
       (SELECT CASE WHEN pg_get_functiondef('public.bootstrap_admin_user(uuid, text)'::regprocedure)
                      ~ 'Maxina|Alkalma|Earthlings' THEN 0 ELSE 1 END)
UNION ALL SELECT 'client roles can write user_tenants, role_preferences, user_active_roles, user_permitted_roles (must be 0)',
       (SELECT count(*) FROM (VALUES ('public.user_tenants'), ('public.role_preferences'),
                                     ('public.user_active_roles'), ('public.user_permitted_roles')) AS t(tbl),
                             (VALUES ('anon'), ('authenticated')) AS r(role_name),
                             (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
         WHERE has_table_privilege(r.role_name::name, t.tbl, p.priv))
UNION ALL SELECT 'member rows whose selected role differs from their preference row (compare with live-before)',
       (SELECT count(*) FROM public.user_tenants ut
          JOIN public.role_preferences rp ON rp.user_id = ut.user_id AND rp.tenant_id = ut.tenant_id
         WHERE rp.role IS DISTINCT FROM ut.active_role);
