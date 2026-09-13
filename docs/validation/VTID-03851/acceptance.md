# VTID-03851 — `autopilot_execute_task` requires an authenticated exafy_admin session

## Report

`POST /api/v1/operator/chat` is mounted without auth middleware. On staging
2026-09-13 it accepted this session's request with no Authorization header
(recorded in `docs/validation/VTID-03841/acceptance.md`, finding 1). With
`OPERATOR_EXECUTION_ONRAMP_ENABLED=true` on staging, that anonymous request
could reach `autopilot_execute_task` (VTID-03820), which queues a real code
execution that opens a pull request against this repository. Every other
gate on that path (target VTID must be `spec_status='approved'`, the full
safety gate, the kill switch) checks the *target*, not the *caller*.

Fix, kept to the one tool that writes:

- New `services/gateway/src/services/operator-execute-authz.ts`: a
  per-thread marker (`setThreadAuth` / `clearThreadAuth` / `getThreadAuth`)
  and a pure predicate `isExecuteTaskAuthorized()` that requires a verified
  `user_id` AND `exafy_admin === true`.
- `routes/operator.ts` `/chat` now runs `optionalAuth` (verifies a bearer
  token when present, never rejects — anonymous chat keeps working) and on
  EVERY request either sets the marker from `req.identity` or clears it.
  This matters because `threadId` is client-supplied: an anonymous request
  reusing an admin's thread id must not inherit the admin's marker.
- `gemini-operator.ts` `executeExecuteTask()` checks the marker first —
  before governance evaluation, before any OASIS event, before any DB read
  — and returns a named refusal (`auth_unauthenticated` / `auth_not_admin`)
  logged via `logAutopilotIntent`.

The Command Hub already sends `Authorization: Bearer <token>` on the chat
route via `buildContextHeaders()`, and the platform owner's session is
exafy_admin (the same requirement every other write route in this file —
`/publish`, `/revert`, `/promote` — enforces via `requireAdminAuth`), so
the Operator Console's own use of the tool is unchanged.

## Acceptance Criteria

AC-1 — No marker / empty user_id → `unauthenticated`; authenticated
non-admin → `not_admin`; verified exafy_admin → allowed.

TEST: `test/vtid-03851-execute-task-requires-auth.test.ts` — the five
tests under "isExecuteTaskAuthorized (pure)".

AC-2 — An anonymous request on a reused thread id clears the admin marker;
a non-admin request overwrites it.

TEST: same file — "the threat this exists for: an anonymous request on a
reused threadId clears the admin marker"; "a non-admin request on a reused
threadId overwrites, never keeps, the admin marker".

AC-3 — `/chat` runs `optionalAuth` and writes the marker on every request
(set or clear) before the LLM turn.

TEST: same file — "/chat runs optionalAuth …"; "/chat writes the marker on
EVERY request …".

AC-4 — `executeExecuteTask` refuses before governance and never reaches the
on-ramp for a refused caller; an authorized caller still reaches it.

TEST: same file — "executeExecuteTask refuses before governance, OASIS, or
any on-ramp call"; "the on-ramp is still reachable for an authorized
caller".

AC-5 — No regression: `tsc --noEmit` clean; operator/on-ramp suites green;
full gateway suite green.

TEST: `outputs/tsc-noemit.txt`; `outputs/jest-scoped-operator.txt`;
`outputs/jest-full-suite-tail.txt`.

## Verified live after deploy (recorded in commands.log)

- `POST /api/v1/operator/chat` on staging with NO Authorization header and
  an explicit execute request for an approved VTID → the reply reports the
  tool's `auth_unauthenticated` refusal; no `dev_autopilot_executions` row,
  no `autopilot_recommendations` row is created (read-only SQL check).

## Not verified here

An end-to-end authorized execution from a real admin session — this
session holds no exafy_admin JWT. The refusal path is the security
property and is verified live; the allow path is verified structurally and
by the unchanged `triggerOperatorExecution` call.
