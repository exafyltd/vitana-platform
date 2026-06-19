-- BOOTSTRAP-NAV-ROLE-SCOPING: persist per-entry role scope on nav_catalog.
--
-- The desktop MAXINA surface is a ROLE MATRIX, not a flat list: community,
-- patient, professional, staff, admin, developer (and infra) each see a
-- different set of screens. The compile-time NavCatalogEntry already carries
-- `allowed_roles` and the retrieval filter (navigation-catalog.ts
-- resolveEffectiveRoles) already honours it — but the DB had no column, so
-- DB-seeded rows could not record which role(s) a screen belongs to.
--
-- This adds `allowed_roles TEXT[]` (nullable). Semantics, matching the runtime:
--   NULL / empty  → role is inferred from route/category (defaults community);
--                   preserves today's behaviour for every existing row.
--   non-empty     → explicit role scope; only those roles see the entry.
-- Role identifiers mirror the frontend useRole taxonomy: 'community',
-- 'patient', 'professional', 'staff', 'admin', 'developer', 'infra'.
--
-- impact-allow-solo-migration: additive, behaviour-preserving (every existing
-- row stays NULL = inferred). The gateway loader (nav-catalog-db.ts), admin
-- CRUD (admin-navigator.ts) and admin UI are updated in the same change set to
-- read/write the column.
BEGIN;

ALTER TABLE public.nav_catalog
  ADD COLUMN IF NOT EXISTS allowed_roles TEXT[] NULL;

COMMENT ON COLUMN public.nav_catalog.allowed_roles IS
  'Roles that may see this entry (community/patient/professional/staff/admin/developer/infra). NULL or empty = inferred from route/category (defaults community). Mirrors NavCatalogEntry.allowed_roles + resolveEffectiveRoles in the gateway.';

COMMIT;
