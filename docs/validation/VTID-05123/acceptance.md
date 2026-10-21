# VTID-05123 - RUN-MIGRATION records each applied repo file in supabase_migrations.schema_migrations

Owner approval 2026-10-12 (Gate 1: "Yes"). Sparring: `plan-sparring.md` (converged, 2 rounds).

VALIDATION_PROFILE: gateway_backend

Scope: CI only (`scripts/ci/apply-sql-via-management-api.sh --record-migration`,
`.github/workflows/RUN-MIGRATION.yml`, a new SQL test and its workflow, one
`DATABASE_SCHEMA.md` entry). Deploys nothing, so there is no staging suite and
no Gate 2. First live proof is the next RUN-MIGRATION run, checked read-only:
`SELECT * FROM supabase_migrations.schema_migrations WHERE idempotency_key = '<file>'`.

OASIS_PROOF: none; no OASIS events are emitted or changed.

## Acceptance criteria

AC-1: A successful RUN-MIGRATION apply of `supabase/migrations/<digits>_<name>.sql` writes exactly one row (version = digit prefix, name = rest, idempotency_key = filename, created_by = `github-actions:RUN-MIGRATION:<run_id>`, statements/rollback NULL), with and without the file's own BEGIN/COMMIT, and exits 0.
  TEST: scripts/ci/sql-tests/run-record-migration-row-test.sh (cases 1, 2, 11)
AC-2: A failed migration never gets a row: a RAISE with or without its own BEGIN rolls the DDL back, writes no row and exits 1; a partial apply (`BEGIN; DDL; COMMIT; <error>`) leaves the committed DDL, writes no row and exits 1 (accepted edge case, pinned).
  TEST: scripts/ci/sql-tests/run-record-migration-row-test.sh (cases 3, 4, 5)
AC-3: Re-running the same file is a no-op (one row, exit 0, no collision warning).
  TEST: scripts/ci/sql-tests/run-record-migration-row-test.sh (case 6)
AC-4: A version already held by another file or by an MCP/dashboard row (NULL idempotency_key) is never overwritten: the migration applies, no row is written, a `::warning::` names the holder, exit 0. The pre-check-to-apply race is caught by the unique_violation guard (warning, exit 0).
  TEST: scripts/ci/sql-tests/run-record-migration-row-test.sh (cases 7, 8, 9)
AC-5: A failed pre-check request exits 1 before anything is applied (DDL absent, no row).
  TEST: scripts/ci/sql-tests/run-record-migration-row-test.sh (case 10)
AC-6: Nothing unchecked reaches SQL and nothing outside `supabase/migrations/<file>.sql` is recorded: data-fixups paths, odd basenames, a basename with a quote, a non-numeric RUN_ID and a CONCURRENTLY file apply with a warning and no row (the CONCURRENTLY payload is sent unchanged).
  TEST: scripts/ci/sql-tests/run-record-migration-row-test.sh (cases 12, 13)
AC-7: Every other caller is unchanged: without the flag the script sends exactly the file text in one request and writes no row; `--record-migration` with `--sql` is a usage error (exit 2); the ORB database-migrations tools (dispatch input unchanged) stay green.
  TEST: scripts/ci/sql-tests/run-record-migration-row-test.sh (case 14)
  TEST: services/gateway/test/orb-tools/database-migrations-tools.test.ts
AC-8: CI runs the test on a throwaway Postgres for every PR that touches the script, the test or either workflow, and asserts it ran to the end.
  TEST: .github/workflows/SQL-RECORD-MIGRATION-ROW.yml
