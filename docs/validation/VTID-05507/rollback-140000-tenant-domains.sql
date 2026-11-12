-- VTID-05507 rollback of 20261102140000_vtid_05507_mt_tenant_domains.sql.
-- Drops the reserved-slug trigger, its function and public.tenant_domains (indexes and constraints go with the table).
-- DATA LOSS WARNING: every host row written after the apply is lost. Roll back 20261102140100 first (its function reads
-- this table): this file refuses while the two-argument resolve_tenant still exists. Owner approval required
-- (collaboration section 7d). Safe to re-run.
BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF to_regprocedure('public.resolve_tenant(text, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-05507 rollback 140000: resolve_tenant(text, text) still exists; run rollback-140100 first';
  END IF;
END $$;

DROP TRIGGER IF EXISTS tenant_domains_reject_reserved ON public.tenant_domains;
DROP FUNCTION IF EXISTS public.tenant_domains_reject_reserved();
DROP TABLE IF EXISTS public.tenant_domains;
COMMIT;
