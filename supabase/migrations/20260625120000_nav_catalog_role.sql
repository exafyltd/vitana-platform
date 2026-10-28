-- BOOTSTRAP-NAV-ROLE: role becomes a first-class scope on nav_catalog, parallel
-- to `platform`. The desktop sidebar (and the app at large) is ROLE-BASED —
-- AppLayout.getRoleNavigation(role) renders a different sidebar for community /
-- patient / professional / staff / admin, and those surfaces are largely
-- disjoint. So each role gets its OWN curated catalog, exactly like Mobile vs
-- Desktop are two catalogs today.
--
-- All existing rows are the consumer (community) app, so they backfill to
-- 'community'; the patient/professional/staff/admin catalogs start empty and are
-- curated deliberately in the admin Vitana Navigator (admin-only screen).
--
-- The scope key is now (screen_id, platform, role): a screen can live in the
-- desktop+community catalog, the mobile+community catalog, the desktop+patient
-- catalog, etc., each edited independently. developer/infra have no dedicated
-- sidebar (they fall through to community), so they are accepted by the CHECK
-- for completeness but not seeded.
--
-- impact-allow-solo-migration: schema half of a coordinated change; the gateway
-- (admin-navigator.ts) and the admin UI are updated in the same change set to
-- read/write/filter `role`. Additive and behavior-preserving — everything
-- defaults to 'community', matching today's single (community) catalog.
BEGIN;

-- 1. New dimension. Default 'community' backfills every existing row to the
--    current (community) catalog.
ALTER TABLE public.nav_catalog
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'community';

-- 2. Constrain to the known roles (guarded so the migration is re-runnable).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nav_catalog_role_chk'
  ) THEN
    ALTER TABLE public.nav_catalog
      ADD CONSTRAINT nav_catalog_role_chk CHECK (
        role IN ('community','patient','professional','staff','admin','developer','infra')
      );
  END IF;
END $$;

-- 3. Uniqueness is now per (platform, role): at most one shared row per
--    (screen_id, platform, role), and one per-tenant row per
--    (screen_id, platform, role, tenant_id). Drop the platform-only unique
--    indexes (from BOOTSTRAP-NAV-PLATFORM) and recreate them with role added.
DROP INDEX IF EXISTS public.nav_catalog_screen_platform_shared_uq;
DROP INDEX IF EXISTS public.nav_catalog_screen_platform_tenant_uq;

CREATE UNIQUE INDEX IF NOT EXISTS nav_catalog_screen_platform_role_shared_uq
  ON public.nav_catalog (screen_id, platform, role)
  WHERE tenant_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS nav_catalog_screen_platform_role_tenant_uq
  ON public.nav_catalog (screen_id, platform, role, tenant_id)
  WHERE tenant_id IS NOT NULL;

-- 4. Fast filtering of a single catalog (the admin lists one platform+role at a
--    time).
CREATE INDEX IF NOT EXISTS nav_catalog_platform_role_idx
  ON public.nav_catalog (platform, role);

COMMENT ON COLUMN public.nav_catalog.role IS
  'Which role-surface this catalog entry belongs to (community/patient/professional/staff/admin/developer/infra). The desktop sidebar is role-based; each role has its own catalog scoped by this column, parallel to platform.';

COMMIT;
