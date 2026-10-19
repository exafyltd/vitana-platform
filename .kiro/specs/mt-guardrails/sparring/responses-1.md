# Responses — round 1 (session 496d49e4)

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified: scripts/ci/sql-tests/vtid-05149-tenant-foundation.test.sql:13 does CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE auth.users because SQL-TENANT-FOUNDATION.yml:33 runs on postgres:16, while this suite runs on supabase/postgres where auth is pre-installed. Plan lane 1 now states: dump is pg_dump --schema=public --schema-only, enforced by the regenerate script (refuses any other schema); auth/storage/realtime are never re-created; fixtures INSERT into the existing auth.users, never CREATE it, and the 05149 fixture must not be copied for this. The smoke test asserts to_regclass('auth.users') is non-null before the dump/fixtures load (an existence assertion, equivalent to the suggested 'CREATE fails' check without a DDL side effect). tasks.md T1/T2/T5 and lanes/local-test-stack.md updated; paths unchanged.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified: SQL-TENANT-FOUNDATION.yml:13 lists specific files, while SQL-HEALTH-STORE.yml:13 and SQL-MEMORY-SENSITIVITY.yml:10 use scripts/ci/sql-tests/**. Plan lane 3 and lane 6 now say SQL-MT-ISOLATION.yml's paths: uses the glob like SQL-HEALTH-STORE.yml/SQL-MEMORY-SENSITIVITY.yml, not SQL-TENANT-FOUNDATION.yml's file list (which stays the model for everything except paths:). tasks.md P1/C1/C3 and lanes/isolation-suite.md updated.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified: scripts/ci/sql-tests/run-tenant-foundation-test.sh:18-20 refuses PGHOST matching *supabase*|*amazonaws*|*rds* with exit 2. Plan lane 3 now requires run-mt-isolation-test.sh to start with that guard verbatim, the Tests section adds a case asserting PGHOST=x.supabase.co exits 2 before connecting, and lane 6 states SQL-MT-ISOLATION.yml's PGHOST is only the service container, never a live endpoint. tasks.md P3/C3 and lanes/isolation-suite.md updated.",
    "deferred_to": null
  }
]
```
