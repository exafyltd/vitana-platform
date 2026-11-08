-- VTID-05595 rollback of 20261102130000 (apply AFTER rollback-130100). Refuses while the resolver still reads the column.
-- Drops the index, the FK and the column. The frozen values are kept in legacy_archive.bak_05595_health_home_tenant
-- (30-day retention; that table is dropped by a follow-up migration PR, not here). Owner approval required
-- (collaboration.md section 7d); not run by the PR.
BEGIN;
DO $rb$
BEGIN
  IF to_regprocedure('public.health_home_tenant_id(uuid)') IS NOT NULL OR to_regprocedure('public.backfill_health_home_tenant(integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-05595 rollback: run rollback-130100 first (the functions still read app_users.health_home_tenant_id)';
  END IF;
END
$rb$;
DROP INDEX IF EXISTS public.idx_app_users_health_home_tenant;
ALTER TABLE public.app_users DROP CONSTRAINT IF EXISTS app_users_health_home_tenant_fkey;
ALTER TABLE public.app_users DROP COLUMN IF EXISTS health_home_tenant_id;
COMMIT;
