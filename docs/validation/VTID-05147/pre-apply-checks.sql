-- VTID-05147 (Track S / S-M) — pre-apply checks. READ-ONLY (SELECT only).
-- Run against the production project immediately before RUN-MIGRATION, and
-- the STOP section again immediately AFTER apply (closes the window between
-- this check and the revoke).
--
-- STOP conditions: every query in section 2 must return 0 rows. A row is an
-- exploitation signal: stop, investigate the audit trail (audit_events,
-- Supabase API logs), and correct it with a separate owner-approved
-- service-role data fix. Never fold that into the migration.

-- 1. Baseline counts (Problem 7, 2026-10-13: user_tenants 241 — maxina 237,
--    alkalma 4 — all community except 1 developer (exafy); role_preferences
--    admin 1 / developer 1 (both exafy); user_active_roles 4, all community).
SELECT 'user_tenants' AS t, t.slug, ut.active_role, count(*) AS n
  FROM public.user_tenants ut LEFT JOIN public.tenants t ON t.tenant_id = ut.tenant_id
 GROUP BY 1, 2, 3
UNION ALL
SELECT 'role_preferences', t.slug, rp.role, count(*)
  FROM public.role_preferences rp LEFT JOIN public.tenants t ON t.tenant_id = rp.tenant_id
 GROUP BY 1, 2, 3
UNION ALL
SELECT 'user_active_roles', NULL, uar.active_role, count(*)
  FROM public.user_active_roles uar
 GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

-- 2. STOP conditions (each must return 0 rows).
WITH exafy AS (
  SELECT id FROM auth.users WHERE coalesce(raw_app_meta_data ->> 'exafy_admin', 'false') = 'true'
), permitted AS (
  SELECT user_id, tenant_id, role FROM public.user_permitted_roles
  UNION
  SELECT user_id, tenant_id, role::text FROM public.memberships WHERE status = 'active'
)
-- 2a. user_tenants.active_role above community without a permitted row.
SELECT 'STOP 2a user_tenants.active_role not permitted' AS stop, ut.user_id, ut.tenant_id, ut.active_role AS role
  FROM public.user_tenants ut
 WHERE ut.active_role <> 'community'
   AND ut.user_id NOT IN (SELECT id FROM exafy)
   AND NOT EXISTS (SELECT 1 FROM permitted p
                    WHERE p.user_id = ut.user_id AND p.tenant_id = ut.tenant_id AND p.role = ut.active_role)
UNION ALL
-- 2b. active_tenant_id claim that is not a membership.
SELECT 'STOP 2b active_tenant_id not a membership', u.id, (u.raw_app_meta_data ->> 'active_tenant_id')::uuid, NULL
  FROM auth.users u
 WHERE u.raw_app_meta_data ->> 'active_tenant_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND u.id NOT IN (SELECT id FROM exafy)
   AND NOT EXISTS (SELECT 1 FROM public.user_tenants ut
                    WHERE ut.user_id = u.id AND ut.tenant_id = (u.raw_app_meta_data ->> 'active_tenant_id')::uuid)
UNION ALL
-- 2c. role_preferences role outside the permitted set (community is always permitted).
SELECT 'STOP 2c role_preferences not permitted', rp.user_id, rp.tenant_id, rp.role
  FROM public.role_preferences rp
 WHERE rp.role <> 'community'
   AND rp.user_id NOT IN (SELECT id FROM exafy)
   AND NOT EXISTS (SELECT 1 FROM permitted p
                    WHERE p.user_id = rp.user_id AND p.tenant_id = rp.tenant_id AND p.role = rp.role)
UNION ALL
-- 2d. user_active_roles (global, no tenant column; me_context serves it)
--     outside community and not permitted in any of the user's tenants.
SELECT 'STOP 2d user_active_roles not permitted', uar.user_id, NULL, uar.active_role
  FROM public.user_active_roles uar
 WHERE uar.active_role <> 'community'
   AND uar.user_id NOT IN (SELECT id FROM exafy)
   AND NOT EXISTS (SELECT 1 FROM permitted p WHERE p.user_id = uar.user_id AND p.role = uar.active_role);
