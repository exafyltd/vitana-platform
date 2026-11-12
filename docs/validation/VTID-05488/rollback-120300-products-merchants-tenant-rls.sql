-- VTID-05488 rollback of 20261102120300_vtid_05488_products_merchants_tenant_rls.sql.
-- Restores the pre-lane policies (20260416120000_vtid_02000_marketplace_foundation.sql:729/:735, is_active = TRUE only)
-- and drops discover_tenant_gate_enabled(). Owner approval required (collaboration section 7d); Kiro runs it through
-- RUN-MIGRATION, never from a PR. Roll back in reverse order: 120300 first, then 120200, 120100, 120000.
-- No data is touched. Safe to re-run.
BEGIN;
SET LOCAL lock_timeout = '3s';

DROP POLICY IF EXISTS products_select ON public.products;
CREATE POLICY products_select ON public.products FOR SELECT TO authenticated USING (is_active = TRUE);

DROP POLICY IF EXISTS merchants_select ON public.merchants;
CREATE POLICY merchants_select ON public.merchants FOR SELECT TO authenticated USING (is_active = TRUE);

DROP FUNCTION IF EXISTS public.discover_tenant_gate_enabled();
COMMIT;
