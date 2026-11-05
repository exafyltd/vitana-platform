-- VTID-05467 (mt-identity-r2 / role-source-and-bootstrap, R2): bootstrap_admin_user keys on the default tenant.
--
-- Last definition: vitana-v1 supabase/migrations/20250915132930_57b924d9-8a27-470e-ad21-6d2ac5be7a37.sql:166-265.
-- It keys on tenant names: 'Maxina' (audit rows at :200, :217, :246, :254) and 'Alkalma' and 'Earthlings' (:236). It writes
-- memberships for those three tenants (:233-240). Its memberships insert also names 'admin'::tenant_role under
-- SET search_path = '' (:170, :234). The public enum does not resolve under an empty search_path, so the previous body
-- cannot run as written. The rollback file restores that body verbatim.
--
-- The new body:
--  * keeps the signature (p_user_id uuid, p_user_email text), the exafy_admin gate, the duplicate-admin refusal and the audit rows;
--  * takes the tenant from tenants.is_default (VTID-05149 M1), never from a name. It reads the key column without naming it
--    (tenant_id or id, whichever the table has), because the repository disagrees on that column name (acceptance.md);
--  * refuses a target that has no app_users row before it writes anything, because user_tenants.user_id references app_users;
--  * grants admin in that tenant through memberships, the grant store that the gate and about 50 policies read today;
--  * writes the canonical user_tenants row in the membership dual-write shape (ON CONFLICT (tenant_id, user_id) DO NOTHING),
--    so the row exists at once and not only at commit. It never sets a selected role: a new row is 'community' and an
--    existing row is left as it is.
--
-- Apply after 20261102033000_vtid_05467_single_role_source.sql, so the derivation trigger covers the canonical row.
-- Apply order and approvals: collaboration.md §7d (one RUN-MIGRATION dispatch per file, after owner approval).
--
-- impact-allow-solo-migration: the function body and the EXECUTE grant on this one function. No table, column or signature
-- changes. No application code calls bootstrap_admin_user (the generated types in vitana-v1 only list it), so the grant
-- change breaks no caller.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.bootstrap_admin_user(p_user_id uuid, p_user_email text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  current_admin_id uuid;
  user_exists boolean;
  v_default_tenant uuid;
  v_is_primary boolean;
BEGIN
  -- Get the current user performing the bootstrap
  current_admin_id := auth.uid();

  -- Validate that the current user is an exafy_admin
  IF NOT COALESCE((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean, false) THEN
    RAISE EXCEPTION 'Only exafy_admin can bootstrap admin users';
  END IF;

  -- The admin tenant is the default tenant. No tenant name is pinned.
  SELECT coalesce(to_jsonb(t) ->> 'tenant_id', to_jsonb(t) ->> 'id')::uuid
    INTO v_default_tenant
    FROM public.tenants t
   WHERE t.is_default
   LIMIT 1;
  IF v_default_tenant IS NULL THEN
    RAISE EXCEPTION 'No default tenant is configured (tenants.is_default)';
  END IF;

  -- Check if target user exists
  SELECT EXISTS(SELECT 1 FROM auth.users WHERE id = p_user_id) INTO user_exists;
  IF NOT user_exists THEN
    RAISE EXCEPTION 'Target user does not exist: %', p_user_email;
  END IF;

  -- Prevent bootstrapping if user is already an admin
  IF COALESCE((
    SELECT (raw_app_meta_data ->> 'exafy_admin')::boolean
    FROM auth.users
    WHERE id = p_user_id
  ), false) THEN
    -- Log attempted duplicate bootstrap
    INSERT INTO public.audit_events (user_id, tenant_id, event_type, event_data)
    VALUES (
      current_admin_id,
      v_default_tenant,
      'admin_bootstrap_duplicate_attempt',
      jsonb_build_object(
        'target_user_id', p_user_id,
        'target_email', p_user_email,
        'timestamp', now(),
        'reason', 'User already has admin privileges'
      )
    );

    RAISE EXCEPTION 'User % is already an admin', p_user_email;
  END IF;

  -- The canonical membership row needs an app_users row (user_tenants.user_id references it).
  IF NOT EXISTS (SELECT 1 FROM public.app_users au WHERE au.user_id = p_user_id) THEN
    RAISE EXCEPTION 'Target user has no app_users row: %', p_user_email;
  END IF;

  -- Log bootstrap attempt before execution
  INSERT INTO public.audit_events (user_id, tenant_id, event_type, event_data)
  VALUES (
    current_admin_id,
    v_default_tenant,
    'admin_bootstrap_attempt',
    jsonb_build_object(
      'target_user_id', p_user_id,
      'target_email', p_user_email,
      'bootstrap_initiated_by', current_admin_id,
      'timestamp', now()
    )
  );

  -- Update user's raw_app_meta_data to make them exafy_admin
  UPDATE auth.users
  SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('exafy_admin', true)
  WHERE id = p_user_id;

  -- Grant admin in the default tenant. memberships is the grant store.
  INSERT INTO public.memberships (user_id, tenant_id, role, status)
  VALUES (p_user_id, v_default_tenant, 'admin'::public.tenant_role, 'active')
  ON CONFLICT (user_id, tenant_id) DO UPDATE SET
    role = EXCLUDED.role,
    status = EXCLUDED.status,
    updated_at = now();

  -- Canonical row, in the dual-write shape. DO NOTHING keeps an existing selected role.
  v_is_primary := NOT EXISTS (
    SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = p_user_id AND ut.is_primary
  );
  INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
  VALUES (v_default_tenant, p_user_id, 'community', v_is_primary)
  ON CONFLICT (tenant_id, user_id) DO NOTHING;

  -- Set the default tenant as the active one
  UPDATE auth.users
  SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) ||
    jsonb_build_object('active_tenant_id', v_default_tenant)
  WHERE id = p_user_id;

  -- Log successful bootstrap completion
  INSERT INTO public.audit_events (user_id, tenant_id, event_type, event_data)
  VALUES (
    current_admin_id,
    v_default_tenant,
    'admin_bootstrap_success',
    jsonb_build_object(
      'target_user_id', p_user_id,
      'target_email', p_user_email,
      'bootstrap_completed_by', current_admin_id,
      'timestamp', now(),
      'tenants_assigned', jsonb_build_array(v_default_tenant)
    )
  );
END;
$function$;

-- Who may execute it. A SECURITY DEFINER function created after VTID-05041 revokes PUBLIC and anon in the same file
-- (services/gateway/test/vtid-05041-definer-lockdown.test.ts). The body already refuses every caller that is not an exafy
-- admin. These grants also keep anon and the signed-in client role away from it. The service role keeps EXECUTE.
REVOKE ALL ON FUNCTION public.bootstrap_admin_user(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_admin_user(uuid, text) TO service_role;

-- Self-check, by effect: the body pins no tenant name and keys on the default tenant, and no client role can execute it.
DO $check$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.bootstrap_admin_user(uuid, text)'::regprocedure;
  IF position('Maxina' IN v_src) > 0 OR position('Alkalma' IN v_src) > 0 OR position('Earthlings' IN v_src) > 0 THEN
    RAISE EXCEPTION 'VTID-05467 self-check: bootstrap_admin_user still pins a tenant name';
  END IF;
  IF position('is_default' IN v_src) = 0 THEN
    RAISE EXCEPTION 'VTID-05467 self-check: bootstrap_admin_user does not key on tenants.is_default';
  END IF;
  IF has_function_privilege('anon', 'public.bootstrap_admin_user(uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.bootstrap_admin_user(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05467 self-check: bootstrap_admin_user is still executable by anon or authenticated';
  END IF;
END
$check$;

COMMIT;
