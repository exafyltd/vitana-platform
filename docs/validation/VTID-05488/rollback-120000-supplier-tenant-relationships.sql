-- VTID-05488 rollback of 20261102120000_vtid_05488_supplier_tenant_relationships.sql.
-- Drops public.supplier_tenant_relationships (its policies and indexes go with it). DATA LOSS WARNING: relationships
-- written after the seed (proposed / accepted / declined / suspended) are lost; the seed itself is reproducible.
-- Roll back 20261102120300 first (its policies read this table). Owner approval required (collaboration section 7d).
-- Safe to re-run.
BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('products', 'merchants')
                AND qual ~ 'supplier_tenant_relationships') THEN
    RAISE EXCEPTION 'VTID-05488 rollback 120000: a products/merchants policy still reads supplier_tenant_relationships; run rollback-120300 first';
  END IF;
END
$$;

DROP TABLE IF EXISTS public.supplier_tenant_relationships;
COMMIT;
