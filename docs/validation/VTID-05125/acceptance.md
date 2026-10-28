# VTID-05125 — FU9: revoke the `migrate` role's EXECUTE on the four memory functions

`write_fact`, `get_current_facts`, `recall_at_time_range` and `memory_facts_semantic_search` are SECURITY
DEFINER, take `p_user_id` and never check `auth.uid()`. VTID-05041 revoked `PUBLIC`/`anon`/`authenticated`,
but live (2026-10-12, `live-before.sql`) every one still had `migrate=X/postgres`. `migrate` is the AWS DMS
source role for the Supabase → Aurora migration; DMS never calls application RPCs. Whoever holds its
password could overwrite any member's facts through `write_fact`.

This slice deploys no service (no `services/gateway/**` change, so no staging suite). The only production
write is one `RUN-MIGRATION.yml` dispatch of the migration, gated on the read-only before-state check
(Gate 1, Owner decision 0). The migration is NOT applied by this PR.

AC-1 After apply, `migrate` cannot execute any overload of the four memory functions; `service_role` keeps
EXECUTE; `anon`/`authenticated` still cannot; the other ACL entries are unchanged
(`{postgres=X/postgres,service_role=X/postgres}`). Bodies are not touched.
TEST: scripts/ci/sql-tests/run-memory-functions-migrate-revoke-test.sh (case 1; outputs/sql-test.txt)
TEST: .github/workflows/SQL-MEMORY-FUNCTIONS-MIGRATE-REVOKE.yml

AC-2 The migration is idempotent: a second apply succeeds and the end state holds.
TEST: scripts/ci/sql-tests/run-memory-functions-migrate-revoke-test.sh (case 2)

AC-3 The migration checks itself by effect and rolls back as a whole (migrate keeps EXECUTE) when:
a member role holds EXECUTE (VTID-05041 regressed), `service_role` lacks EXECUTE, one of the four functions
is missing, or a fifth overload exists. Mutation-checked: REVOKE removed → refused; overload-count check
removed → the fifth-overload case fails; REVOKE and migrate check both removed → the harness fails
(outputs/mutations.txt).
TEST: scripts/ci/sql-tests/run-memory-functions-migrate-revoke-test.sh (cases 3–6; outputs/mutations.txt)

AC-4 No `migrate` role (fresh database, Aurora): the migration applies with the NOTICE
`VTID-05125: role migrate absent, nothing to revoke`, and the other checks still hold.
TEST: scripts/ci/sql-tests/run-memory-functions-migrate-revoke-test.sh (case 7)

AC-5 The test mirrors the live role graph: `migrate` LOGIN REPLICATION, `postgres` a member of `migrate`,
stub DEFINER functions with the four live signatures and the live ACL.
TEST: scripts/ci/sql-tests/run-memory-functions-migrate-revoke-test.sh (setup + fixture)

AC-6 Gateway memory callers and the VTID-05041 guards are unaffected (no gateway code change); the
VTID-05041 later-migration guard scans this migration and passes.
TEST: services/gateway: npx jest <18 suites that reference the four functions> (outputs/jest-memory.txt)
TEST: services/gateway: npm run test:support (outputs/jest-support.txt)
TEST: services/gateway/test/vtid-05041-definer-lockdown.test.ts (outputs/jest-migration-guards.txt)

AC-7 Production (rollout, read-only, orchestrator): immediately before dispatch, `live-before.sql` Q1 still
returns exactly 4 rows with migrate_x = service_x = true and auth_x = anon_x = false (else no dispatch). After
RUN-MIGRATION, `post-apply-checks.sql` returns `vtid_05125_ok = true`. Output recorded in commands.log.
TEST: docs/validation/VTID-05125/post-apply-checks.sql

Rollback (by hand, owner's go): `rollback.sql` re-grants EXECUTE to `migrate` on the four functions.
