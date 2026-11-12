-- VTID-05507 rollback of 20261102140100_vtid_05507_mt_resolve_tenant_host.sql.
-- Drops ONLY the two-argument overload resolve_tenant(text, text). The VTID-05151 one-argument resolve_tenant(text), the
-- registry functions and every grant on them are not touched. No data. Roll this back BEFORE rollback-140000.
-- Owner approval required (collaboration section 7d). Safe to re-run.
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP FUNCTION IF EXISTS public.resolve_tenant(text, text);
DO $$
BEGIN
  IF to_regprocedure('public.resolve_tenant(text)') IS NULL THEN
    RAISE EXCEPTION 'VTID-05507 rollback 140100: the one-argument resolve_tenant(text) is missing';
  END IF;
END $$;
COMMIT;
