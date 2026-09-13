# VTID-03835 — Operator Console: codebase read access (dev_search_codebase, dev_read_file)

Companion work in the same PR, own VTIDs, own acceptance criteria below:
**VTID-03836** (dev_aws_ecs_status, read-only ECS status — shipped OFF
everywhere pending a dedicated IAM role) and **VTID-03837** (dev_db_query,
allowlisted read-only Supabase access).

## Report

Brief: "wire the Operator Console up for real vibe coding." Investigation
(this session, prior turns) found the Operator chat has zero tools that
read the live codebase, query AWS, or query the database directly — its
only code-touching capability is the async `autopilot_execute_task`
on-ramp (VTID-03820), which hands off a text plan and cannot see a diff.
This is why a screenshot showed the model answering a codebase question
with "I don't have a confirmed answer" — there was nothing that let it
look. The brief explicitly named "codebase read access" as the first,
highest-priority, lowest-risk item to wire up, read-only, staging-first.

## Acceptance Criteria

AC-1 — `dev_search_codebase(query, path_glob?)` and `dev_read_file(path,
ref?)` tools are declared in `GEMINI_TOOL_DEFINITIONS.functionDeclarations`
and are automatically role-gated to developer/admin via the existing
`dev_`-prefix mechanism in `executeTool()` (VTID-DEV-ASSIST) — no new
role-filtering logic needed.

TEST: `outputs/jest-operator-read-tools.txt` —
`test/vtid-03835-operator-console-read-tools.test.ts` "role gating"
block asserts both tools are blocked for a non-developer thread identity.

AC-2 — Both tools are read-only: they call the GitHub Search Code API and
Contents API respectively via new exported functions in
`github-service.ts` (`searchCode`, `getFileContents`), reusing the
existing `GITHUB_SAFE_MERGE_TOKEN` — no new credential provisioned, no
write endpoint (`PUT`/`PATCH`/`DELETE`) ever called.

TEST: `outputs/jest-operator-read-tools.txt` —
`test/vtid-03835-github-service-read-access.test.ts` asserts both
functions issue only `GET`-shaped requests (the mock records the URL,
never a write) and correctly decode/URL-encode their inputs.

AC-3 — `dev_read_file` defaults `ref` to `main` (there is no live checkout
on the gateway container to read from — CLAUDE.md's own framing), and
returns a directory listing (not an error) when the path is a directory.

TEST: `outputs/jest-operator-read-tools.txt` — "defaults ref to main when
omitted" and (github-service suite) "returns a directory listing when the
path is a directory".

AC-4 — Both tools are gated behind a dedicated kill switch
(`OPERATOR_CODEBASE_READ_ENABLED`), defaulting OFF, matching the
established `OPERATOR_EXECUTION_ONRAMP_ENABLED` pattern (VTID-03820) —
never silently on.

TEST: `outputs/jest-operator-read-tools.txt` — "rejects when the kill
switch is not \"true\" (default OFF)" for both tools.

AC-5 — The kill switch is pinned to `"true"` on
`AWS-STAGE-DEPLOY-GATEWAY.yml` only (staging), never on
`AWS-PROD-DEPLOY-GATEWAY.yml`, matching the staging-first rollout CLAUDE.md
requires for every new Operator capability.

TEST: `commands.log` — diff of `AWS-STAGE-DEPLOY-GATEWAY.yml` shows
`OPERATOR_CODEBASE_READ_ENABLED` added to both the env filter-out list and
the re-add list with `value:"true"`; `git diff --stat` confirms
`AWS-PROD-DEPLOY-GATEWAY.yml` is untouched by this PR.

AC-6 — GitHub API failures (rate limit, 404, oversized file) surface as a
normal `{ok:false, error}` tool result, never an unhandled throw that
would crash the operator chat turn.

TEST: `outputs/jest-operator-read-tools.txt` — "surfaces a GitHub API
failure as a tool error, not a throw" / "surfaces a file-too-large error
as a tool error".

AC-7 — `tsc --noEmit` is clean and the full targeted regression slice
(existing operator/onramp/dedup suites) still passes unmodified.

TEST: `outputs/tsc-noemit.txt` (exit 0, no output); `outputs/jest-operator-read-tools.txt`
— 5 suites / 53 passed, 2 pre-existing skipped, 0 failures.

---

# VTID-03836 — Operator Console: read-only AWS ECS status (dev_aws_ecs_status)

## Report

Same brief. "AWS — read-only status/logs, scoped IAM, before anything
else" — explicitly: never reuse or widen a role that already has
`ecs:RunTask`/deploy permissions (the gateway's existing
`aws-ecs-admin.ts` client does, via `dispatchExecutorJobAws()`).

## Acceptance Criteria

AC-1 — A new, separate module (`aws-ecs-readonly.ts`) with its own cached
`ECSClient`, never importing or reusing `aws-ecs-admin.ts`'s client —
`DescribeServicesCommand` only, never `RunTask`/`UpdateService`/
`RegisterTaskDefinition`.

TEST: `commands.log` — `grep -n "RunTask\|UpdateService\|RegisterTaskDefinition"
src/services/aws-ecs-readonly.ts` returns no matches; the file imports only
`DescribeServicesCommand`.

AC-2 — Only the documented CLAUDE.md §1b service names are queryable; an
undocumented/unknown service name is refused before any AWS call is made.

TEST: `outputs/jest-operator-read-tools.txt` — `dev_aws_ecs_status`
"reports not-found when AWS returns no matching service" plus the
`describeEcsServices` allowlist check (module-level, exercised implicitly
via the mocked handler tests; the allowlist itself is a pure function
listed as `ALLOWED_ECS_SERVICES`).

AC-3 — The tool is kill-switched off by default AND is **not pinned to
"true" anywhere** (staging included) in this PR, because no dedicated
read-only IAM role exists yet — enabling it today would run under the
same broad gateway task role `aws-ecs-admin.ts` uses, which is exactly the
credential-widening the brief forbids.

TEST: `commands.log` — `grep -n OPERATOR_AWS_READONLY_ENABLED
.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml
.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml` returns no matches in
either file (confirms it is not pinned anywhere by this PR).

AC-4 — Read-only status shape (desired/running/pending counts, task
definition, rollout state) is returned; no mutation call is ever made.

TEST: `outputs/jest-operator-read-tools.txt` — `dev_aws_ecs_status`
"returns the described service status".

**Known limitation, explicit, not silently deferred:** the IAM gap in
AC-3 means this tool is shipped as dead code until a dedicated read-only
role is provisioned (outside this session's reach — no AWS console/CLI
IAM access). See `aws-ecs-readonly.ts`'s header comment.

---

# VTID-03837 — Operator Console: read-only DB access (dev_db_query)

## Report

Same brief. "Database — read-only, RLS-respecting, scoped... never a raw
arbitrary-SQL tool."

## Acceptance Criteria

AC-1 — `dev_db_query(table, vtid?, limit?)` only ever reads from an
explicit, hardcoded table allowlist (`vtid_ledger`, `oasis_events`,
`dev_autopilot_executions`, `dev_autopilot_plan_versions`) via Supabase
PostgREST — no arbitrary SQL, no table name interpolation from an
unchecked value.

TEST: `outputs/jest-operator-read-tools.txt` — "rejects a table not on the
allowlist without ever calling Supabase".

AC-2 — Reuses the existing `SUPABASE_SERVICE_ROLE` read pattern already
used elsewhere in this exact file (`executeDevDeploymentStatus`,
`executeVerifyDeployChecklist`) — not a new or widened credential.

TEST: `commands.log` — side-by-side grep of `SUPABASE_SERVICE_ROLE` usage
in `executeDevDbQuery` vs. the pre-existing `executeDevDeploymentStatus`.

AC-3 — A `vtid` filter is only applied on tables that actually have a
`vtid` column (`vtid_ledger`, `oasis_events`); on
`dev_autopilot_executions`/`dev_autopilot_plan_versions` (which key on
`finding_id`/`self_healing_vtid` instead, confirmed by reading
`supabase/migrations/20260416100000_dev_autopilot.sql`) the tool refuses
the filter with a clear error rather than sending PostgREST a query that
would 400 on a nonexistent column.

TEST: `outputs/jest-operator-read-tools.txt` — "filters by vtid on
vtid_ledger" and "refuses a vtid filter on a table with no vtid column".

AC-4 — `limit` is capped at 100 regardless of what the model requests.

TEST: `outputs/jest-operator-read-tools.txt` — "queries the allowlisted
table with a capped limit" (requests 500, asserts `limit=100` on the wire).

AC-5 — Kill-switched off by default (`OPERATOR_DB_READONLY_ENABLED`),
pinned to `"true"` on staging only (same AC-5 pattern as VTID-03835 —
read access reusing an existing, already-scoped credential is safe to
enable on staging now, unlike VTID-03836's AWS gap).

TEST: `outputs/jest-operator-read-tools.txt` — "rejects when the kill
switch is not \"true\" (default OFF)"; `commands.log` — diff shows
`OPERATOR_DB_READONLY_ENABLED` pinned on staging only.
