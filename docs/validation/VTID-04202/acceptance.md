# VTID-04202 — Acceptance

`autopilot_reject_execution` (`services/gateway/src/services/operator-approval-tools.ts`'s
`executeRejectExecution()`) accepts an optional `reason` argument, recorded
on the execution row when it rejects a held Dev Autopilot execution. The
tool's own schema (`tool-registry.ts`) correctly marks `reason` as optional
— omitting it entirely is a legitimate, supported call shape, and the
existing test suite (`vtid-04030-operator-approval-tools.test.ts`) already
pins that an omitted reason still rejects, recording `reason: null`.

## What was found

Before this change, an EXPLICITLY-passed empty string or whitespace-only
`reason` was silently treated identically to an omitted one — `typeof
args?.reason === 'string' && args.reason.trim() ? ... : undefined` folds
`''`/`'   '` into the same `undefined` branch as "no reason given at all",
with no signal back to the caller that the string it passed carried no
actual content. That is a real, distinct failure mode from "the caller
chose not to give a reason": a model or operator that types `reason: ""`
almost certainly meant to say something and either failed to, or is
narrating a call it never actually composed correctly (the same general
shape this repo's own VTID-04172 — detecting a narrated-but-not-executed
tool call — exists to catch elsewhere in the operator pipeline).

## Fix

`executeRejectExecution()` now refuses, before touching Supabase or
`resolveExecutionId()` (so the execution row is never read or written),
when `args.reason` is present as a string but trims to empty — with a
clear error asking for a real reason or to omit the argument entirely.
An omitted `reason` (the property absent, or `undefined`) is completely
unaffected and still rejects exactly as before.

## Acceptance criteria

AC-1: `autopilot_reject_execution` called with an empty string or
whitespace-only `reason` is refused with a clear error, and the execution
row is NOT modified (`reject()` is never called).
TEST: `services/gateway/test/vtid-04202-reject-execution-reason-required.test.ts`
— "refuses an empty-string reason..." and "refuses a whitespace-only
reason...".

AC-2: A real, non-empty reason still rejects the execution exactly as
before.
TEST: same file — "a real, non-empty reason still rejects exactly as
before".

AC-3 (regression): an omitted `reason` is unaffected — still rejects,
still records `reason: null` on the row.
TEST: same file — "an omitted reason is unaffected..."; also already
pinned by the pre-existing
`vtid-04030-operator-approval-tools.test.ts` "reject hands actor +
trimmed reason..." test, re-run unmodified below.

## Verification

`tsc --noEmit` clean. New tests: 4, all against the real, unmocked
`executeRejectExecution()` function (Supabase itself mocked via the
existing `deps.reject`/`deps.s` injection points this file's own test
suite already uses — not a mock of the function under test).

Regression sweep — every test file exercising `operator-approval-tools.ts`
or the sibling tools sharing its auth/dispatch shape:
`vtid-04030-operator-approval-tools.test.ts`,
`vtid-04033-operator-execution-follow.test.ts`,
`vtid-04034-operator-cancel-tool.test.ts`,
`vtid-04111-operator-activate-recommendation.test.ts`, plus the new file
— 5 suites, 57 tests, 0 failures.

## Not done here

- `autopilot_approve_execution` needs no such validation (it has no
  `reason` argument at all — confirmed via the tool registry schema) and
  is untouched.
- Not verified against a live Operator Console session — this tool
  requires an authenticated exafy_admin thread and a real
  `awaiting_approval` execution, and this session has no live Operator
  Console access; the next real signal is a real
  `autopilot_reject_execution` call with an explicit empty `reason` being
  refused on staging.

OASIS_IMPACT: no — this is an input-validation change inside an existing
tool handler; it emits no new OASIS events and changes no existing event
schema or topic. The tool's `reason` refusal never reaches
`rejectExecution()`, so no `dev_autopilot.execution.cancelled` event fires
for a refused call — same as any other pre-flight refusal in this file
(the anonymous/non-admin auth refusal already behaves this way).
