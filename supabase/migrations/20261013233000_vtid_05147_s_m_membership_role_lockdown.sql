-- VTID-05147 (Track S / S-M): members could escalate their own tenant role
-- and move their own membership.
--
-- Live state 2026-10-13 (read-only):
--  * user_tenants_update_own: FOR UPDATE TO authenticated USING (user_id =
--    auth.uid()), no WITH CHECK, and authenticated held UPDATE. A member could
--    PATCH their own row to active_role='admin' (requireTenantAdmin admits on
--    that column), or to any tenant_id (switch_to_tenant_by_slug then treats
--    them as a member of that tenant), or flip is_primary.
--  * role_preferences rp_upsert_self / rp_update_self / rp_delete_self and
--    user_active_roles user_active_roles_insert / _update checked only
--    auth.uid() = user_id — the role value was free. The gateway reads both
--    as the effective role (ORB developer tools, Command Hub chat gate).
--  * set_role_preference accepted 'community' for any p_tenant_id and was
--    executable by PUBLIC and anon.
--
-- Fix: remove every client write path to the four role/membership tables.
-- The sanctioned writers are SECURITY DEFINER functions that already validate
-- (set_role_preference, me_set_active_role, switch_to_tenant_by_slug,
-- provision_platform_user, handle_new_user); they run as owner, so the
-- revokes below do not affect them. No client writes these tables directly
-- (vitana-v1 switches roles through rpc('set_role_preference'); the gateway
-- writes with the service role).
--
-- Contract-only: nothing is expanded first because no client uses the removed
-- paths. Idempotent (IF EXISTS, repeatable REVOKE/GRANT, CREATE OR REPLACE).
-- Ends with a self-check that RAISEs (and so rolls the whole file back) if the
-- end state is not reached. Rollback: docs/validation/VTID-05147/rollback-s-m.sql
-- (re-opens the hole; emergency only, owner approval).

BEGIN;

-- DROP POLICY / REVOKE take a brief exclusive lock on hot-read tables: never
-- queue behind a long reader. On a timeout the migration fails and is re-run.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. user_tenants: reads stay (user_tenants_select_own, admin_read_all_user_tenants).
DROP POLICY IF EXISTS user_tenants_update_own ON public.user_tenants;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON public.user_tenants FROM anon, authenticated;

-- 2. role_preferences: rp_select_self stays (useRole reads it).
DROP POLICY IF EXISTS rp_upsert_self ON public.role_preferences;
DROP POLICY IF EXISTS rp_update_self ON public.role_preferences;
DROP POLICY IF EXISTS rp_delete_self ON public.role_preferences;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON public.role_preferences FROM anon, authenticated;

-- 3. user_active_roles: user_active_roles_select stays (me_context is definer anyway).
DROP POLICY IF EXISTS user_active_roles_insert ON public.user_active_roles;
DROP POLICY IF EXISTS user_active_roles_update ON public.user_active_roles;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON public.user_active_roles FROM anon, authenticated;

-- 4. Hygiene. user_permitted_roles: no policy allowed these writes, the grants
--    go too. memberships / app_users: write policies untouched (memberships is
--    exafy-gated; app_users_owner_write is a WS1 precondition, out of scope).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON public.user_permitted_roles FROM anon, authenticated;
REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.memberships FROM anon, authenticated;
REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.app_users FROM anon, authenticated;

-- 5. set_role_preference: the live body (pg_get_functiondef 2026-10-13, last
--    defined by VTID-04561 20260925120000) plus two checks — an authenticated
--    caller, and a tenant the caller belongs to (exafy admins excepted).
--    'community' stays always allowed, but only within the caller's own
--    memberships. The non-exafy 'admin' refusal is unchanged.
CREATE OR REPLACE FUNCTION public.set_role_preference(p_tenant_id uuid, p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  is_exafy_admin boolean;
  has_membership_role boolean;
  is_permitted_role boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  is_exafy_admin := COALESCE((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean, false);
  -- VTID-05147: only a tenant the caller is a member of.
  IF NOT is_exafy_admin AND NOT EXISTS (
    SELECT 1 FROM public.user_tenants ut
     WHERE ut.user_id = auth.uid() AND ut.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'Not a member of this tenant' USING ERRCODE = '42501';
  END IF;
  IF NOT is_exafy_admin AND p_role <> 'community' THEN
    is_permitted_role := public.check_role_permitted(auth.uid(), p_tenant_id, p_role);
    IF NOT is_permitted_role THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.memberships m
        WHERE m.user_id = auth.uid()
          AND m.tenant_id = p_tenant_id
          AND m.role::text = p_role
          AND m.status = 'active'
      ) INTO has_membership_role;
      IF NOT has_membership_role THEN
        RAISE EXCEPTION 'Role not granted for this tenant';
      END IF;
    END IF;
  END IF;
  IF p_role = 'admin' AND NOT is_exafy_admin THEN
    RAISE EXCEPTION 'Admin role can only be assigned by super administrators';
  END IF;
  INSERT INTO public.role_preferences (user_id, tenant_id, role)
  VALUES (auth.uid(), p_tenant_id, p_role)
  ON CONFLICT (user_id, tenant_id)
  DO UPDATE SET role = EXCLUDED.role, updated_at = now();
  -- VTID-04561: the Command Hub reads user_active_roles — keep it in step.
  INSERT INTO public.user_active_roles (user_id, active_role, updated_at)
  VALUES (auth.uid(), p_role, now())
  ON CONFLICT (user_id) DO UPDATE SET
    active_role = EXCLUDED.active_role,
    updated_at = now();
  INSERT INTO public.audit_events (user_id, tenant_id, event_type, event_data)
  VALUES (
    auth.uid(),
    p_tenant_id,
    CASE WHEN is_exafy_admin THEN 'admin_role_switch' ELSE 'user_role_switch' END,
    jsonb_build_object(
      'new_role', p_role,
      'timestamp', now(),
      'is_exafy_admin', is_exafy_admin,
      'source', 'set_role_preference',
      'user_agent', current_setting('request.headers', true)::json->>'user-agent'
    )
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.set_role_preference(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_role_preference(uuid, text) TO authenticated, service_role;

-- 6. me_set_active_role, switch_to_tenant_by_slug (incl. its own
--    role_preferences insert, VTID-05043), provision_platform_user and
--    handle_new_user are unchanged: definer functions run as owner.

-- 7. Self-check, by effect.
DO $check$
DECLARE
  t text;
  r text;
  p text;
  bad text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.user_tenants', 'public.role_preferences', 'public.user_active_roles', 'public.user_permitted_roles'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
        IF has_table_privilege(r, t, p) THEN
          RAISE EXCEPTION 'VTID-05147 self-check: % still has % on % (members must not write role/membership tables)', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
    IF NOT has_table_privilege('authenticated', t, 'SELECT') THEN
      RAISE EXCEPTION 'VTID-05147 self-check: authenticated lost SELECT on %', t;
    END IF;
    FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', t, p) THEN
        RAISE EXCEPTION 'VTID-05147 self-check: the gateway (service_role) lost % on %', p, t;
      END IF;
    END LOOP;
  END LOOP;

  SELECT string_agg(tablename || '.' || policyname, ', ') INTO bad
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('user_tenants', 'role_preferences', 'user_active_roles', 'user_permitted_roles')
     AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
     AND roles <> ARRAY['service_role']::name[];
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-05147 self-check: write policies open to clients remain: %', bad;
  END IF;

  IF has_function_privilege('anon', 'public.set_role_preference(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05147 self-check: anon can still execute set_role_preference';
  END IF;
  FOREACH p IN ARRAY ARRAY['public.set_role_preference(uuid, text)', 'public.me_set_active_role(text)', 'public.switch_to_tenant_by_slug(text)'] LOOP
    IF NOT has_function_privilege('authenticated', p, 'EXECUTE') THEN
      RAISE EXCEPTION 'VTID-05147 self-check: members lost EXECUTE on %', p;
    END IF;
  END LOOP;
  IF pg_get_functiondef('public.set_role_preference(uuid, text)'::regprocedure) NOT LIKE '%Not a member of this tenant%' THEN
    RAISE EXCEPTION 'VTID-05147 self-check: set_role_preference has no membership check';
  END IF;
END
$check$;

COMMIT;
