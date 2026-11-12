-- VTID-05595 rollback of 20261102130100 (apply BEFORE rollback-130000). Drops the two functions only. The frozen values
-- stay in app_users.health_home_tenant_id and in legacy_archive.bak_05595_health_home_tenant (30-day retention): nothing
-- is deleted here. Owner approval required (collaboration.md section 7d); not run by the PR.
BEGIN;
DROP FUNCTION IF EXISTS public.backfill_health_home_tenant(int);
DROP FUNCTION IF EXISTS public.health_home_tenant_id(uuid);
COMMIT;
