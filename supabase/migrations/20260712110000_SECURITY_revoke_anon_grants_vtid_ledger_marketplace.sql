-- SECURITY FIX: defense-in-depth grant cleanup for vtid_ledger and the
-- marketplace catalog (merchants/products).
--
-- 1. vtid_ledger (VTID-0542, 20251217000000_vtid_ledger_and_allocator.sql)
-- ---------------------------------------------------------------------
-- The original migration ran `GRANT ALL ON vtid_ledger TO anon` and
-- `TO authenticated` alongside the service_role grant, then enabled RLS with
-- only a service_role policy. Today that RLS policy blocks anon/authenticated
-- from actually using the grant — but the grant itself is a defense-in-depth
-- failure: vtid_ledger is the central OASIS governance/task ledger
-- (CLAUDE.md: "Always treat OASIS as the single source of truth for task
-- state, lifecycle, and governance"), not a table any community/anon caller
-- has a legitimate reason to touch. The moment RLS is ever toggled off or a
-- permissive policy is added by mistake, this raw GRANT ALL would hand
-- anon/authenticated full read/write control of the governance ledger.
-- Neither regular app users nor anonymous callers read or write vtid_ledger
-- through PostgREST — all access is via the gateway's service-role client —
-- so these grants serve no purpose and are pure liability.
REVOKE ALL ON vtid_ledger FROM anon;
REVOKE ALL ON vtid_ledger FROM authenticated;
REVOKE USAGE, SELECT ON SEQUENCE global_vtid_seq FROM anon;
REVOKE USAGE, SELECT ON SEQUENCE global_vtid_seq FROM authenticated;

-- 2. merchants / products (VTID-02000, 20260416150000_vtid_02000_debug_products.sql)
-- ---------------------------------------------------------------------
-- The marketplace foundation migration (20260416120000) deliberately scoped
-- catalog visibility to logged-in users:
--   CREATE POLICY merchants_select ON public.merchants FOR SELECT
--     TO authenticated USING (is_active = TRUE);
--   CREATE POLICY products_select ON public.products FOR SELECT
--     TO authenticated USING (is_active = TRUE);
-- A later ad-hoc "Debug migration" (20260416150000) re-granted anon SELECT
-- on both tables while troubleshooting a PostgREST visibility issue
-- ("maybe PostgREST requires this to see table") and never reverted it.
-- That grant bypasses the authenticated-only design and exposes the full
-- merchant/product catalog — including any non-`is_active` rows, since a
-- raw GRANT is not filtered by the RLS policy's `is_active = TRUE` clause
-- the way the intended authenticated policy is — to anyone with just the
-- public anon key. Revoking restores the originally-designed access model;
-- logged-in catalog browsing is unaffected.
REVOKE SELECT ON public.merchants FROM anon;
REVOKE SELECT ON public.products FROM anon;
