-- VTID-05595 (mt-native-health-r2/health-home-tenant-db) H1: public.app_users.health_home_tenant_id.
--
-- A member's health data belongs to the member, never to a tenant. The member's "frozen health home tenant" is the
-- one tenant every health read and write uses, whichever tenant the session carries (ab_dual members included).
-- This file only adds the nullable column and its index (expand only). It changes no read path, no policy and no row.
-- The resolver function and the batched backfill are the next file (20261102130100).
--
-- The column is nullable: NULL means "not frozen yet", and health_home_tenant_id(user) then falls back to the
-- member's single primary user_tenants row (file 130100). The FK is added with NO ACTION on delete: a tenant that
-- still holds a member's frozen health home cannot be deleted by accident.
--
-- Safe to re-run (IF NOT EXISTS). lock_timeout 3s with up to 5 retries on lock_not_available.
-- Rollback: docs/validation/VTID-05595/rollback-130000-health-home-tenant-column.sql
-- Order: docs/multitenancy/MIGRATION-QUEUE.md (row 43).

BEGIN;

DO $mig$
DECLARE
  v_try int := 0;
  v_key text;
BEGIN
  IF to_regclass('public.app_users') IS NULL THEN
    RAISE EXCEPTION 'VTID-05595: public.app_users is missing; refusing to add health_home_tenant_id';
  END IF;
  IF to_regclass('public.tenants') IS NULL THEN
    RAISE EXCEPTION 'VTID-05595: public.tenants is missing; refusing to add health_home_tenant_id';
  END IF;

  -- The live tenants key is tenants(tenant_id) (VTID-04716); a fresh local stack built from the bootstrap has tenants(id).
  SELECT c.column_name INTO v_key
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'tenants' AND c.column_name IN ('tenant_id', 'id')
   ORDER BY (c.column_name = 'tenant_id') DESC
   LIMIT 1;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'VTID-05595: public.tenants has neither tenant_id nor id; refusing to add health_home_tenant_id';
  END IF;

  LOOP
    v_try := v_try + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';

      ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS health_home_tenant_id uuid NULL;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conname = 'app_users_health_home_tenant_fkey'
                        AND conrelid = 'public.app_users'::regclass) THEN
        EXECUTE format('ALTER TABLE public.app_users '
                    || 'ADD CONSTRAINT app_users_health_home_tenant_fkey '
                    || 'FOREIGN KEY (health_home_tenant_id) REFERENCES public.tenants(%I)', v_key);
      END IF;

      CREATE INDEX IF NOT EXISTS idx_app_users_health_home_tenant
        ON public.app_users (health_home_tenant_id)
        WHERE health_home_tenant_id IS NOT NULL;

      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF v_try >= 5 THEN
        RAISE EXCEPTION 'VTID-05595: could not lock public.app_users after % tries; run off-peak', v_try;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END
$mig$;

COMMENT ON COLUMN public.app_users.health_home_tenant_id IS
  'VTID-05595: the member''s frozen health home tenant. NULL = not frozen; public.health_home_tenant_id(user) then uses the single primary user_tenants row. Written only by the service role.';

COMMIT;
