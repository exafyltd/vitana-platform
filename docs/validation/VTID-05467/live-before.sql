-- VTID-05467 (role-source-and-bootstrap): read-only counts for the RUN-MIGRATION pre-check.
-- Run only after the owner approves the migration files and the target database (collaboration.md §7d).
-- SELECT statements only. Nothing in this file writes.
--
-- The counts are the owner's input for the two open decisions in acceptance.md: the direction of any backfill of
-- user_tenants.active_role, and the gate effect of a granted admin who selects admin.

SELECT 'user_tenants rows' AS check_name, count(*) AS n FROM public.user_tenants
UNION ALL SELECT 'role_preferences rows', count(*) FROM public.role_preferences
UNION ALL SELECT 'user_active_roles rows', count(*) FROM public.user_active_roles
UNION ALL SELECT 'user_permitted_roles rows', count(*) FROM public.user_permitted_roles
UNION ALL SELECT 'memberships rows with role admin and status active', count(*)
  FROM public.memberships WHERE role = 'admin' AND status = 'active'
UNION ALL SELECT 'user_tenants rows whose active_role differs from their preference row', count(*)
  FROM public.user_tenants ut
  JOIN public.role_preferences rp ON rp.user_id = ut.user_id AND rp.tenant_id = ut.tenant_id
 WHERE rp.role IS DISTINCT FROM ut.active_role
UNION ALL SELECT 'user_tenants rows with no preference row', count(*)
  FROM public.user_tenants ut
 WHERE NOT EXISTS (SELECT 1 FROM public.role_preferences rp
                    WHERE rp.user_id = ut.user_id AND rp.tenant_id = ut.tenant_id)
UNION ALL SELECT 'preference rows with no membership (left as they are)', count(*)
  FROM public.role_preferences rp
 WHERE NOT EXISTS (SELECT 1 FROM public.user_tenants ut
                    WHERE ut.user_id = rp.user_id AND ut.tenant_id = rp.tenant_id)
UNION ALL SELECT 'user_tenants rows with active_role admin (the gate reads this column)', count(*)
  FROM public.user_tenants WHERE active_role = 'admin'
UNION ALL SELECT 'tenants with is_default (must be 1)', count(*)
  FROM public.tenants WHERE is_default;
