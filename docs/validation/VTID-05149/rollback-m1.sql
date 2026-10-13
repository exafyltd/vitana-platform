-- VTID-05149 rollback R1: remove tenants.is_default / tenants.is_platform and
-- their constraint machinery (undoes M1, 20261014000100).
-- ONLY after rollback-m2.sql (the signup triggers read is_default) and after the
-- gateway is reverted (getDefaultTenantId/getTenantMeta read both columns; without
-- them they answer "no default" / slug null, which is logged, never a failed request).
-- Rehearsed in scripts/ci/sql-tests/run-tenant-foundation-test.sh.

BEGIN;
SET LOCAL lock_timeout = '3s';

DO $guard$
BEGIN
  IF position('is_default' IN pg_get_functiondef('public.handle_new_user()'::regprocedure)) > 0
     OR position('is_default' IN pg_get_functiondef('public.provision_platform_user()'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'VTID-05149 R1: the signup triggers still read is_default; apply rollback-m2.sql first';
  END IF;
END $guard$;

DROP TRIGGER IF EXISTS tenants_exactly_one_default ON public.tenants;
DROP FUNCTION IF EXISTS public.tenants_assert_one_default();
DROP INDEX IF EXISTS public.tenants_one_default;
ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_default_not_platform;
ALTER TABLE public.tenants DROP COLUMN IF EXISTS is_platform, DROP COLUMN IF EXISTS is_default;

COMMIT;
