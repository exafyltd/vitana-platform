-- VTID-05493 rollback for 20261102070300_vtid_05493_mt_tenant_deactivate.sql. Run AFTER rollback-070350.
-- Refuses while archive_tenant(text) still exists. Restores tenants.is_active from bak_vtid_05493_tenant_lifecycle
-- (the state at apply) and drops deactivate_tenant(text). The snapshot table is kept (it is evidence); drop it by hand
-- once the rollback is confirmed: DROP TABLE public.bak_vtid_05493_tenant_lifecycle;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $restore$
BEGIN
  IF to_regprocedure('public.archive_tenant(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-05493 rollback: run rollback-070350-tenant-archive-switch.sql first';
  END IF;
  IF to_regclass('public.bak_vtid_05493_tenant_lifecycle') IS NULL THEN
    RAISE EXCEPTION 'VTID-05493 rollback: snapshot table is missing - restore is_active by hand from live-before.sql';
  END IF;
  UPDATE public.tenants t
     SET is_active = b.is_active
    FROM public.bak_vtid_05493_tenant_lifecycle b
   WHERE b.tenant_id = t.tenant_id AND t.is_active IS DISTINCT FROM b.is_active;
END
$restore$;

DROP FUNCTION IF EXISTS public.deactivate_tenant(text);

COMMIT;
