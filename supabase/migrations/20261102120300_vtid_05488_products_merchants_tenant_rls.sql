-- VTID-05488 (mt-discover-r2/supplier-relationships-db) D4: tenant-scoped products_select / merchants_select.
--
-- Today (20260416120000_vtid_02000_marketplace_foundation.sql:729/:735, redefined by 20260416170000/180000) both
-- policies are `is_active = TRUE` only: every authenticated user reads the whole catalogue. This migration replaces them
-- with a policy that is INERT while the tenant gate is off and tenant-scoped once a tenant turns it on:
--
--   is_active AND ( NOT discover_tenant_gate_enabled()
--                   OR <network term>
--                   OR EXISTS (active supplier_tenant_relationships for the merchant AND tenant_id = current_tenant_id()) )
--
--   products  network term: distribution = 'network'
--   merchants network term: the merchant has at least one active 'network' product
--
-- discover_tenant_gate_enabled() (new, STABLE SECURITY DEFINER, search_path = public, pg_catalog):
--   * current_tenant_id() IS NOT NULL -> that tenant's tenant_settings.feature_flags->'mt'->>'discover_tenant_gate' is
--     true; false when the tenant has no tenant_settings row or the flag is absent / not exactly true;
--   * current_tenant_id() IS NULL     -> true iff ANY tenant_settings row has the gate on, so a session with no tenant
--     sees only network rows instead of falling back to the unscoped read once any tenant enables the gate; false when
--     every gate is off (then the result is today's is_active-only read). Never raises.
-- Performance: the policies wrap both helper calls as (SELECT ...) so the planner evaluates them once per statement
-- (InitPlan), and the helper resolves current_tenant_id() once. NULL-tenant coupling is global by design: a tenant-less
-- authenticated session switches to network-only as soon as ANY tenant enables the gate (fail closed; owner to confirm).
-- Rollout: merchants created after the 120000 seed need an active supplier_tenant_relationships row before a tenant
-- turns the gate on, otherwise they are hidden from that tenant.
-- Only existing helpers are used: public.current_tenant_id() (20260218000000_fix_maxina_signup_tenant_association.sql:33).
-- No dependency on mt-identity-r2. This backstops authenticated (user-JWT) reads only; service_role bypasses RLS and
-- is covered by the gateway's shared Discover predicate. anon has no SELECT policy on these tables and gets none.
--
-- Safe to re-run. lock_timeout 3s with up to 5 retries on lock_not_available.
-- Depends on 20261102120000 (supplier_tenant_relationships) and 20261102120100 (products.distribution); refuses without.
-- Rollback: docs/validation/VTID-05488/rollback-120300-products-merchants-tenant-rls.sql
-- Order: docs/multitenancy/MIGRATION-QUEUE.md (row 29).

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.supplier_tenant_relationships') IS NULL THEN
    RAISE EXCEPTION 'VTID-05488 D4: public.supplier_tenant_relationships is missing (apply 20261102120000 first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'distribution') THEN
    RAISE EXCEPTION 'VTID-05488 D4: public.products.distribution is missing (apply 20261102120100 first)';
  END IF;
  IF to_regclass('public.tenant_settings') IS NULL THEN
    RAISE EXCEPTION 'VTID-05488 D4: public.tenant_settings is missing';
  END IF;
  IF to_regprocedure('public.current_tenant_id()') IS NULL THEN
    RAISE EXCEPTION 'VTID-05488 D4: public.current_tenant_id() is missing';
  END IF;
END
$guard$;

DO $mig$
DECLARE
  v_try int := 0;
BEGIN
  LOOP
    v_try := v_try + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';

      CREATE OR REPLACE FUNCTION public.discover_tenant_gate_enabled()
      RETURNS boolean
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = public, pg_catalog
      AS $fn$
      DECLARE
        v_tenant uuid := public.current_tenant_id();
        v_on boolean;
      BEGIN
        IF v_tenant IS NULL THEN
          RETURN EXISTS (SELECT 1 FROM public.tenant_settings ts
                          WHERE ts.feature_flags -> 'mt' ->> 'discover_tenant_gate' = 'true');
        END IF;
        SELECT ts.feature_flags -> 'mt' ->> 'discover_tenant_gate' = 'true' INTO v_on
          FROM public.tenant_settings ts
         WHERE ts.tenant_id = v_tenant;
        RETURN coalesce(v_on, false);
      END
      $fn$;

      REVOKE ALL ON FUNCTION public.discover_tenant_gate_enabled() FROM PUBLIC, anon;
      GRANT EXECUTE ON FUNCTION public.discover_tenant_gate_enabled() TO authenticated, service_role;

      COMMENT ON FUNCTION public.discover_tenant_gate_enabled() IS
        'VTID-05488: per-tenant mt.discover_tenant_gate flag for current_tenant_id(); for a NULL tenant true iff any tenant has it on. false when off / no row.';

      DROP POLICY IF EXISTS products_select ON public.products;
      CREATE POLICY products_select ON public.products
        FOR SELECT TO authenticated
        USING (
          is_active = TRUE
          AND (
            NOT (SELECT public.discover_tenant_gate_enabled())
            OR distribution = 'network'
            OR EXISTS (SELECT 1 FROM public.supplier_tenant_relationships r
                        WHERE r.merchant_id = products.merchant_id
                          AND r.status = 'active'
                          AND r.tenant_id = (SELECT public.current_tenant_id())
                          AND EXISTS (SELECT 1 FROM public.user_tenants ut
                                       WHERE ut.tenant_id = r.tenant_id
                                         AND ut.user_id = (SELECT auth.uid())))
          )
        );

      DROP POLICY IF EXISTS merchants_select ON public.merchants;
      CREATE POLICY merchants_select ON public.merchants
        FOR SELECT TO authenticated
        USING (
          is_active = TRUE
          AND (
            NOT (SELECT public.discover_tenant_gate_enabled())
            OR EXISTS (SELECT 1 FROM public.products p
                        WHERE p.merchant_id = merchants.id
                          AND p.is_active = TRUE
                          AND p.distribution = 'network')
            OR EXISTS (SELECT 1 FROM public.supplier_tenant_relationships r
                        WHERE r.merchant_id = merchants.id
                          AND r.status = 'active'
                          AND r.tenant_id = (SELECT public.current_tenant_id())
                          AND EXISTS (SELECT 1 FROM public.user_tenants ut
                                       WHERE ut.tenant_id = r.tenant_id
                                         AND ut.user_id = (SELECT auth.uid())))
          )
        );

      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF v_try >= 5 THEN RAISE; END IF;
      RAISE NOTICE 'VTID-05488 D4: lock timeout, retry % of 5', v_try;
      PERFORM pg_sleep(v_try);
    END;
  END LOOP;
END
$mig$;

COMMIT;
