# Sparring round 1 — in_progress

Session: `496d49e4-e3b5-4421-86d0-edaa18ddb659` · plan hash `0cfa992b8fa5c6585426b534024f48979a22677d90b7dcdf9e73ab691072b345`

## Summary

The plan is structurally sound and almost all premises hold against the pinned commit. Three confirmed issues: (1) the isolation-suite fixture is pointed toward the tenant-foundation harness as the modelling analogue, but that harness creates `auth.users` from scratch for `postgres:16` — a pattern that fails on `supabase/postgres` where the auth schema is pre-installed; the plan never explicitly constrains the production schema dump to public-schema-only or states the fixture must INSERT (not CREATE) auth.users; (2) the claim that "`SQL-MT-ISOLATION.yml`'s `paths:` stays on `scripts/ci/sql-tests/**` like every `SQL-*.yml`" is specifically false for `SQL-TENANT-FOUNDATION.yml`, the stated closest-analogue workflow, which uses specific file paths; (3) the isolation runner spec omits the PGHOST production-connection guard present in every analogous runner. Additionally, the plan's baseline claim "latest migration `20261015180000`" cannot be confirmed against the pinned commit — `MIGRATION-QUEUE.md` tops out at `20261014000700` and no matching migration file surfaced in evidence.

## Findings

### R1-F1 [major]

The isolation-suite fixture will be authored by analogy with `vtid-05149-tenant-foundation.test.sql`, which `CREATE TABLE auth.users` from scratch because it runs on `postgres:16`. The new isolation suite uses `supabase/postgres`, where the auth schema is pre-installed. An implementer following that analogy will produce fixture SQL that fails with 'relation already exists'. The plan says the schema comes from a production dump (correct) but never states: (a) the dump must be scoped to the public schema only — auth.*, storage.*, realtime.* are pre-installed in the image; (b) the fixture must INSERT INTO the pre-existing auth.users, not CREATE it; (c) the regenerate script must enforce this scope. All existing SQL-*.yml workflows use `postgres:16` so no prior art on this constraint exists in the repo.

- `exafyltd/vitana-platform:scripts/ci/sql-tests/vtid-05149-tenant-foundation.test.sql:13` — CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text,
  raw_user_meta_data jsonb,
  raw_app_meta_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
- `exafyltd/vitana-platform:.github/workflows/SQL-TENANT-FOUNDATION.yml:33` — services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_PASSWORD: postgres
- `exafyltd/vitana-platform:.github/workflows/SQL-HEALTH-STORE.yml:22` — jobs:
  sql:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16

Suggestion: Add an explicit constraint to lane 1's spec: 'The production schema dump is scoped to public schema only (`pg_dump --schema=public --schema-only`). The auth.*, storage.* and realtime.* schemas are pre-installed by the `supabase/postgres` image and must never be re-created in the dump or fixture SQL. The fixture INSERTs test rows into the existing auth.users; it does not CREATE it. The smoke test for lane 1 must assert that `CREATE TABLE auth.users` fails (auth.users already exists) on the running stack.' The regenerate script must enforce this scope.

### R1-F2 [minor]

The plan states '`SQL-MT-ISOLATION.yml`'s `paths:` stays on `scripts/ci/sql-tests/**` like every `SQL-*.yml` (R2-F3)'. But `SQL-TENANT-FOUNDATION.yml` — the workflow explicitly cited as the closest analogue for the isolation suite — does NOT use `scripts/ci/sql-tests/**`. It uses four specific file paths. `SQL-HEALTH-STORE.yml` and `SQL-MEMORY-SENSITIVITY.yml` do use the glob. The claim 'like every SQL-*.yml' is false for the named model, creating ambiguity: an implementer modelling lane 6's workflow on `SQL-TENANT-FOUNDATION.yml` (as the plan directs) will implement specific file paths instead of the glob.

- `exafyltd/vitana-platform:.github/workflows/SQL-TENANT-FOUNDATION.yml:13` — on:
  pull_request:
    paths:
      - 'supabase/migrations/*_vtid_05149_*.sql'
      - 'docs/validation/VTID-05149/*.sql'
      - 'scripts/ci/sql-tests/run-tenant-foundation-test.sh'
      - 'scripts/ci/sql-tests/vtid-05149-tenant-foundation.test.sql'
- `exafyltd/vitana-platform:.github/workflows/SQL-HEALTH-STORE.yml:13` — on:
  pull_request:
    paths:
      - 'supabase/migrations/*health_store*.sql'
      - 'supabase/migrations/*erase_user_data*.sql'
      - 'scripts/ci/sql-tests/**'
- `exafyltd/vitana-platform:.github/workflows/SQL-MEMORY-SENSITIVITY.yml:10` — on:
  pull_request:
    paths:
      - 'supabase/migrations/*memory_sensitivity*.sql'
      - 'scripts/ci/sql-tests/**'
      - '.github/workflows/SQL-MEMORY-SENSITIVITY.yml'

Suggestion: Replace 'like every `SQL-*.yml`' with 'like `SQL-HEALTH-STORE.yml` and `SQL-MEMORY-SENSITIVITY.yml`' (not `SQL-TENANT-FOUNDATION.yml`, which uses specific file paths). This removes the ambiguity and points lane 6's implementer to the correct models for the `paths:` trigger.

### R1-F3 [minor]

The plan specifies no production-connection guard for `run-mt-isolation-test.sh`. The existing `run-tenant-foundation-test.sh` (lines 18-20) pattern-matches PGHOST against `*supabase*|*amazonaws*|*rds*` and exits 2 if matched. This guard is particularly important for the isolation suite, which asserts cross-tenant access controls — running it against a shared or production database would silently test real data rather than fixtures. The plan mentions 'no production access of any kind' for lane 1 but does not prescribe the guard in the runner script itself.

- `exafyltd/vitana-platform:scripts/ci/sql-tests/run-tenant-foundation-test.sh:18` — case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac

Suggestion: Add to the lane 3 runner spec: '`run-mt-isolation-test.sh` MUST include a PGHOST guard identical to the one at `run-tenant-foundation-test.sh:18-20` (pattern `*supabase*|*amazonaws*|*rds*`, exit 2). Lane 6's `SQL-MT-ISOLATION.yml` must not pass PGHOST pointing at any live endpoint.'

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
