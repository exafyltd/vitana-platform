# VTID-04203 — Acceptance

Test-only regression coverage for `services/gateway/src/services/operator-execute-authz.ts`,
the module that gates `autopilot_execute_task`/`autopilot_run_task` on a
verified exafy_admin identity carried per-thread. It stores each thread's
auth marker with a 30-minute TTL (`THREAD_AUTH_TTL_MS`, private to the
module) via `setTimeout`.

## What was checked

The module's own header comment is explicit that this TTL "exists only as
a memory backstop, never as the authorization boundary" — the real
boundary is that the route calls `setThreadAuth()`/`clearThreadAuth()` on
every request, before the tool runs. The existing test file
(`vtid-03851-execute-task-requires-auth.test.ts`) thoroughly pins that real
boundary (set→get round-trip, a cleared marker on a reused threadId, a
non-admin overwrite) but never exercises the TTL's own expiry behavior
over elapsed time — every existing test reads the marker back
synchronously, in the same tick it was set, so a bug that broke the
`setTimeout`/`unref` wiring (e.g. the timer never firing, or firing too
early) would not be caught by anything currently in the suite.

## Fix

No source change — `operator-execute-authz.ts` is untouched. Added
`services/gateway/test/vtid-04203-thread-auth-ttl-expiry.test.ts` using
`jest.useFakeTimers()`/`jest.advanceTimersByTime()`, covering three
distinct, previously-uncovered cases:

1. The marker is present immediately after `setThreadAuth()`, still
   present one millisecond before the TTL elapses, and gone exactly at
   the TTL boundary.
2. `clearThreadAuth()` actually cancels the pending timer (not just
   deletes the map entry) — advancing time past the TTL afterward does
   nothing, confirming the module's `clearTimeout(entry.timer)` call is
   load-bearing, not redundant with the map delete.
3. Calling `setThreadAuth()` again for the same thread resets the TTL
   window rather than leaving the original timer to fire and evict the
   newly-set marker early — `clearThreadAuth()` is called at the top of
   `setThreadAuth()` for exactly this reason, and this is the first test
   to actually observe that under fake-timer time advancement.

## Acceptance criteria

AC-1: a test using fake timers confirms `getThreadAuth()` returns the
stored marker immediately after `setThreadAuth()`, and returns `undefined`
after fake-advancing time past `THREAD_AUTH_TTL_MS`.
TEST: `services/gateway/test/vtid-04203-thread-auth-ttl-expiry.test.ts` —
"getThreadAuth returns the marker immediately, and undefined once the TTL
elapses".

AC-2: `clearThreadAuth()` actually cancels the pending expiry timer (not
just the map entry) — advancing fake time past the TTL after a clear must
not resurrect or otherwise disturb a since-cleared/re-set marker.
TEST: `services/gateway/test/vtid-04203-thread-auth-ttl-expiry.test.ts` —
"clearThreadAuth cancels the pending timer — advancing time past the TTL
afterward does nothing new".

AC-3: calling `setThreadAuth()` again for the same thread resets the TTL
window rather than leaving the original timer to fire and evict the
newly-set marker early.
TEST: `services/gateway/test/vtid-04203-thread-auth-ttl-expiry.test.ts` —
"setThreadAuth called again for the same thread resets the TTL window
rather than stacking timers".

## Verification

`tsc --noEmit` clean — no source file changed.

Own suite: 3/3 tests passing.

Regression sweep — every test file resolvable on this branch (based on
`main`) that exercises `operator-execute-authz.ts` or a tool built on it:
`vtid-03851-execute-task-requires-auth.test.ts`,
`vtid-04030-operator-approval-tools.test.ts`,
`vtid-04034-operator-cancel-tool.test.ts`,
`vtid-04111-operator-activate-recommendation.test.ts`, plus the new file
— 5 suites, 60 tests, 0 failures. (A sixth candidate,
`vtid-04202-reject-execution-reason-required.test.ts`, lives only on its
own not-yet-merged branch and is not present on `main` at this branch's
base — expected, not a gap.)

## Not done here

- No production/staging deploy signal applies — this is a test-only
  change with no runtime behavior difference; there is nothing to observe
  live.
- Did not export `THREAD_AUTH_TTL_MS` from the module — the test
  hardcodes the documented 30-minute value with a comment pointing at the
  private constant's name, rather than widening the module's public
  surface just to satisfy a test.

OASIS_IMPACT: no — this PR adds one test file; it emits no OASIS events
and changes no runtime code path.
