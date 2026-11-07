-- VTID-05488 rollback of 20261102120100_vtid_05488_products_distribution.sql.
-- Drops products.distribution. DATA LOSS WARNING: any product set to 'network' after the migration loses that flag.
-- Roll back 20261102120300 first (its policy reads the column). Owner approval required (collaboration section 7d).
-- Safe to re-run.
BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('products', 'merchants')
                AND qual ~ 'distribution') THEN
    RAISE EXCEPTION 'VTID-05488 rollback 120100: a products/merchants policy still reads distribution; run rollback-120300 first';
  END IF;
END
$$;

DROP INDEX IF EXISTS public.idx_products_network;
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_distribution_check;
ALTER TABLE public.products DROP COLUMN IF EXISTS distribution;
COMMIT;
