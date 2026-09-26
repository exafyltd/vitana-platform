# VTID-04624 — the Operator Console's SQL tool reads the live database, read-only

Owner report 2026-09-26: asked "how many registered users do we have in
vitanaland", the console could not answer. `dev_run_sql_readonly` returned
`operator_sql_readonly_disabled`: its credential
(`vitana/gateway/staging/operator-sql-readonly-url`) was never provisioned.
It was also designed for the Aurora reader, which has had no replication
since the 2026-09-21 full load (DMS `vitana-supabase-to-aurora-v3` is
`failed`), so it would have answered from a 5-day-old copy. The owner chose
the live database, read-only, in session.

## Acceptance criteria

AC-1: with no dedicated URL and `OPERATOR_SQL_READONLY_BACKEND=supabase`, the tool posts the validated, LIMIT-bounded statement to `operator_readonly_query` with the service role and returns bounded rows; the dedicated URL still wins when present.
TEST: services/gateway/test/vtid-04624-operator-sql-live-db.test.ts

AC-2: a write, a second statement, or EXPLAIN never reaches the database; a database error is passed through verbatim.
TEST: services/gateway/test/vtid-04624-operator-sql-live-db.test.ts

AC-3: the function is SECURITY INVOKER, EXECUTE only for service_role, and switches the transaction to read-only before executing. Verified live: see outputs/live-guards.txt.
TEST: services/gateway/test/vtid-04624-operator-sql-live-db.test.ts

AC-4: staging enables the backend only when the URL secret is absent, the env strip list carries the new variable, prod declares nothing, and the run step stays under 20,000 characters.
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

AC-5: the original pool path is unchanged apart from the not_configured message.
TEST: services/gateway/test/vtid-04023-operator-sql-readonly.test.ts
