# Security live-evidence pack: memory functions, grants and RLS (VTID-05693)

Lane `strategy-execution-wave1/security-evidence`. Pinned to vitana-platform `origin/main`
`6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`. Every `file:line` below resolves at that commit (checked in
`docs/validation/VTID-05693/commands.log`).

This lane adds one read-only SQL file and this document. It changes no migration, grant, policy, role, flag or code,
and it never connected to a database. Every statement carries one status class: Verified operational (only with a run
id); Verified implemented, not operational; Implemented but incomplete; Designed but not implemented;
Deprecated/superseded; Unknown.

## 1. Why this check exists

The four memory-fact functions `write_fact`, `get_current_facts`, `recall_at_time_range` and
`memory_facts_semantic_search` are SECURITY DEFINER (`prosecdef = t` in the last live read,
`docs/validation/VTID-05125/live-before.sql:18-23`). The strategy memory audit recorded them as executable by
`authenticated` on 2026-10-06. Two migrations remove that:

- VTID-05041 revokes every overload from `PUBLIC, anon, authenticated` and grants `service_role` only
  (`supabase/migrations/20261010164100_vtid_05041_definer_functions_lockdown.sql:37-47`), then raises an exception if
  a member can still execute one or if `service_role` lost EXECUTE
  (`supabase/migrations/20261010164100_vtid_05041_definer_functions_lockdown.sql:145-161`).
  Status: Verified implemented, not operational (migration text read; the apply run is not re-read by this lane).
- VTID-05125 revokes every overload from `migrate`
  (`supabase/migrations/20261013090000_vtid_05125_memory_functions_revoke_migrate.sql:52-54`).
  Status: Verified implemented, not operational (same reason).

What is missing is a live read of the privileges after both migrations. The strategy evidence register (EV-095) and the
final review re-verification (row 2) both record the live `has_function_privilege` state as Unknown.

## 2. Current recorded evidence

| Item | What is recorded | Where | Status |
|---|---|---|---|
| VTID-05041 apply | RUN-MIGRATION run 38059078694 | Strategy evidence register EV-095 (not in this repository; run not re-read by this lane) | Verified implemented, not operational |
| VTID-05125 apply | RUN-MIGRATION run 38360259959 | Strategy evidence register EV-095 (same) | Verified implemented, not operational |
| VTID-05041 post-apply result | Placeholder only: "run docs/validation/VTID-05041/post-apply-checks.sql read-only and paste the result here" | `docs/validation/VTID-05041/commands.log:36-37` | Unknown (no result recorded) |
| VTID-05125 post-apply result | Placeholder only: rollout step 3 "run post-apply-checks.sql read-only and paste the result here" | `docs/validation/VTID-05125/commands.log:29-32` | Unknown (no result recorded) |
| Last recorded live read | 2026-10-12 22:42 UTC, before VTID-05125: four overloads, `prosecdef = t`, `auth_x = f`, `anon_x = f`, `service_x = t`, `migrate_x = t` | `docs/validation/VTID-05125/live-before.sql:18-23` | Deprecated/superseded by VTID-05125 (the `migrate` value is expected to have changed); no later read recorded |
| `migrate` role attributes | `rolbypassrls = t`, `rolcanlogin = t`, `rolsuper = f` on 2026-10-12 | `docs/validation/VTID-05125/live-before.sql:31-33` | Unknown today (not re-read) |

Existing read-only post-apply files that an operator can also run: VTID-05041's
(`docs/validation/VTID-05041/post-apply-checks.sql:7-47`, Q1 to Q4; it also reads `fn_consume_credits` and `get_user_profile_by_identifier`) and
VTID-05125's (`docs/validation/VTID-05125/post-apply-checks.sql:7-23`, the four functions including `migrate`). The new file
below does not replace them. It adds the `migrate` and `service_role` columns in one place, guards missing roles, and
adds the RLS and policy read for the memory and tenant tables.

## 3. What the new SQL checks

File: `scripts/sql/readonly/strategy-memory-grants-check.sql`. Catalog SELECTs only.

| Query | What it reads | Expected result |
|---|---|---|
| Q0 | `current_database()`, `current_user`, `transaction_read_only`, server version, time | `transaction_read_only = on` |
| Q1 | The four roles `anon`, `authenticated`, `service_role`, `migrate` (`to_regrole`), with `rolsuper`, `rolbypassrls`, `rolcanlogin` | Four rows, each `role_exists = true` |
| Q2 | Every overload of the four functions × the four roles: `has_function_privilege`, `prosecdef`, owner, `proacl`, PUBLIC EXECUTE from `aclexplode` | `anon`, `authenticated`, `migrate`: `can_execute = false`; `service_role`: `true`; `public_execute = false` |
| Q3 | One verdict row | `memory_functions_ok = true`, `functions_found = 4` |
| Q4 | `relrowsecurity`, `relforcerowsecurity`, owner and policy count for `memory_items`, `memory_facts`, `memory_diary_entries`, `relationship_edges`, `vtid_ledger`, `oasis_events`, `user_tenants`, `tenants`, `app_users` (`to_regclass` guarded) | Every table exists; `relrowsecurity = true` on every member-data table; the rest recorded as found |
| Q5 | Every `pg_policies` row on those nine tables, verbatim | Recorded as found |
| Q6 | `has_table_privilege` SELECT/INSERT/UPDATE/DELETE for the four roles on the nine tables | Recorded as found |

A missing role or table returns NULL or `false` in its row instead of an error, so one run always completes.

Q4 to Q6 have no single pass value on purpose. Judging whether each policy is tenant-correct is the job of the
multi-tenant programme's Track S, not of this lane. One point matters when reading the output: on 2026-10-12
`migrate` had `rolbypassrls = t` (`docs/validation/VTID-05125/live-before.sql:31-33`), so RLS on these tables does not
limit that role. Only its function and table privileges do.

The test `scripts/sql/readonly/strategy-memory-grants-check.test.mjs` proves the file is read-only without a database.
It strips comments, blanks string literals, splits the file into statements and fails if any statement starts with
anything other than SELECT or WITH. It also fails if a write, DDL, privilege, transaction or session keyword (INSERT,
UPDATE, DELETE, MERGE, CREATE, ALTER, DROP, GRANT, REVOKE, TRUNCATE, COPY, CALL, DO, SET, RESET, BEGIN, COMMIT,
VACUUM, ANALYZE, LOCK, COMMENT, SECURITY, EXECUTE and similar) starts a statement or a sub-statement, and on
`SELECT ... INTO`, row locks, side-effect functions such as `set_config`, dollar-quoted bodies and psql
meta-commands. It also fails if the four function names, the four role names, the nine table names or the catalog
terms are missing. Run: `node --test scripts/sql/readonly/strategy-memory-grants-check.test.mjs`.

## 4. Who runs it, and how

- **Who:** an authorised operator with read access to the production Supabase project (staging shares that database).
  Not an agent session, not CI, not this lane. The project rules forbid agents from writing to or testing against
  production, and this lane never connects to any database.
- **How:** through a read-only connection. Use the same read-only catalog access that recorded
  `docs/validation/VTID-05125/live-before.sql` (`docs/validation/VTID-05125/commands.log:3-5`). Open the session
  read-only, for example `PGOPTIONS='-c default_transaction_read_only=on' psql -f scripts/sql/readonly/strategy-memory-grants-check.sql`,
  so Q0 shows `transaction_read_only = on`. No dedicated read-only live-SQL workflow was identified for this lane. The
  `SQL-MEMORY-FUNCTIONS-MIGRATE-REVOKE.yml` workflow runs against a throwaway Postgres container and never against
  Supabase (`.github/workflows/SQL-MEMORY-FUNCTIONS-MIGRATE-REVOKE.yml:4-9`), so it is not that path.
- **Optional, same session:** run `docs/validation/VTID-05041/post-apply-checks.sql` and
  `docs/validation/VTID-05125/post-apply-checks.sql`. Paste their results into those VTIDs' `commands.log`
  placeholders, which closes `docs/validation/VTID-05041/commands.log:36-37` and
  `docs/validation/VTID-05125/commands.log:29-32`.

## 5. Where the output goes

`docs/validation/VTID-05693/live-output.md`. It does not exist yet and is added later by the operator's PR. It must
contain the database, `run_as`, `transaction_read_only` and `captured_at` from Q0; the full output of Q1 to Q6; the
`git rev-parse HEAD` of the SQL file used; and the name of the operator role, not a personal e-mail address. No
member data is read by this file, so the output contains catalog metadata only. If a policy `qual` or `with_check`
names something sensitive, keep it in the output, because it is the evidence.

## 6. What stays blocked until the output is recorded

Until `docs/validation/VTID-05693/live-output.md` exists with `memory_functions_ok = true` and the Q4 to Q6 rows, the
live state of memory-function privileges and table RLS is Unknown. Until then these stay blocked:

- sensitive memory implementation (new readers or writers of `memory_facts`, `memory_items`, `memory_diary_entries`,
  `relationship_edges`, or any new caller of the four functions);
- tenant implementation that depends on `user_tenants`, `tenants` or `app_users` RLS being as the migrations say;
- permission changes (grants, revokes, roles, policies), which also need their own sparred plan and owner-approved
  migration under `.claude/rules/collaboration.md` §7d;
- financial implementation that relies on the same definer-function lockdown (the VTID-05041 post-apply check also
  reads `fn_consume_credits`, locked down by VTID-04981, `docs/validation/VTID-05041/post-apply-checks.sql:2-4,16-17`).

A clean output unblocks only the claim "the live privileges match the migrations". It does not settle the residual
recorded in final review row 2: the functions still trust `p_user_id` from `service_role` callers. That stays an
open item for the multi-tenant programme's Track S.

## 7. Proposed follow-ups (not done here)

| Title | Files | Risk | Owner | Gate |
|---|---|---|---|---|
| Record the live grants and RLS output | `docs/validation/VTID-05693/live-output.md` | Low (read-only), but it reads production | Authorised operator; security owner | Operator access; no migration |
| Close the VTID-05041 and VTID-05125 post-apply placeholders | `docs/validation/VTID-05041/commands.log`, `docs/validation/VTID-05125/commands.log` | Low | Same operator | Same session as above |
| Assess each Q5 policy for tenant correctness | Multi-tenant programme Track S specs | Medium | Multi-tenant programme Track S | Its own sparred plan |
| Remove the `p_user_id` trust in the four functions | New migration | High (behaviour of memory writes) | Multi-tenant programme Track S | Sparred plan, owner-approved migration (§7d) |
