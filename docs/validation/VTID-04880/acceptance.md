# VTID-04880 — retire the legacy navigator's leftovers

Follow-up to VTID-04846 (gateway) and VTID-04853 (frontend), which retired the
legacy voice navigator. The screen registry is the only navigator. These
leftovers still read or wrote its tables, or set a flag nothing reads.

## Problem (read-only checks of production, 2026-10-05)

- The nightly `I18N-DB-SEED` cron still loaded `nav_catalog` and
  `nav_catalog_i18n`, sent drifted rows to Bedrock and wrote the results back.
  `nav_catalog_i18n.updated_at` was last written at 11:58 UTC on 2026-10-04.
  No code reads those translations.
- `ci_vital_systems_health()` reported `nav_catalog_incomplete_ga_locales`. The
  `/ops` locale-coverage check and the morning check (item 11) degraded or
  failed a locale over a table nobody reads.
- `NAV_V2_ENABLED=true` was still pinned on both gateway task definitions. No
  code has read it since VTID-04846.
- The three tables were still in `public`, exposed through PostgREST: 291,
  3,201 and 0 rows. No view depends on them. The only function body that names
  them is `ci_vital_systems_health`. The two tables share a touch trigger.
- The vitana-v1 language gate (`npm run i18n:gate`) counted `nav_catalog_i18n`
  rows as its "DB content" surface. That is handled in the vitana-v1 PR for this
  VTID.

## Change

- The db-i18n pipeline no longer has a `nav-catalog` surface: removed from the
  surface registry, both repository implementations, the Aurora bootstrap DDL,
  the change notifier and the `I18N-DB-SEED` workflow input.
  `scripts/nav/generate-nav-catalog-translations.mjs` is deleted.
- `evalLocaleCoverage` and the morning check judge the Guided Journey
  curriculum only.
- Neither deploy workflow sets `NAV_V2_ENABLED` any more. Both still strip it,
  so the next deploy removes it from the task definitions. `NAV_REGISTRY_URL`
  is unchanged. The flag pins were regenerated, and the setters that no longer
  do anything were removed from the tests.
- The domain atlas no longer lists the tables.
- Migration `20261005090000_vtid_04880_archive_nav_catalog.sql`, in one
  transaction:
  - redefines `ci_vital_systems_health()` without the two nav keys;
  - drops the archived `lang` FK to `supported_locales`;
  - moves the three tables and `nav_catalog_touch_updated_at()` into
    `legacy_archive`;
  - guards that no `public` view or function still uses them.

  It archives and does not drop. The rollback is in its header.
- The migration drift check treats `ALTER TABLE public.x SET SCHEMA …` as x
  leaving `public` (`triage-missing-tables.cjs` reuses the same parser).
- The Aurora restore dumps guard every statement on these tables with
  `to_regclass`. The cutover runbook notes the archive.

## Acceptance criteria

AC-1: no gateway source or script reads the archived tables. Every Aurora
  restore statement on them is guarded. The db-i18n pipeline has no
  nav-catalog surface.
TEST: npx jest test/navigation/vtid-04880-legacy-navigator-retired.test.ts

AC-2: neither deploy workflow sets NAV_V2_ENABLED, both still strip it, and the
  registry URLs are unchanged.
TEST: npx jest test/vtid-04517-staging-nav-v2-pinned.test.ts test/services/conversation/vtid-04525-conversation-flag-registry.test.ts

AC-3: a locale whose only gap is the retired catalog is `ok`. A curriculum gap
  is still `degraded`.
TEST: npx jest test/vtid-04663-ops-health-checks.test.ts

AC-4: the seeder covers the journey checklist only and rejects `nav-catalog` by
  name. The Aurora repository passes its live-Postgres suite (18/18, local
  Postgres 16).
TEST: npx jest test/db-i18n

AC-5: the drift check counts SET SCHEMA out of `public` as a removal and into
  `public` as a declaration, and ignores one in a comment.
TEST: npx jest test/scripts/check-migration-drift.test.ts

AC-6: the migration, replayed on a local Postgres 16 seeded with the original
  nav_catalog migration, the FK and the 03679 health function:
  - applies cleanly, with all rows kept and no nav keys left in the health
    function;
  - rolls back with its header and applies again;
  - leaves the archived touch trigger still working;
  - aborts, with nothing moved, when a public view or function still uses the
    tables.

  See `outputs/migration-dry-run.txt`.

AC-7: voice navigation is unchanged.
TEST: npx jest test/navigation test/nav-redirect test/nav-golden

## Order of application

1. This PR merges (no reader or writer is left on `main`, and the nightly cron
   runs from `main`).
2. The vitana-v1 PR for VTID-04880 merges (its gate stops querying the table).
3. `RUN-MIGRATION.yml` with `supabase/migrations/20261005090000_vtid_04880_archive_nav_catalog.sql`.
   The owner approved this in-session on 2026-10-05. Read-only checks after
   apply: `to_regclass('public.nav_catalog')` is null,
   `legacy_archive.nav_catalog_i18n` has 3,201 rows, and
   `ci_vital_systems_health()` has no nav keys.

## Not in this change

- Aurora's own copies of these tables, if any, are left as they are.
- One line in `aurora-restore-02-check-unique-constraints.sql`
  (`nav_catalog_role_chk`) already had a truncated string literal in the
  2026-08-12 dump and fails to parse, with or without this change. It is
  guarded like the rest, and the defect itself is left alone.
