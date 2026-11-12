-- VTID-05488 rollback of 20261102120200_vtid_05488_partner_tenant_backfill.sql.
-- Drops partner_tenant.tenant_uuid (the only change to partner_tenant; the free-text tenant_id was never modified).
-- The snapshot public.bak_vtid_05488_partner_tenant is KEPT as the record of what the table looked like before; drop it
-- by hand only after the owner no longer needs it (the commented statement below).
-- Owner approval required (collaboration section 7d). Safe to re-run; a no-op when partner_tenant does not exist.
BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF to_regclass('public.partner_tenant') IS NOT NULL THEN
    DROP INDEX IF EXISTS public.idx_partner_tenant_tenant_uuid;
    ALTER TABLE public.partner_tenant DROP COLUMN IF EXISTS tenant_uuid;
  END IF;
END
$$;

-- DROP TABLE IF EXISTS public.bak_vtid_05488_partner_tenant;   -- only on the owner's say-so
COMMIT;
