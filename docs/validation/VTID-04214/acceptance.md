# VTID-04214 — Acceptance

Adds a maximum-length guard for the `request` argument of the
`autopilot_run_task` operator tool (`services/gateway/src/services/gemini-operator.ts`'s
`executeRunTask`). A caller submitting a `request` string longer than
50,000 characters is refused before any VTID allocation or governance
check, with a clear error naming the limit and the actual length
received.

## Background

This is the original goal of VTID-04163, one of 11 VTIDs from the queued
30-task Command Hub batch that terminalized `failed`
(`agent hit the 120-turn cap without calling finish`) via the Dev
Autopilot agent executor — confirmed via `oasis_events` to have spent
all 120 turns on `read_file`/`search_text`/`find_files` with zero edit
calls (the same shape VTID-04213 fixes at the loop level). Implemented
directly here rather than re-queued, per the standing instruction to fix
a failed task's underlying goal when the autonomous plane cannot land it.

## Fix

- `MAX_RUN_TASK_REQUEST_CHARS` (50,000, exported) and
  `describeRunTaskRequestTooLong(length)` (exported, pure) — mirrors the
  sibling VTID-04201 pattern of exporting a small pure constant/helper
  for direct testing instead of mocking the whole authz/governance/
  Supabase chain to reach one length comparison.
- `executeRunTask` gains one new early-return branch, placed
  immediately after the existing `isExecuteTaskAuthorized` check and
  before the pre-existing `request.length < 12` floor check — i.e.
  after auth (security ordering preserved) and before governance
  evaluation or `triggerOperatorExecution` (VTID allocation).

## Acceptance criteria

AC-1: a `request` string over 50,000 characters is refused with a clear
error naming the 50000 limit, before any VTID allocation or governance
check.
TEST: `services/gateway/test/vtid-04214-run-task-request-cap.test.ts` —
"names the limit and the actual length received" (message content) and
"the length-cap check runs BEFORE any VTID allocation or governance
call" (ordering, verified against the real source).

AC-2: a `request` string at or under the limit is unaffected — passes
through exactly as before.
TEST: `services/gateway/test/vtid-04214-run-task-request-cap.test.ts` —
"a request at or under the limit is unaffected — no cap branch exists
between the floor check and it".

AC-3: the check runs after the auth check, preserving this codebase's
established security-first ordering (every operator-tool handler checks
authz before anything else).
TEST: `services/gateway/test/vtid-04214-run-task-request-cap.test.ts` —
"the length-cap check runs AFTER the auth check (security ordering is
preserved)".

## Verification

`tsc --noEmit` (services/gateway) — clean.

Own suite: `services/gateway/test/vtid-04214-run-task-request-cap.test.ts`
— 6/6 passing.

Regression sweep — `test/vtid-04214-run-task-request-cap.test.ts`,
`test/vtid-04007-open-ended-intake.test.ts`,
`test/vtid-04132-onramp-open-ended-safety-gate.test.ts` — 3 suites, 23
tests, 0 failures.

## Not done here

- Does not test `executeRunTask` end-to-end through a mocked
  authz/governance/Supabase chain — the source-order characterization
  tests confirm the same ordering guarantee without that overhead,
  matching the sibling VTID-04201's own approach for the same function.
- Does not retroactively re-run VTID-04163 (already terminalized
  `failed`) — this PR implements the underlying goal directly instead.

OASIS_IMPACT: no — a pure input-validation early return; no new event
topic, no route/schema change.
