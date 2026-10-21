-- VTID-05151 rollback, migration 20261014000600_vtid_05151_public_tenant_registry.sql.
-- Drops the three registry functions. No table, column, policy or row is touched.
-- Apply the seed rollback (rollback-seed.sql) independently if wanted; the seed does not
-- depend on these functions once applied.
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP FUNCTION IF EXISTS public.resolve_tenant(text), public.list_public_tenants(), public._tenant_public_registry();
DO $$
BEGIN
  IF to_regprocedure('public.resolve_tenant(text)') IS NOT NULL
     OR to_regprocedure('public.list_public_tenants()') IS NOT NULL
     OR to_regprocedure('public._tenant_public_registry()') IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-05151 rollback: a registry function still exists';
  END IF;
END $$;
COMMIT;
