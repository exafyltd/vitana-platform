# VTID-05693 acceptance (strategy-execution-wave1/security-evidence, tasks.md T1-T2)

Change types: Tooling/docs. The lane adds one read-only SQL file, its node:test guard and one document. It never
connects to a database. Each AC maps to a check whose run and output are in `commands.log`.

AC-1 The test was written first and was red on base: on `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835` without the SQL
file, the two tests on the real file fail with ENOENT and the four checker self-tests pass.
TEST: node --test scripts/sql/readonly/strategy-memory-grants-check.test.mjs (red-on-base.txt: pass 4, fail 2, exit 1)

AC-2 The test fails if any statement starts with a keyword other than SELECT/WITH, or if INSERT, UPDATE, DELETE,
MERGE, CREATE, ALTER, DROP, GRANT, REVOKE, TRUNCATE, COPY, CALL, DO, SET, RESET, BEGIN, COMMIT, VACUUM, ANALYZE, LOCK,
COMMENT, SECURITY or EXECUTE starts a statement or sub-statement (comments stripped, strings blanked). It also refuses
SELECT INTO, row locks, side-effect functions, dollar-quoted bodies and psql meta-commands.
TEST: node --test scripts/sql/readonly/strategy-memory-grants-check.test.mjs (checker self-tests) and the mutation runs in commands.log

AC-3 The test fails if any of `write_fact`, `get_current_facts`, `recall_at_time_range`, `memory_facts_semantic_search`
or the roles `anon`, `authenticated`, `service_role`, `migrate` (or the nine tables and catalog terms) is missing.
TEST: node --test scripts/sql/readonly/strategy-memory-grants-check.test.mjs (mut3, mut4 in commands.log exit 1)

AC-4 The SQL is SELECT/WITH only and covers `has_function_privilege` for every overload of the four functions × the
four roles (missing roles guarded with `to_regrole`), `prosecdef`, `proacl`, PUBLIC EXECUTE, and `relrowsecurity`,
`relforcerowsecurity` and `pg_policies` rows for `memory_items`, `memory_facts`, `memory_diary_entries`,
`relationship_edges`, `vtid_ledger`, `oasis_events`, `user_tenants`, `tenants`, `app_users` (guarded with `to_regclass`).
TEST: node --test scripts/sql/readonly/strategy-memory-grants-check.test.mjs (6 pass, 0 fail)

AC-5 The document states what the SQL checks, who may run it (an authorised operator, read-only), names the existing
`docs/validation/VTID-05041/post-apply-checks.sql`, where to record output (`docs/validation/VTID-05693/live-output.md`,
added later), the current recorded evidence (runs 38059078694 and 38360259959, placeholders at
`docs/validation/VTID-05041/commands.log:36-37`), and that sensitive memory, tenant, permission and financial
implementation stays blocked until the output is recorded.
TEST: wording check in commands.log (each required item found in the doc)

AC-6 Every `file:line` citation in the document resolves at the pinned commit.
TEST: node docs/validation/VTID-05693/citation-check.mjs . docs/programs/strategy-execution/security-live-evidence.md (0 failures)

AC-7 Only the lane paths change; evidence files are valid (`validateScope`, Acceptance Mapping Gate); collab tests pass.
TEST: git status --porcelain --untracked-files=all; node --test scripts/collab/*.test.mjs; validateScope and checkAcceptanceMapping in commands.log
