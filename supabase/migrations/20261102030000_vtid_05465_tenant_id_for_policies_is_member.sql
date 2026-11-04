-- =============================================================================
-- VTID-05465 (mt-identity-r2 / helpers-and-policy-rewrite) — H1: policy helpers
-- -----------------------------------------------------------------------------
-- Adds two STABLE SECURITY DEFINER helpers for RLS policies, both over the
-- unique (tenant_id, user_id) index of public.user_tenants
-- (20251231000000_vtid_01101_phase_a_bootstrap.sql:90-98):
--
--   public.is_member(p_tenant_id uuid) -> boolean
--     true when auth.uid() has a user_tenants row for p_tenant_id. One probe of
--     the unique index. For later lanes: no policy in this lane calls it (plan
--     amendment 1). A policy would call it as (select public.is_member(tenant_id)).
--
--   public.tenant_id_for_policies() -> uuid
--     The one resolved tenant the rewritten policies filter on. N2 degraded path:
--       coalesce(<top-level JWT tenant_id claim, only if auth.uid() is a member
--                 of it>,
--                <auth.uid()'s primary user_tenants row>)
--     The primary row uses the ordering of resolvePrimaryTenant()
--     (services/gateway/src/services/tenancy/tenant-context.ts: is_primary desc,
--     created_at, tenant_id, limit 1). NULL when there is no auth.uid().
--     Policies call it as (select public.tenant_id_for_policies()), so Postgres
--     evaluates it once per statement (initPlan).
--
-- This is a NEW name. current_tenant_id() is NOT redefined here (N3 ordering
-- gate: the bare-policy lint must read 0 first; redefining it is a later lane).
-- Nothing calls the helpers until 20261102030100_vtid_05465_bare_policy_rewrite.sql,
-- which uses tenant_id_for_policies() only.
--
-- Additive only (expand). Applying it needs the owner's approval of this file
-- and the target database (collaboration.md §7d). Rollback: the last section of
-- 20261102030100_vtid_05465_bare_policy_rewrite_rollback.sql drops both helpers
-- once no policy references them.
-- =============================================================================
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Precondition: user_tenants with a unique index on exactly (tenant_id, user_id).
DO $pre$
BEGIN
  IF to_regclass('public.user_tenants') IS NULL THEN
    RAISE EXCEPTION 'VTID-05465: public.user_tenants is missing; refusing to create the policy helpers';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid = 'public.user_tenants'::regclass
      AND i.indisunique
      AND i.indnkeyatts = 2
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
           FROM pg_attribute a
           WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey::int2[]))
          = ARRAY['tenant_id', 'user_id']
  ) THEN
    RAISE EXCEPTION 'VTID-05465: no unique (tenant_id, user_id) index on public.user_tenants; refusing';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.is_member(p_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_tenant_id IS NOT NULL
     AND auth.uid() IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.user_tenants ut
       WHERE ut.tenant_id = p_tenant_id
         AND ut.user_id = auth.uid()
     );
$$;

CREATE OR REPLACE FUNCTION public.tenant_id_for_policies()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_claim uuid;
  v_tenant uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  -- The top-level tenant_id claim (emitted later by the access-token hook),
  -- accepted only when the caller is a member of that tenant.
  BEGIN
    v_claim := (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'tenant_id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_claim := NULL;
  END;
  IF v_claim IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.user_tenants ut WHERE ut.tenant_id = v_claim AND ut.user_id = v_uid
  ) THEN
    RETURN v_claim;
  END IF;

  -- Degraded path (N2): the caller's primary membership.
  SELECT ut.tenant_id INTO v_tenant
  FROM public.user_tenants ut
  WHERE ut.user_id = v_uid
  ORDER BY ut.is_primary DESC, ut.created_at, ut.tenant_id
  LIMIT 1;
  RETURN v_tenant;
END;
$$;

COMMENT ON FUNCTION public.is_member(uuid) IS
  'VTID-05465: true when auth.uid() is a member (user_tenants row) of the tenant. RLS helper; call as (select public.is_member(tenant_id)).';
COMMENT ON FUNCTION public.tenant_id_for_policies() IS
  'VTID-05465: the resolved tenant for RLS policies: the JWT tenant_id claim if auth.uid() is a member of it, else the primary user_tenants row (N2). Not current_tenant_id().';

-- Policies run with the caller's privileges, so authenticated needs EXECUTE.
-- Both helpers only answer for the caller's own memberships.
REVOKE ALL ON FUNCTION public.is_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tenant_id_for_policies() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_member(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tenant_id_for_policies() TO authenticated, service_role;

COMMIT;
