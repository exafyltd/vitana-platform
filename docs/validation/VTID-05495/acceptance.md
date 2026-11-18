# VTID-05495 — mt-packs-r2 / content-overrides-db

Plan: `.kiro/specs/mt-packs-r2/plan.md` and the `content-overrides-db` group of `tasks.md` (C1-C3). Sparring record:
`plan-sparring.md`.

VALIDATION_PROFILE: database (migration file, pgTAP and read-only SQL only).
ROUTE_MOUNT: none. FINAL_URL: n/a. Change types: Database. Nothing is applied from the PR; the file is applied later
through `RUN-MIGRATION.yml` after the owner approves the file and the target database (collaboration.md §7d). Kiro ran no
SQL against any live system; the local runs are in-process PGlite (`pglite-harness/`).

## Files

| Task | File |
|---|---|
| C1 table, RLS, privileges | `supabase/migrations/20261101100000_mt_packs_tenant_content_overrides.sql` |
| C2 pgTAP (23 cases) | `supabase/tests/mt/mt_packs_tenant_content_overrides.sql` |
| C3 queue row 8a / drift baseline | `docs/multitenancy/MIGRATION-QUEUE.md`; `scripts/ci/migration-drift-baseline.json` (+1, count 113) |
| C3 rollback / read-only checks | `rollback.sql`, `pre-check.sql`, `post-check.sql` |
| static gate | `static-checks.test.cjs` |

## Acceptance

AC-1 (C1) `tenant_content_overrides(tenant_id, locale, key, value, updated_by, updated_at)` with PK
`(tenant_id, locale, key)`, an FK to `tenants` (the live key `tenant_id`), and a locale CHECK `^[a-z]{2}(-[A-Z]{2})?$`.
TEST: pgTAP cases 1-4 and 19-23 in supabase/tests/mt/mt_packs_tenant_content_overrides.sql.

AC-2 (C1) Service-role-only: RLS on, every client privilege revoked, `service_role` has full DML; an anon or
authenticated read or write fails with 42501.
TEST: pgTAP cases 5-18 in supabase/tests/mt/mt_packs_tenant_content_overrides.sql.

AC-3 (C2/C3) The migration applies twice without error and rolls back clean; the queue row sits directly before the
mt-launch rows; the drift baseline lists the not-yet-live table; the mt-launch queue-order assertion still holds.
TEST: node --test docs/validation/VTID-05495/static-checks.test.cjs (6 tests), and
`outputs/read-only-checks-and-rollback-pglite.txt`, `outputs/pgtap-green-applied-twice.txt`.

AC-4 Nothing is applied from the PR.
TEST: node --test docs/validation/VTID-05495/static-checks.test.cjs (the migration contains no DML and no DROP).

## Red / green

- pgTAP red without the migration: `outputs/pgtap-red-no-migration.txt`; green: `outputs/pgtap-green.txt` (23 ok), twice:
  `outputs/pgtap-green-applied-twice.txt`.
- Static test red on origin/main: `outputs/static-red-on-origin-main.txt` (1 pass, 5 fail); green: `outputs/static-green.txt`.
- `services/gateway/test/mt-launch-pack-intake-pgtap.test.ts` stays green (17 pass, `outputs/jest-mt-launch.txt`).

## Decisions taken

- The FK targets `tenants(tenant_id)`, the live key (VTID-04716), not `tenants(id)` as the plan text says.
- The queue row is numbered `8a` so it sits directly before row 9 without renumbering rows other lanes are editing.

## Fix-forward 1: staging-tests.json manifest (reviewer finding on de2209b8fc)
Decision taken: the manifest ref `node --test ...` is rejected by `EXISTING_REF` (scripts/ci/staging-verify/lib.cjs:123), which accepts only `npm run` or `npx jest|vitest run`. The static test lives under docs/validation and the gateway jest config does not pick it up, so a jest ref would not find it. Conservative option taken: a read-only `http` GET probe expecting 401 on an existing route, as VTID-05491 did. The static test still runs via `node --test`. Validator output: docs/validation/VTID-05495/outputs/manifest-validate.txt.
