-- BOOTSTRAP-NAV-PLATFORM: foundation for two separate Vitana Navigator catalogs
-- (Mobile MAXINA + Desktop MAXINA).
--
-- `platform` becomes a first-class scope on nav_catalog, orthogonal to tenant_id.
-- A screen_id can live in the Mobile catalog, the Desktop catalog, or both —
-- edited independently. All existing rows are the current (Mobile) catalog, so
-- they backfill to 'mobile'; the Desktop catalog starts empty and is curated
-- deliberately as the next step.
--
-- impact-allow-solo-migration: this is the schema half of a coordinated change;
-- the gateway (nav-catalog-db.ts, admin-navigator.ts) and admin UI are updated
-- in the same change set to read/write `platform`. The change is additive and
-- behavior-preserving — everything defaults to 'mobile', matching today.
BEGIN;

-- 1. New dimension. Default 'mobile' backfills every existing row to the
--    current (Mobile) catalog.
ALTER TABLE public.nav_catalog
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'mobile';

-- 2. Constrain to the two known surfaces (guarded so the migration is re-runnable).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nav_catalog_platform_chk'
  ) THEN
    ALTER TABLE public.nav_catalog
      ADD CONSTRAINT nav_catalog_platform_chk CHECK (platform IN ('mobile', 'desktop'));
  END IF;
END $$;

-- 3. Uniqueness is now per-platform: at most one shared row per (screen_id,
--    platform), and one per-tenant row per (screen_id, platform, tenant_id).
--    Drop the old screen-only unique indexes and recreate them with platform.
DROP INDEX IF EXISTS public.nav_catalog_screen_shared_uq;
DROP INDEX IF EXISTS public.nav_catalog_screen_tenant_uq;

CREATE UNIQUE INDEX IF NOT EXISTS nav_catalog_screen_platform_shared_uq
  ON public.nav_catalog (screen_id, platform)
  WHERE tenant_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS nav_catalog_screen_platform_tenant_uq
  ON public.nav_catalog (screen_id, platform, tenant_id)
  WHERE tenant_id IS NOT NULL;

-- 4. Fast filtering of a single catalog (the admin lists one platform at a time).
CREATE INDEX IF NOT EXISTS nav_catalog_platform_idx
  ON public.nav_catalog (platform);

COMMENT ON COLUMN public.nav_catalog.platform IS
  'Which MAXINA surface this catalog entry belongs to: mobile or desktop. The two catalogs share this table but are scoped (and edited) separately by this column.';

COMMIT;
