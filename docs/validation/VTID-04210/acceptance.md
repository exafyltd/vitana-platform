# VTID-04210 — Acceptance

`GET /api/v1/operator/health` already existed as a plain liveness check
(`ok`, `service`, `timestamp`, `status`, `vtid`). It reported nothing about
which of the Operator Console's several optional, env-gated capabilities
were actually live — an operator had to check six separate env vars
(`OPERATOR_THREADS_ENABLED`, `OPERATOR_TURN_MEMORY_ENABLED`,
`OPERATOR_SQL_READONLY_ENABLED`, `OPERATOR_AWS_READONLY_ENABLED`,
`OPERATOR_BOOTSTRAP_PACK_ENABLED`, `OPERATOR_VTID_SELF_ALLOCATE_ENABLED`)
on the live ECS task definition to know.

## What already existed vs. what was added

The task asked for exactly `GET /api/v1/operator/health`, which already
exists for a different purpose. Rather than adding a colliding second
route or breaking existing consumers of the current shape, the existing
route was extended ADDITIVELY: every pre-existing field (`ok`, `service`,
`timestamp`, `status`, `vtid`) is unchanged, and a new `capabilities`
object was added alongside them. No test in this repo pinned the route's
exact response shape before this change (confirmed via a repo-wide grep
for `operator/health`/`'/health'`), so there was nothing to break.

Each capability reuses its OWN existing predicate function rather than a
duplicated copy of the env-var name/convention:
`isOperatorThreadsEnabled()` (`operator-threads.ts`),
`isTurnMemoryEnabled()` (`operator-turn-memory.ts`),
`isSqlReadonlyEnabled()` (`operator-sql-readonly.ts`),
`isBootstrapPackEnabled()` (`operator-bootstrap-pack.ts`),
`isVtidSelfAllocateEnabled()` (`operator-execution-onramp.ts`).
`OPERATOR_AWS_READONLY_ENABLED` has no dedicated predicate anywhere in
this codebase (confirmed via grep — every existing call site in
`gemini-operator.ts` checks `process.env.OPERATOR_AWS_READONLY_ENABLED
=== 'true'` inline), so the new route reads it the same way, rather than
inventing a new function this VTID would then be the only caller of.

## Fix

`services/gateway/src/routes/operator.ts`'s `GET /health` handler now
returns `capabilities: { threads, turn_memory, sql_readonly, aws_readonly,
bootstrap_pack, vtid_self_allocate }`, each a live boolean re-evaluated on
every request (every predicate function reads `process.env` fresh per
call, never cached at module load) — so a task-def env change takes
effect without a restart, matching this repo's own established
"read env at call time" convention (see §2b's note on `BEDROCK_ROLE_ARN`).

## Acceptance criteria

AC-1: `GET /api/v1/operator/health` returns
`{ok:true, capabilities: {threads, turn_memory, sql_readonly,
aws_readonly, bootstrap_pack, vtid_self_allocate}}` with each value
reflecting the LIVE environment variable state.
TEST: `services/gateway/test/vtid-04210-operator-capability-health.test.ts`
— "reports every flag false when none of the env vars are set", "reports
every flag true when every env var is the exact string 'true'", and
"reflects a mixed on/off state independently per flag".

AC-2: the route requires no authentication and reveals no secret values,
only booleans.
TEST: same file — "requires no authentication" and "exposes no secret
values — every capabilities value is a plain boolean".

AC-3: the new test confirms each flag reflects both its on and off
states.
TEST: same file — the all-false and all-true tests above, plus "treats
any value other than the exact string 'true' as off (e.g. '1', 'TRUE')"
(pinning the exact-string-match convention every one of these predicates
already uses, so a near-miss value doesn't silently read as enabled).

## Verification

`tsc --noEmit` clean.

Own suite: 7/7 tests, against the real `/api/v1/operator/health` route via
`supertest` and real `process.env` mutation (no module reset needed —
every predicate reads `process.env` at call time, confirmed by reading
each one's signature before writing the test).

Regression sweep — every test file exercising the touched predicate
functions or the operator identity/health surface:
`vtid-03926-operator-chat-userrole.test.ts`, `operator-chat-oasis.test.ts`,
`vtid-04022-operator-threads.test.ts`, `vtid-04025-operator-turn-memory.test.ts`,
`vtid-04023-operator-sql-readonly.test.ts`,
`vtid-04018-operator-bootstrap-pack.test.ts`,
`vtid-04007-open-ended-intake.test.ts`, plus the new file — 8 suites, 99
tests, 0 failures.

## Not done here

- Did not touch `POST /chat`, `/chat/stream`, or any other route — only
  the existing `GET /health` handler's response body.
- Did not add a dedicated predicate function for
  `OPERATOR_AWS_READONLY_ENABLED` — matching every existing call site's
  own inline convention rather than introducing a new function with a
  single caller.

OASIS_IMPACT: no — a health/status route reporting boolean flag state; it
emits no OASIS events and changes no authorization or execution path.
