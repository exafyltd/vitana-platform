-- VTID-05151 rollback, migration 20261014000700_vtid_05151_seed_legacy_tenant_landing.sql.
-- Restores branding and profile of the maxina and alkalma tenant_settings rows from the
-- pre-seed snapshot legacy_archive.bak_vtid_05151_tenant_settings. Other rows are untouched.
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $$
DECLARE
  n int;
BEGIN
  UPDATE public.tenant_settings s
     SET branding = b.branding,
         profile  = b.profile
    FROM legacy_archive.bak_vtid_05151_tenant_settings b
   WHERE b.tenant_id = s.tenant_id
     AND s.tenant_id IN (SELECT t.tenant_id FROM public.tenants t WHERE t.slug IN ('maxina', 'alkalma'));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 2 THEN
    RAISE EXCEPTION 'VTID-05151 rollback: expected to restore 2 rows, restored %', n;
  END IF;
END $$;
COMMIT;
