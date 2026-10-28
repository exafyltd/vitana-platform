# FU7 — RUN-MIGRATION records what it applies in supabase_migrations.schema_migrations

change class: standard (touches `.github/workflows/RUN-MIGRATION.yml` and `scripts/ci/**`)
scope: `.github/workflows/RUN-MIGRATION.yml`, `scripts/ci/apply-sql-via-management-api.sh` (or a new small wrapper `scripts/ci/record-migration-row.sh`), one new test `scripts/ci/sql-tests/run-record-migration-row-test.sh` and the workflow that runs it (`.github/workflows/SQL-RECORD-MIGRATION-ROW.yml`, same shape as `SQL-MEMORY-SENSITIVITY.yml`), and one line in `DATABASE_SCHEMA.md` documenting the write path. No migration, no gateway code, no deploy.

<!-- plan:begin -->

## Problem (evidence, read-only, 2026-10-12, origin/main 5f0220d0c)

1. **RUN-MIGRATION never writes a row.** `.github/workflows/RUN-MIGRATION.yml` runs
   `scripts/ci/apply-sql-via-management-api.sh --file "$MIGRATION_FILE"`, which POSTs the
   raw file text to `https://api.supabase.com/v1/projects/<ref>/database/query`, checks for
   HTTP 2xx and no `error`/`message` key, and stops there. Neither file contains
   `schema_migrations`. The workflow is the active path: GitHub API shows 15 successful
   RUN-MIGRATION runs between 2026-10-10 14:19 and 2026-10-12 22:06 UTC (one failure,
   38090434039).
2. **Live table.** `supabase_migrations.schema_migrations` has 452 rows; newest is
   `20261004075058 | vtid_04872_jev_member_quota | exafyltd@gmail.com`. Columns: `version text PK`,
   `statements text[]`, `name text`, `created_by text`, `idempotency_key text UNIQUE`,
   `rollback text[]`. Owner `postgres`, `relacl` NULL (owner-only). Read-only check, 2026-10-12:
   `SELECT has_table_privilege('postgres','supabase_migrations.schema_migrations','INSERT'), current_user`
   → `true | postgres`. That query went through the Supabase MCP `execute_sql`, which
   runs as `postgres` like the Management API `database/query` endpoint the script calls.
   So the writer can INSERT without a new GRANT.
3. **Later migrations are live but unrecorded.** Verified by effect, not by row:
   `20261010164100_vtid_05041` (write_fact ACL = `{postgres, service_role, migrate}`, no
   `authenticated`), `20261010180000_vtid_05043` (`membership_side_effects_suppressed()` exists,
   `tenants.open_signup` exists), `20261011090000_vtid_05067` (`operator_media` exists),
   `20261012180000_vtid_05095` (`phone_verification_challenges` exists). No row whose name
   matches 05041/05043/05095. 45 repo files have a filename ≥ `20261004075058`.
4. **Correction to the FU7 premise — the table was never authoritative.** It did not
   "stop" on 2026-10-04; it never tracked repo files. Its rows are written only by
   `mcp__Supabase__apply_migration` / the dashboard, which stamp the **apply time** as the
   version: e.g. repo `20261004100000_vtid_04872_jev_member_quota.sql` ↔ row
   `20261004075058`, repo `20260923120000_vtid_04341_write_fact_skip_same_value.sql` ↔ row
   `20260923112327`. The 2026-10-04 cut-off is when sessions stopped using MCP
   `apply_migration` and moved to RUN-MIGRATION. `.github/workflows/MIGRATION-DRIFT-CHECK.yml`
   and `scripts/ci/check-migration-drift.cjs` header (VTID-03486) record this explicitly:
   377 file versions vs 330 rows overlapped by **2** on 2026-08-04.
5. **Nothing reads the table today.** `MIGRATION-DRIFT-CHECK` checks declared tables vs
   live tables via `ci_schema_inventory` RPC, deliberately not schema_migrations.
   `scripts/ci/scanners/rls-policy.mjs` only skips the name. The `migration-backlog`
   routine that diffed against it is being retired by
   `20261012190000_vtid_05098_retire_duplicate_routines.sql` ("always breaches").
   `services/gateway/src/services/orb-tools/database-migrations-tools.ts` reads workflow
   runs, not the table (its header says "no migration-tracking table read back anywhere").
   `platform-operations.ts` AP-1005 verifies table existence. So the fix changes no
   consumer's behaviour; its value is an audit trail ("which repo file was applied, when")
   for humans, `get_why`, and the Aurora cutover inventory.
6. **Two traps for a naive fix.**
   - **Duplicate version prefixes:** 75 prefixes are shared by ≥2 files (since the gap:
     `20261005100000` ×2, `20261005130000` ×2, `20261010160000` ×3). `version` is the PK, so
     "version = prefix, ON CONFLICT DO NOTHING" would silently drop the 2nd/3rd file.
   - **Non-standard names:** some files have 8-digit prefixes
     (`20260209_vtid_01228_daily_co_live_rooms.sql`, `..._down.sql`, `..._fixed.sql`) and
     the workflow input accepts any path (e.g. `supabase/migrations/data-fixups/…`).
   - **Own transactions:** 11 of the October files start with `BEGIN;` and end with
     `COMMIT;`, so "same transaction" cannot mean wrapping them again (the script's own
     `--single-transaction` comment explains why double-wrapping breaks atomicity).

## Fix

Record one row per successful RUN-MIGRATION apply, in the **same Management API request**
as the migration, appended after the file text:

```sql
-- appended by apply-sql-via-management-api.sh --record-migration (always on a new line)
;
DO $record$
BEGIN
  INSERT INTO supabase_migrations.schema_migrations (version, name, created_by, idempotency_key)
  VALUES ('<version>', '<name>', 'github-actions:RUN-MIGRATION:<run_id>', '<filename>')
  ON CONFLICT (idempotency_key) DO NOTHING;
EXCEPTION WHEN unique_violation THEN
  -- version PK taken by another file between the pre-check and now: never fail an applied migration
  RAISE WARNING 'schema_migrations: version % already held by another file; not recorded', '<version>';
END
$record$;
```

**Pre-check (read-only, before the migration is sent):** the script first sends
`SELECT idempotency_key, name FROM supabase_migrations.schema_migrations WHERE version = '<version>'`
through the same API.
- No row → append the recording block.
- A row with `idempotency_key = '<filename>'` → this file is already recorded (re-run).
  Append the block anyway; `ON CONFLICT (idempotency_key)` makes it a no-op.
- A row with a different or NULL `idempotency_key` → another file, or an MCP/dashboard
  row, holds the version. **Omit the block** and print
  `::warning::version <v> already recorded as <name>; <filename> applied but not recorded`.
- The pre-check request itself fails (non-2xx or error payload) → exit 1 **before**
  anything is applied. Nothing has run, so failing is safe.

The `DO … EXCEPTION WHEN unique_violation` wrapper covers the only remaining race (another
run inserts the same version between pre-check and apply). It turns that case into a
warning instead of a red step for a migration that did apply.

**Exit codes (`apply-sql-via-management-api.sh --file … --record-migration`):**
- `0`: the migration applied. The row was recorded, or recording was skipped with a
  `::warning::` (version collision, path not under `supabase/migrations/`, basename or
  `RUN_ID` failed validation, or the post-verify read failed).
- `1`: the pre-check request failed (nothing applied), or the migration request returned
  non-2xx or an error payload (existing logic, script L113-133). This includes a partial
  apply; see the edge case below.
- `2`: usage error (existing, script L55 and L61).

**Accepted edge case — partial apply.** Consider a file shaped
`BEGIN; <DDL>; COMMIT; <statement that errors>`. The DDL commits, Postgres aborts the rest
of the string, and the recording block never runs. The script exits 1:
- `set -euo pipefail` is at script L43 (and workflow L44).
- The curl status check is at L113-124 (`HTTP != 200/201` → exit 1).
- The error-payload check is at L130-133.

The result is committed DDL with no row and a **red** step. That matches today's behaviour
(no row is ever written), and the red run tells the operator. It is not fixed here.

- **Why the same request gives "only on success":** the Management API runs the body as one
  simple-query string; Postgres aborts the rest of a multi-statement string on the first
  error. A file without its own BEGIN runs in one implicit transaction together with the
  INSERT (true same-transaction). A file with its own `BEGIN … COMMIT` commits first and the
  INSERT runs right after, only if the COMMIT succeeded. Either way: a failed migration never
  gets a row, and a row never exists for SQL that did not run. The text is appended after a
  `\n;\n` so a trailing `--` comment or a missing final `;` in the file cannot swallow it.
- **Values:** `idempotency_key` = the basename (e.g.
  `20261010164100_vtid_05041_definer_functions_lockdown.sql`), which is unique per file and
  is its real identity. `version` = the file's leading run of digits (14 or 8), `name` =
  the rest of the basename without `.sql`. The explicit `ON CONFLICT (idempotency_key)`
  target makes a re-run of the same file a no-op. A `version` collision with another file
  is handled by the pre-check and the `unique_violation` guard above, never by an untargeted
  `ON CONFLICT` that could hide it.
- **Duplicate prefixes:** handled by the pre-check (warning, step green). After applying,
  the step runs a read-only `SELECT … WHERE idempotency_key = '<filename>'`. If there is no
  row it prints `::warning::` naming the colliding row. It does not fail the run: the
  migration did apply, and a red run would push people to re-run a migration that
  succeeded. Owner decision 1 offers the alternative.
- **Scope guard:** record only when `MIGRATION_FILE` matches `^supabase/migrations/[^/]+\.sql$`.
  `data-fixups/`, rollback files under `docs/validation/**`, and inline `--sql` calls (the
  `NOTIFY pgrst` step, `VTID-02409-BOOTSTRAP.yml`) never write rows.
- **Quoting:** values are built from the basename only after it matches
  `^[0-9]{8,14}_[A-Za-z0-9_.-]+\.sql$`, followed by an explicit assertion that the basename
  contains no `'`. That assertion is redundant with the regex on purpose, so it survives a
  later regex edit. `RUN_ID` must match `^[0-9]+$`. If any check fails → no recording block
  + `::warning::`, and the migration still applies. No unchecked text goes into SQL. `statements`/`rollback` stay NULL (the file text is in git at the
  commit the run checked out; the run id in `created_by` pins it).
- **Implementation shape:** a `--record-migration` flag on
  `apply-sql-via-management-api.sh` (default off, so `VTID-02409-BOOTSTRAP.yml` and every
  other caller are unchanged), passed only by RUN-MIGRATION's "Apply migration" step, plus
  `RUN_ID=${{ github.run_id }}` in its env. The pre-check and post-verify `SELECT`s are
  extra Management API requests made by the same script run.
- **Documentation:** one line under a `supabase_migrations.schema_migrations` entry in
  `DATABASE_SCHEMA.md`. It says that since this change RUN-MIGRATION writes one row per
  applied repo file (`idempotency_key` = filename, `created_by` = `github-actions:RUN-MIGRATION:<run_id>`),
  that older rows carry MCP apply-time versions, and that the table is an audit trail, not
  the authority (MIGRATION-DRIFT-CHECK is).

Optional, separate PR, **owner decision 2**: a one-off backfill of rows for files applied
since 2026-10-04, only where the effect is verifiable read-only. Proposed conservative list
(each verified 2026-10-12 by object existence/ACL, not by row):
`20261010164100_vtid_05041`, `20261010180000_vtid_05043`, `20261011090000_vtid_05067`,
`20261012180000_vtid_05095`. Everything else stays unrecorded until someone verifies its
effect; the backfill file carries a per-file `-- verified: <query>` line and its own
self-check that RAISEs if the verifying object is missing. Recommendation: **skip the
backfill** — no consumer reads the table, and a partial backfill invites the reading that
"no row = not applied", which is false for ~600 historical files.

## Tests

1. `scripts/ci/sql-tests/run-record-migration-row-test.sh` on a `postgres:16` service
   container (pattern: `SQL-MEMORY-SENSITIVITY.yml`). It runs the **real** script, with a
   fake `curl` placed first on `PATH`. The fake reads the JSON payload, runs `.query` against
   the local database with `psql -c "<query>"`, and writes a 200 response with rows, or a
   200 response with `{"message": …}` if psql fails. That exercises the script's own exit-code
   logic (L113-133). The test creates a local `supabase_migrations.schema_migrations` with
   the live columns and constraints.
   **Commented assumption in the test (F3):** `psql -c` sends the string over the
   simple-query protocol. There a multi-statement string without explicit BEGIN runs as
   one implicit transaction, and the first error aborts the rest. The test assumes the
   Management API `database/query` endpoint behaves the same way; that is the property
   "no row without a successful migration" depends on. If Supabase changes it, this
   comment says what to re-verify.
   Cases (each asserts row count, DDL state and script exit code):
   - plain file (no BEGIN) succeeds → exactly one row with the right version/name/key, exit 0;
   - file with its own `BEGIN … COMMIT` succeeds → one row, exit 0;
   - file that RAISEs, both inside its own BEGIN and without one → zero rows, DDL rolled back, exit 1;
   - **partial apply** `BEGIN; CREATE TABLE t; COMMIT; SELECT 1/0;` → zero rows, `t`
     **exists**, exit 1 (pins the accepted edge case);
   - same file twice → still one row, exit 0 both times;
   - two files sharing a prefix → first recorded; second applied, no row, `::warning::`, exit 0;
   - version already held by a row with NULL `idempotency_key` (MCP-style) → applied, not
     recorded, warning, exit 0;
   - race guard: pre-insert a row for the version between pre-check and apply (the fake
     curl's hook) → applied, `unique_violation` caught, exit 0;
   - pre-check request fails → exit 1 and the migration's DDL is **absent**;
   - file whose last line is a `-- comment` without a newline → row still written;
   - a path under `data-fixups/`, an odd basename, a basename containing `'`, and
     `RUN_ID=abc` → no recording block, warning, migration applied, exit 0.
2. `bash -n` on both scripts; the existing gateway Jest test
   `test/orb-tools/database-migrations-tools.test.ts` stays green (dispatch input unchanged).
3. No staging suite: this deploys nothing (no Gate 2). First real proof is the next
   RUN-MIGRATION run, checked read-only with
   `SELECT * FROM supabase_migrations.schema_migrations WHERE idempotency_key = '<file>'`.

## Rollout

1. PR with the script flag, workflow change and SQL test; CI green; merge.
2. No dispatch of its own. The next migration someone applies through RUN-MIGRATION is the
   first live exercise; the session that merged checks the row read-only.
3. If owner decision 2 = backfill: a separate PR with a reviewed backfill file, applied via
   RUN-MIGRATION (a production write — covered only if the owner approves it at Gate 1).

## Risks

- Appending an INSERT to a migration payload: if the Management API ever changed to run
  statements independently (not abort-on-error), a failed migration could get a row. Mitigated
  by the test pinning the abort-on-error semantics locally and by the post-step verify; the
  script already treats an error payload as failure, and recording happens in the same
  request, so a red run still means "check the row". Alternative (separate request after
  success) is listed in owner decision 1.
- A file containing `COMMIT;` mid-file followed by a failing statement: partial apply with
  no row and a red step. This is the accepted edge case above, identical to today, and
  pinned by a test.
- An extra read-only request before every migration: if it fails, the migration does not
  run (exit 1). The operator re-dispatches. That is safe because nothing was applied.
- `created_by` changes from a personal email to `github-actions:…`: intentional, harmless.
- Writes to `supabase_migrations` from CI are new. The Management API token already has full
  DDL rights, so this adds no privilege.

## Out of scope

- Making the table authoritative or reconciling the ~600 historical files (the drift check
  is the authority by design, VTID-03486).
- Renaming duplicate-prefix files or adding a lint against new duplicates (could be a later
  light change; noted).
- `mcp__Supabase__apply_migration` behaviour (apply-time versions) — platform-side.
- Aurora's own migration bookkeeping after cutover.

## Owner decisions

1. Duplicate-prefix collision: **warn and continue** (recommended) vs fail the job.
   Alternative recording mode: separate request after success instead of appending to the
   migration request (looser coupling, but a crash between the two leaves an applied,
   unrecorded migration — today's state).
2. Backfill: **none** (recommended) vs the four effect-verified files listed above.

<!-- plan:end -->

## Planner responses — round 1

- **F1 [minor] — ACCEPTED.** The INSERT now uses `ON CONFLICT (idempotency_key) DO NOTHING`
  with an explicit target. A `version` primary-key collision with a different file is
  handled as in Q2: a read-only pre-check omits the INSERT, and a `DO … EXCEPTION WHEN
  unique_violation` wrapper turns the remaining race into a warning.
- **F2 [major] — ACCEPTED.** Added "Accepted edge case — partial apply": a file shaped
  `BEGIN; DDL; COMMIT; <error>` leaves committed DDL and no row, and the step goes red.
  That is identical to today (nothing is ever recorded), and the red run shows the operator.
  Error handling, with line numbers:
  - `scripts/ci/apply-sql-via-management-api.sh` L43 `set -euo pipefail`
    (`RUN-MIGRATION.yml` L44 too);
  - L113 `curl -sS`, then L121-124 `HTTP != 200/201` → exit 1;
  - L130-133 error/message payload → exit 1.
  New test case: zero rows, table exists, script exits 1.
- **F3 [minor] — ACCEPTED.** The test carries a comment stating the simple-query-protocol
  assumption (implicit single transaction, abort on first error) and what to re-verify if
  the Management API changes. The test now drives the real script through a fake `curl`
  backed by `psql -c`, instead of a dry-run mode.
- **F4 — acknowledged.** No change.
- **F5 [minor] — ACCEPTED.** After the basename regex, an explicit check asserts there is no
  `'`. A test case covers a basename containing a quote.
- **F6 [minor] — ACCEPTED.** `RUN_ID` must match `^[0-9]+$`. Otherwise the recording block is
  dropped with a warning and the migration still applies. A test case covers `RUN_ID=abc`.
- **F7 [minor] — ACCEPTED.** One line in `DATABASE_SCHEMA.md` documents the write path and
  that the table is an audit trail. The file is added to scope.
- **Q2 — ACCEPTED as proposed, plus one guard.** Before the payload is built, the script
  runs a read-only `SELECT idempotency_key, name … WHERE version = '<v>'` through the same API.
  - A different or NULL key (another file, or an MCP/dashboard row) → INSERT omitted,
    `::warning::`, step green.
  - The pre-check request fails → exit 1 before anything is applied.
  - The extra `unique_violation` guard covers the pre-check-to-apply race, so an applied
    migration never ends in a red step because of bookkeeping.
  - Exit codes are stated explicitly: 0 applied (recorded, or skipped with a warning);
    1 pre-check failed (nothing applied), or the migration failed or partially applied;
    2 usage error (L55, L61).
- **Q3 — CONFIRMED read-only.**
  `SELECT has_table_privilege('postgres','supabase_migrations.schema_migrations','INSERT'), current_user`
  ran 2026-10-12 on `inmkhvwdcuyhnxkgfvsb` through the Supabase MCP `execute_sql` and
  returned `true | postgres`. The table is owned by `postgres` and `relacl` is NULL. Cited
  in Problem §2.

## Owner approval (Gate 1)
Approved by owner in Claude Code session https://claude.ai/code/session_01TMPMNGNEtPxKwmVqyfdx46 on 2026-10-12 ("Yes"), including the recommended option for every owner decision and the production steps named in the plan. Verdict: CONVERGED (2 rounds).

## Final plan hash

d27c82d75e29868e985cee6150a7075797f8cc6574ec866d0b8195486f0fb2b5

Owner approval (Gate 1): "Yes" — 2026-10-12, Claude Code session; plan hash d27c82d75e29868e985cee6150a7075797f8cc6574ec866d0b8195486f0fb2b5; sparring record 905b0511-9df4-4034-88e6-a574f9de5032.

## Sparring partner findings (verbatim, round 1 then round 2)

Good -- the ROLLBACK mentions in migration files are all comments (documentation), not actual `ROLLBACK;` statements being executed. The 3 files found all use `ROLLBACK` in comment blocks. This means the concern I had about a deliberate ROLLBACK followed by the INSERT still running is not a real-world issue.

Now I have enough evidence to produce my round 1 assessment.

## Verified premises

- **"Neither file contains `schema_migrations`"** (RUN-MIGRATION.yml + apply-sql-via-management-api.sh) → TRUE -- Confirmed by reading both files in full: `/home/user/vitana-platform/.github/workflows/RUN-MIGRATION.yml` and `/home/user/vitana-platform/scripts/ci/apply-sql-via-management-api.sh`. Neither mentions `schema_migrations`.

- **"database-migrations-tools.ts reads workflow runs, not the table"** → TRUE -- `/home/user/vitana-platform/services/gateway/src/services/orb-tools/database-migrations-tools.ts:16-17`: `"no migration-tracking table read back anywhere"` and no grep hit for `schema_migrations` in that file.

- **"MIGRATION-DRIFT-CHECK checks declared tables vs live tables via ci_schema_inventory RPC, deliberately not schema_migrations"** → TRUE -- `/home/user/vitana-platform/scripts/ci/check-migration-drift.cjs:9-15` explicitly documents why the `schema_migrations` approach "does not work on this project" (377 file versions vs 330 rows, overlap of 2). The script checks object existence, not version rows.

- **"`data-fixups/` path exists"** → TRUE -- Glob found 11 files under `supabase/migrations/data-fixups/`.

- **"AP-1005 verifies table existence"** → TRUE -- `/home/user/vitana-platform/services/gateway/src/services/automation-handlers/platform-operations.ts:139-168`.

## Findings

F1 [major] `ON CONFLICT DO NOTHING` without a target silently loses the record when a file collides on `idempotency_key` (not just `version`).

Evidence: The plan says `ON CONFLICT DO NOTHING` (no target) covers both the `version` PK and the `idempotency_key` UNIQUE key. This is correct PostgreSQL behavior. However, the plan only discusses the version-collision case (two files sharing a prefix). It never addresses the case where `idempotency_key` (the full basename) collides -- which means a re-run of the exact same file is silently a no-op. The plan does mention this at line 82 ("a re-run of the same file is a no-op") which is the intended behavior. On closer reading, this is actually well-handled. **Downgrading to minor on reflection** -- the re-run case is correct (idempotent), and two different files cannot share a basename. No real gap here.

F1 [minor] (revised) The `ON CONFLICT DO NOTHING` design is correct but the plan text at line 80 conflates two things: "ON CONFLICT DO NOTHING (no target) covers both" -- while technically true, explicitly specifying `ON CONFLICT (idempotency_key) DO NOTHING` would be clearer and would fail fast if the constraint is ever renamed, rather than silently inserting a duplicate `version` (which would fail on the PK separately). Not a bug, but a defensive-coding miss.

Evidence: Plan line 80; PostgreSQL semantics.

Suggestion: Use `ON CONFLICT (idempotency_key) DO NOTHING` as the explicit target. A version-PK collision from a different file then produces a clear PK-violation error rather than a silent skip, which is actually better signal than the "warn and continue" path (you learn something went wrong).

F2 [major] A migration file containing `BEGIN; ... COMMIT;` followed by statements that error means the INSERT runs after an explicit COMMIT and the migration's committed work is non-recoverable, but the recording INSERT itself runs outside any explicit transaction.

Evidence: Plan lines 73-76 state: "A file with its own `BEGIN ... COMMIT` commits first and the INSERT runs right after, only if the COMMIT succeeded." This is correct for the success path. But for the failure path: if the file is `BEGIN; <good DDL>; COMMIT; <bad SQL that errors>`, PostgreSQL in simple-query mode will (a) commit the DDL, (b) error on the bad SQL, (c) abort remaining statements including the INSERT. The migration partially applied but has no record. The plan's test case (line 121: "file with its own `BEGIN ... COMMIT` succeeds -> one row") only tests the happy path. The partial-success case is not tested and the plan's risk section (line 149) only mentions "COMMIT mid-file followed by more statements" as "unchanged behaviour," which is true but doesn't acknowledge that this is a regression from the current state of "no row ever" -- now "sometimes a row, sometimes not for the same structural pattern."

Suggestion: Add a test case: `BEGIN; CREATE TABLE t1(); COMMIT; SELECT 1/0;` -- this should result in zero rows (the INSERT is never reached) but `t1` exists. Document this explicitly as an accepted edge case. Consider whether the verify SELECT (line 84) already handles this, since it runs as a separate `--sql` call in the same workflow step -- if the previous curl returned non-zero, the step already failed and the verify never runs. Confirm the step's `set -euo pipefail` behavior in this scenario.

F3 [minor] The `--dry-run-payload` test mode does not prove the Management API's abort-on-error semantics, only local `psql`'s.

Evidence: Plan lines 115-117: "The script under test gets a `--dry-run-payload` mode (prints the final SQL instead of POSTing) so the test feeds that SQL to local `psql` as one simple-query string (`psql -c "$(...)"`), which matches the Management API's semantics)." The parenthetical "(which matches)" is an assumption. PostgreSQL's simple-query protocol does abort remaining statements on error, and `psql -c` uses the simple-query protocol, so the assumption is correct for PostgreSQL. The Supabase Management API also uses `PgBouncer` or connects directly; either way it should use simple query. This is a minor documentation/confidence concern, not a bug.

Suggestion: Add a comment in the test script noting the assumption and what would invalidate it (e.g., the Management API switching to extended query protocol or wrapping in savepoints).

F4 [minor] The scope guard regex (`^supabase/migrations/[^/]+\.sql$`) excludes 8-digit-prefix files that ARE direct children of `supabase/migrations/`.

Evidence: Plan line 88 says record "only when `MIGRATION_FILE` matches `^supabase/migrations/[^/]+\.sql$`" and line 51 acknowledges "some files have 8-digit prefixes." The scope guard passes 8-digit files through (they match the path pattern). But then plan line 92 says the basename must match `^[0-9]{8,14}_[A-Za-z0-9_.-]+\.sql$` for quoting -- so 8-digit files DO get through the scope guard but their version is extracted as an 8-digit number. The plan doesn't explicitly say whether `version` for an 8-digit prefix is the 8 digits or something else, but the regex `[0-9]{8,14}` covers 8 digits. This is actually fine. No real gap here.

Suggestion: None needed. The design handles this correctly.

F5 [major] The plan proposes appending raw SQL to a migration payload, constructing `VALUES` from a basename. While the basename regex is restrictive (`^[0-9]{8,14}_[A-Za-z0-9_.-]+\.sql$`), the `version` and `name` values are inserted as string literals (single-quoted in the SQL). If the regex ever drifts or is bypassed, this is a SQL injection vector. The plan says "No user text goes into SQL unchecked" but the defense is a regex, not parameterized queries.

Evidence: Plan lines 65-67 show the constructed SQL with `'<version>'` and `'<name>'` as interpolated values. Plan line 92 documents the regex guard. The Management API does not support parameterized queries (it takes raw SQL text), so parameterization is impossible in this context.

Suggestion: This is an inherent limitation of the Management API approach. The regex is the correct defense here. Add a belt-and-suspenders check: after regex validation, assert the extracted values contain no single-quote characters (which the regex already prevents, but an explicit check makes the security contract visible). **Downgrading to minor** since the regex `[A-Za-z0-9_.-]` genuinely cannot produce a single quote.

F5 [minor] (revised) The regex defense against SQL injection is correct. Belt-and-suspenders: assert no single-quote in the interpolated values.

F6 [minor] The plan's `created_by` value `'github-actions:RUN-MIGRATION:<run_id>'` introduces `github.run_id` into a SQL literal. Run IDs are numeric, but this should be explicitly validated.

Evidence: Plan line 98: `RUN_ID=${{ github.run_id }}` in env. `github.run_id` is always a positive integer in GitHub Actions, but the script should validate it matches `^[0-9]+$` before interpolation.

Suggestion: Add a numeric check on `RUN_ID` in the script.

F7 [minor] No CLAUDE.md rule is violated, but the plan does not mention updating `DATABASE_SCHEMA.md` (CLAUDE.md Always rule 24: "Always update `DATABASE_SCHEMA.md` when schema changes"). This plan does not change the schema -- it writes to an existing table -- so rule 24 does not technically apply. However, documenting that `schema_migrations` is now written to by RUN-MIGRATION could be useful.

Evidence: CLAUDE.md Always rule 24.

Suggestion: Optional -- add a note to `DATABASE_SCHEMA.md` documenting the new write path to `supabase_migrations.schema_migrations`.

## Questions for the planner

1. F2: Have you considered the case where a migration file has `BEGIN; <DDL>; COMMIT; <more statements that error>`? The DDL commits, the error aborts the remaining statements including the INSERT, and you get a partially-applied migration with no record. Is this an accepted edge case, and should the test suite pin it?

2. The plan's recommended owner decision 1 is "warn and continue" for duplicate-prefix collisions. Have you considered that the verify SELECT (plan line 84) runs as a separate `--sql` call -- if the appended INSERT was in the same curl request that succeeded (HTTP 200), the step continues to the verify SELECT. But if the INSERT was silently skipped (ON CONFLICT), the verify SELECT correctly reports "no row found." What happens to the step's exit code? Does the script exit 0 with only a `::warning`? The workflow's "Apply migration" step name suggests the caller expects success = migration applied. A warning-only exit could be surprising for automated consumers.

3. The plan says "No staging suite" (line 129). This is correct per CLAUDE.md (no deploy, no Gate 2). But the first real exercise is a production write to `supabase_migrations.schema_migrations`. Has anyone confirmed the Management API's `current_user` (`postgres`) has INSERT on that table? The plan says yes (line 20), but this was stated as evidence from a read-only check, not from an actual INSERT attempt.

## Verdict

NOT CONVERGED -- F2 is major (partial-apply + error = committed DDL with no record, and no test covers it). The plan should either add that test case and document the accepted behavior, or change the design to handle it. F1 and F5 were downgraded to minor on analysis. Everything else is minor or informational.
## Round 1 finding disposition

- **F1 [minor]** ON CONFLICT target → `closed`. Plan now uses `ON CONFLICT (idempotency_key) DO NOTHING` with an explicit target, plus a `EXCEPTION WHEN unique_violation` wrapper for the PK race. Both changes are exactly what was suggested.

- **F2 [major]** partial-apply edge case → `closed`. Plan adds an explicit "Accepted edge case -- partial apply" section (lines 106-114), documents why the step goes red (with line-number citations to `set -euo pipefail` and the error checks), and adds a test case that pins the behavior: `BEGIN; CREATE TABLE t; COMMIT; SELECT 1/0;` produces zero rows, table exists, exit 1.

- **F3 [minor]** test assumption about simple-query protocol → `closed`. Plan now has a commented assumption in the test (lines 174-179) documenting the dependency and what to re-verify. The test also changed from `--dry-run-payload` mode to a fake-curl approach that exercises the real script, which is a strict improvement.

- **F4 [minor]** 8-digit prefix handling → `closed` (acknowledged, no change needed).

- **F5 [minor]** SQL injection defense → `closed`. Plan adds an explicit no-single-quote assertion after the regex (line 139-140), explicitly noted as redundant-on-purpose, plus a test case covering a basename containing `'` (line 194).

- **F6 [minor]** RUN_ID validation → `closed`. Plan adds `^[0-9]+$` check (line 141), with a test case for `RUN_ID=abc` (line 195).

- **F7 [minor]** DATABASE_SCHEMA.md → `closed`. Plan adds the documentation line and adds the file to scope (line 4, lines 149-153).

- **Q2** (duplicate-prefix exit code / pre-check) → `closed`. The pre-check design (lines 81-91) is thorough: read-only SELECT before apply, three-way branch (no row / same file / different file), and the `unique_violation` exception handler covers the pre-check-to-apply race. Exit codes are stated explicitly (lines 97-104).

- **Q3** (INSERT privilege) → `closed`. Evidence cited in Problem section 2 (lines 20-24), confirmed via `has_table_privilege` and `current_user` check.

## Findings

No new blocker or major findings. The revision addressed every round 1 finding, and the new mechanisms (pre-check SELECT, `DO ... EXCEPTION WHEN unique_violation` wrapper, fake-curl test harness, explicit quote assertion) are all well-designed and internally consistent.

## Verified premises (round 2 -- new claims only)

- **"The pre-check and `unique_violation` handler cover the race"** (lines 81-95) → TRUE by construction. The pre-check omits the INSERT when a collision is detected ahead of time; the `EXCEPTION WHEN unique_violation` handler in the `DO` block catches the remaining window between pre-check and apply. Both paths produce a warning and exit 0, so an applied migration never fails due to bookkeeping.

- **"`set -euo pipefail` is at script L43"** (line 109) → TRUE -- `/home/user/vitana-platform/scripts/ci/apply-sql-via-management-api.sh:43`.

- **"L121-124 `HTTP != 200/201` exit 1"** (line 110) → TRUE -- `/home/user/vitana-platform/scripts/ci/apply-sql-via-management-api.sh:121-124`.

## Questions for the planner

None.

## Verdict

CONVERGED -- all round 1 findings are closed. No new blocker or major. The plan is well-structured: it correctly handles the happy path (recording), the idempotent re-run, the duplicate-prefix collision, the partial-apply edge case, and the pre-check-to-apply race. The test suite covers all of these, plus input validation (quote in basename, non-numeric RUN_ID, non-standard paths). The scope is appropriately narrow (workflow + script + test, no gateway code, no deploy).
