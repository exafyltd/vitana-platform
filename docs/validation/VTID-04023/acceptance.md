# VTID-04023 — W5b: `dev_run_sql_readonly` — bounded read-only SQL over a dedicated connection for the Operator Console (gap analysis §4.4 / §4.5)

Context: `docs/OPERATOR-AGENT-BUILD-PLAN.md` W5b — "read-only SQL over the Aurora reader instead of the 4-table PostgREST allowlist". `dev_db_query` (VTID-03837) reads four allowlisted tables newest-first with an optional vtid filter; it cannot join, aggregate, or touch any other table, so "how many executions failed per stage this week" — a one-liner for a Claude Code session — was unanswerable from the console.

What ships: `services/gateway/src/services/operator-sql-readonly.ts` and the `dev_run_sql_readonly` tool (wire schema, executor, dispatch in `gemini-operator.ts`; developer/admin via the `dev_*` role gate). Five independent layers: (1) kill switch `OPERATOR_SQL_READONLY_ENABLED=true`; (2) its own connection `OPERATOR_SQL_READONLY_DATABASE_URL` — never a silent reuse of `AURORA_DATABASE_URL` (the `vitana_admin` superuser) or `AURORA_RLS_DATABASE_URL` (the RLS diagnostic's `authenticator`); unset → `not_configured`, honestly; (3) statement validation — comments stripped, exactly one statement, SELECT / WITH … SELECT / plain EXPLAIN only, no data-modifying CTE, no locking clause, no `pg_sleep`/`pg_read_file`/`pg_terminate_backend`/`set_config`/`dblink`/`lo_*`/`nextval`/SELECT INTO, ≤ 4000 chars; (4) `BEGIN READ ONLY` + `SET LOCAL statement_timeout`/`lock_timeout`/`idle_in_transaction_session_timeout`, always `ROLLBACK`, pool opened with `default_transaction_read_only=on`; (5) the SELECT wrapped in `SELECT * FROM (…) LIMIT n+1`, cells clipped to 400 chars, payload capped at 24 KB. Each execution is logged with the thread, a statement fingerprint, row count and duration. Ships inert — nothing pinned on any deploy workflow.

AC-1 — `validateReadonlySql` accepts SELECT, WITH … SELECT and plain EXPLAIN (one trailing semicolon tolerated) and rejects every write/DDL/control shape, a second statement, EXPLAIN ANALYZE, data-modifying CTEs, a WITH with no SELECT, empty/comment-only/oversized input, and each forbidden server-side function or clause — with comments stripped first so nothing hides behind one.
TEST: services/gateway/test/vtid-04023-operator-sql-readonly.test.ts

AC-2 — Bounding: rows/timeout are clamped with defaults and caps; SELECT/WITH are wrapped in a LIMIT n+1 outer query while EXPLAIN is left alone; cells are clipped and dates/bigints/objects rendered; the n+1 row flags truncation; the total character budget stops the output; an empty result carries a note.
TEST: services/gateway/test/vtid-04023-operator-sql-readonly.test.ts

AC-3 — `runReadonlySql` issues exactly `BEGIN READ ONLY`, the three `SET LOCAL` timeouts, the bounded statement and `ROLLBACK`, releases the client, returns the fingerprint/duration/`read_only_transaction`; on a query failure it still rolls back, releases and rethrows the Postgres error verbatim; it validates before touching the pool and reports `not_configured` when the URL is unset.
TEST: services/gateway/test/vtid-04023-operator-sql-readonly.test.ts

AC-4 — Tool wiring: `dev_run_sql_readonly` is blocked for a non-developer role, kill-switched off by default, reports `not_configured` with the URL unset, requires `sql`, refuses a write without opening a connection, returns the bounded rows for a developer through the pooled connection (BEGIN READ ONLY first, ROLLBACK last, LIMIT n+1), and surfaces a Postgres failure verbatim.
TEST: services/gateway/test/vtid-04023-operator-sql-readonly.test.ts
TEST: services/gateway/test/vtid-03835-operator-console-read-tools.test.ts

OASIS_PROOF: no OASIS topic, payload or consumer change — the execution audit is the gateway log line (`[VTID-04023] dev_run_sql_readonly thread=… fp=… rows=… ms=…`), readable through `dev_cloudwatch_logs` (VTID-04020). Pinned by the read-tools suite above still passing unmodified.

Not verified here: a live statement. `OPERATOR_SQL_READONLY_DATABASE_URL` needs a read-only login role on the Aurora reader endpoint plus a Secrets Manager entry and task-def wiring — the owner's provisioning (declared in the deploy workflow, never hand-edited on the task def); this session has no VPC route to Aurora's Postgres port either. The first call on staging after that is the exercise; `not_configured` is the honest answer until then.
