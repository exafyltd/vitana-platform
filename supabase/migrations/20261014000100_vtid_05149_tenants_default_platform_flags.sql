-- VTID-05149 (multi-tenant M0, lane A) M1: tenants.is_default / tenants.is_platform.
--
-- The signup triggers and the gateway's /auth/me auto-provision fall back to
-- "the oldest tenant" (ORDER BY created_at LIMIT 1). maxina and alkalma share
-- the same created_at (2025-08-30 16:27:07.760873+00), so that answer depends on
-- physical row order. This adds an explicit default-tenant flag (exactly one
-- row, enforced) and the platform-tenant flag later slices build on. It is
-- inert on apply: nothing reads either column until M2 and the gateway deploy.
--
--   is_default   exactly one tenant: at most one by a partial unique index,
--                at least one by a deferred constraint trigger checked at COMMIT
--                (so swapping the default inside one transaction works).
--   is_platform  never together with is_default (CHECK). No row has it yet; the
--                platform tenant row is a later slice.
--
-- Statement order matters: columns → CHECK → index → trigger function →
-- constraint trigger → the maxina UPDATE last. The trigger is DEFERRABLE
-- INITIALLY DEFERRED, so it evaluates at COMMIT, after the UPDATE.
-- Rollback: docs/validation/VTID-05149/rollback-m1.sql (only after R2 and after
-- the gateway is reverted).

BEGIN;
SET LOCAL lock_timeout = '3s';

DO $guard$
DECLARE
  v_total int;
  v_maxina int;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'is_default'
  ) THEN
    RAISE EXCEPTION 'VTID-05149 M1: tenants.is_default already exists (already applied?)';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE slug = 'maxina') INTO v_total, v_maxina FROM public.tenants;
  IF v_total <> 2 OR v_maxina <> 1 THEN
    RAISE EXCEPTION 'VTID-05149 M1: expected exactly 2 tenants, one of them maxina; found % tenants, % maxina', v_total, v_maxina;
  END IF;
END $guard$;

ALTER TABLE public.tenants
  ADD COLUMN is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN is_platform boolean NOT NULL DEFAULT false;

ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_default_not_platform CHECK (NOT (is_default AND is_platform));

CREATE UNIQUE INDEX tenants_one_default ON public.tenants ((true)) WHERE is_default;

CREATE FUNCTION public.tenants_assert_one_default()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_defaults int;
BEGIN
  SELECT count(*) INTO v_defaults FROM public.tenants WHERE is_default;
  IF v_defaults <> 1 THEN
    RAISE EXCEPTION 'VTID-05149: exactly one tenant must have is_default = true, found %', v_defaults
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$fn$;

-- Postgres fires the trigger whatever the caller's EXECUTE privilege; members
-- never call it directly.
REVOKE ALL ON FUNCTION public.tenants_assert_one_default() FROM PUBLIC, anon, authenticated;

CREATE CONSTRAINT TRIGGER tenants_exactly_one_default
  AFTER INSERT OR UPDATE OF is_default OR DELETE ON public.tenants
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.tenants_assert_one_default();

UPDATE public.tenants SET is_default = true WHERE slug = 'maxina';

DO $check$
DECLARE
  v_defaults int;
  v_slug text;
BEGIN
  SELECT count(*) FILTER (WHERE is_default), max(slug) FILTER (WHERE is_default)
    INTO v_defaults, v_slug FROM public.tenants;
  IF v_defaults <> 1 OR v_slug IS DISTINCT FROM 'maxina' THEN
    RAISE EXCEPTION 'VTID-05149 M1: expected maxina as the only default tenant, found % default(s), slug %', v_defaults, v_slug;
  END IF;
END $check$;

COMMIT;
