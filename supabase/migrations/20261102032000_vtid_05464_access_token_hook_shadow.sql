-- VTID-05464 (mt-identity-r2 / access-token-hook-shadow) S1: the tenant-claim
-- custom access-token hook, in SHADOW only.
--
-- What it does (plan mt-identity-r2 "Fix" 3, requirements R3.1-R3.3):
--  * Reads the caller's user_tenants memberships with ONE indexed lookup
--    (idx_user_tenants_user, 20251231000000_vtid_01101_phase_a_bootstrap.sql:103)
--    and picks the tenant the same way resolvePrimaryTenant() does
--    (services/gateway/src/services/tenancy/tenant-context.ts: is_primary desc,
--    created_at, tenant_id), except that app_metadata.active_tenant_id wins when
--    it names a tenant the user IS a member of. The claim is a preference only:
--    a preference for a tenant without a membership is never honoured.
--  * Adds that tenant as the claim `tenant_id_shadow` and nothing else. It never
--    adds, changes or removes a top-level `tenant_id` (or any other claim), so
--    current_tenant_id() (last definition
--    20260218000000_fix_maxina_signup_tenant_association.sql:33, which reads
--    `tenant_id`, `tenant` and app_metadata.active_tenant_id) resolves exactly
--    as before even once the hook is enabled.
--  * Records every disagreement between the preference and the memberships in
--    the tenant_claim_mismatch_log table (migration 20261102032100) for the
--    7-day soak. The write runs in its own exception block: a missing table, a
--    lock wait or any other failure there drops the log row, never the token.
--  * Fails open: any error returns the original event unchanged.
--
-- What it does NOT do: it is not enabled. Pointing Supabase Auth's
-- custom_access_token hook at this function (and emitting a real `tenant_id`)
-- is the separate, owner-applied GO-LIVE lane (D14, requirements R3.4). Until
-- then nothing calls this function.
--
-- Timeouts. Supabase Auth gives a Postgres hook 2 s and runs it in a
-- transaction. The function pins lock_timeout = 100ms: a read of user_tenants
-- only waits behind an ACCESS EXCLUSIVE lock (a migration), and lock_timeout is
-- read when the wait starts, so it bounds that wait inside the call; the
-- 55P03 error it raises is caught and the hook fails open. statement_timeout
-- = 500ms is pinned too, as the plan asks; Postgres arms the statement timer
-- when a top-level statement starts, so inside the call the effective bounds
-- are the lock_timeout above, the single index probe and Auth's own 2 s limit.
--
-- Grants follow Supabase's auth-hook guide: EXECUTE only for
-- supabase_auth_admin (plus USAGE on schema public), revoked from PUBLIC, anon,
-- authenticated and service_role. SECURITY DEFINER (owner: the migration role)
-- with search_path = '' is a deliberate choice over the guide's invoker
-- default: an invoker hook would need SELECT on user_tenants plus a new RLS
-- policy for supabase_auth_admin on user_tenants, and INSERT on the log for
-- supabase_auth_admin, which would widen the VTID-05147 membership lockdown and
-- the service-role-only log. Only supabase_auth_admin can execute it, and every
-- object is schema-qualified.
--
-- Idempotent (CREATE OR REPLACE, repeatable REVOKE/GRANT). Ends with a
-- self-check that RAISEs (and so rolls the whole file back) if the end state is
-- not reached. Rollback:
-- 20261102032000_vtid_05464_access_token_hook_shadow_rollback.sql.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.custom_access_token_hook_shadow(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '100ms'
SET statement_timeout = '500ms'
AS $fn$
DECLARE
  v_claims    jsonb;
  v_user      uuid;
  v_pref      uuid;
  v_tenant    uuid;
  v_primary   boolean;
  v_decision  text;
BEGIN
  v_claims := event -> 'claims';
  IF v_claims IS NULL OR jsonb_typeof(v_claims) <> 'object' THEN
    RAISE EXCEPTION 'VTID-05464: event has no claims object';
  END IF;
  v_user := (event ->> 'user_id')::uuid;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'VTID-05464: event has no user_id';
  END IF;
  v_pref := nullif(v_claims -> 'app_metadata' ->> 'active_tenant_id', '')::uuid;

  -- The single indexed lookup: the preferred membership if it exists, else the
  -- resolvePrimaryTenant() order.
  SELECT ut.tenant_id, ut.is_primary
    INTO v_tenant, v_primary
    FROM public.user_tenants ut
   WHERE ut.user_id = v_user
   ORDER BY (ut.tenant_id = v_pref) IS TRUE DESC, ut.is_primary DESC, ut.created_at, ut.tenant_id
   LIMIT 1;

  v_decision := CASE
    WHEN v_tenant IS NULL THEN 'no_membership'
    WHEN v_pref IS NOT NULL AND v_tenant <> v_pref THEN 'preference_not_member'
    WHEN v_pref IS NULL AND NOT v_primary THEN 'primary_missing'
    ELSE NULL
  END;

  IF v_decision IS NOT NULL THEN
    BEGIN
      INSERT INTO public.tenant_claim_mismatch_log AS l
             (user_id, decision, claimed_tenant_id, shadow_tenant_id, authentication_method)
      VALUES (v_user, v_decision, v_pref, v_tenant, left(event ->> 'authentication_method', 64))
      ON CONFLICT ON CONSTRAINT tenant_claim_mismatch_log_key
      DO UPDATE SET last_seen_at = now(),
                    seen_count = l.seen_count + 1,
                    authentication_method = EXCLUDED.authentication_method;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- the soak log is best effort; the token never depends on it
    END;
  END IF;

  IF v_tenant IS NULL THEN
    RETURN event;
  END IF;
  RETURN jsonb_set(event, '{claims,tenant_id_shadow}', to_jsonb(v_tenant::text), true);
EXCEPTION WHEN OTHERS THEN
  RETURN event; -- fail open: the original claims, untouched
END
$fn$;

COMMENT ON FUNCTION public.custom_access_token_hook_shadow(jsonb) IS
  'VTID-05464: SHADOW custom access-token hook. Adds tenant_id_shadow only (never tenant_id), fails open, logs '
  'preference/membership disagreements to tenant_claim_mismatch_log. Not enabled in Auth; GO-LIVE is owner-applied (D14).';

REVOKE ALL ON FUNCTION public.custom_access_token_hook_shadow(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.custom_access_token_hook_shadow(jsonb) FROM anon, authenticated, service_role;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
    GRANT EXECUTE ON FUNCTION public.custom_access_token_hook_shadow(jsonb) TO supabase_auth_admin;
  ELSE
    RAISE NOTICE 'VTID-05464: role supabase_auth_admin does not exist here; EXECUTE granted to nobody';
  END IF;
END
$grant$;

DO $check$
DECLARE
  r text;
  fn constant regprocedure := 'public.custom_access_token_hook_shadow(jsonb)'::regprocedure;
  cfg text[];
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(r, fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'VTID-05464 self-check: % can execute the hook', r;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin')
     AND NOT has_function_privilege('supabase_auth_admin', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05464 self-check: supabase_auth_admin cannot execute the hook';
  END IF;
  SELECT proconfig INTO cfg FROM pg_proc WHERE oid = fn;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = fn)
     OR NOT ('search_path=""' = ANY (cfg))
     OR NOT ('lock_timeout=100ms' = ANY (cfg))
     OR NOT ('statement_timeout=500ms' = ANY (cfg)) THEN
    RAISE EXCEPTION 'VTID-05464 self-check: hook attributes not as specified (config %)', cfg;
  END IF;
  IF pg_get_functiondef(fn) ~ '\{claims,tenant_id\}' THEN
    RAISE EXCEPTION 'VTID-05464 self-check: the shadow hook writes a top-level tenant_id';
  END IF;
END
$check$;

COMMIT;
