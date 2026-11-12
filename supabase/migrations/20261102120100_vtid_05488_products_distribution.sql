-- VTID-05488 (mt-discover-r2/supplier-relationships-db) D2: products.distribution.
--
-- 'community' (default): offered only to the tenants that have an active supplier_tenant_relationships row.
-- 'network': offered to every tenant. Expand/contract: the column is added with DEFAULT 'community', so every existing
-- row is 'community' and every existing writer (which does not know the column) keeps working; the default STAYS
-- (contract step intentionally not taken, existing writers rely on it). Nothing reads the column until
-- 20261102120300 and then only behind discover_tenant_gate_enabled().
--
-- Adding a column with a constant default does not rewrite the table (PostgreSQL 11+). The CHECK is added NOT VALID and
-- is deliberately NOT validated here: ADD COLUMN holds ACCESS EXCLUSIVE until commit, so a VALIDATE in this transaction
-- would scan products under that lock. It is also redundant: the column is new and every row carries the compliant
-- default 'community', and the constraint is enforced for all new writes even while NOT VALID. Safe to re-run.
-- lock_timeout 3s with up to 5 retries on lock_not_available.
-- Rollback: docs/validation/VTID-05488/rollback-120100-products-distribution.sql
-- Order: docs/multitenancy/MIGRATION-QUEUE.md (row 27).

BEGIN;

DO $mig$
DECLARE
  v_try int := 0;
BEGIN
  IF to_regclass('public.products') IS NULL THEN
    RAISE EXCEPTION 'VTID-05488: public.products is missing; refusing to add products.distribution';
  END IF;

  LOOP
    v_try := v_try + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';

      ALTER TABLE public.products
        ADD COLUMN IF NOT EXISTS distribution text NOT NULL DEFAULT 'community';

      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conname = 'products_distribution_check'
                        AND conrelid = 'public.products'::regclass) THEN
        ALTER TABLE public.products
          ADD CONSTRAINT products_distribution_check
          CHECK (distribution IN ('community', 'network')) NOT VALID;
      END IF;

      COMMENT ON COLUMN public.products.distribution IS
        'VTID-05488: community = only tenants with an active supplier_tenant_relationships row; network = every tenant. Default community.';

      -- Network rows are the minority; a partial index keeps the policy term cheap.
      CREATE INDEX IF NOT EXISTS idx_products_network ON public.products (merchant_id) WHERE distribution = 'network';

      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF v_try >= 5 THEN RAISE; END IF;
      RAISE NOTICE 'VTID-05488 D2: lock timeout, retry % of 5', v_try;
      PERFORM pg_sleep(v_try);
    END;
  END LOOP;
END
$mig$;

COMMIT;
