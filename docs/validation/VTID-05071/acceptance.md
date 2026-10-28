# VTID-05071 — Kiro keeps the thread: decisions survive a fresh session; a missed Allow is visible and honestly labelled

Owner approval 2026-10-11 (Gate 1: "yes"). Sparring: `plan-sparring.md` (record f9145a2f…, converged; scope addition converged).

VALIDATION_PROFILE: gateway_backend

Incident (Operator thread 225ab6d2…, 2026-10-11): run 8997ac76 ended `refused` after a shell-command approval expired unanswered (120 s); run 6b770de3 ("continue", 33 min later) started a fresh Kiro session whose restored history (2,000 chars/message, 16,000 total) had lost the agreed decision.

## Acceptance criteria

AC-1: The restored history keeps up to 6,000 chars per message (first 1,500 + the end) and 40,000 in total; a 3,040-char reply comes back whole, an 8,711-char reply keeps its start and its conclusion; oldest messages drop first with the omitted line; the block tells Kiro to continue from an agreed decision.
  TEST: services/gateway/test/vtid-05071-kiro-keeps-thread.test.ts
  TEST: services/gateway/test/vtid-05018-kiro-thread-memory.test.ts
AC-2: An idle Kiro session closes after 45 min at the gateway and 50 min at the runner (gateway first); env overrides still work.
  TEST: services/gateway/test/vtid-05071-kiro-keeps-thread.test.ts
  TEST: services/kiro-runner/test/runner.test.ts
AC-3: An approval card waits 10 min by default; env override still works.
  TEST: services/gateway/test/vtid-05071-kiro-keeps-thread.test.ts
AC-4: The session rules point Kiro at services/gateway/specs/command-hub-symbol-index.json for app.js and away from shell grep.
  TEST: services/gateway/test/vtid-05071-kiro-keeps-thread.test.ts
AC-5: While a run waits on an unanswered card, the thread row shows "Needs your OK" and the tab title is prefixed "(!) "; both clear when it is answered.
  TEST: services/gateway/test/command-hub/vtid-05071-kiro-approval-visibility.test.ts
AC-6: A run that stopped right after an approval timed out reads "Stopped — your approval for "<title>" timed out." with Continue on the newest run; any other refusal keeps "Kiro stopped early: <reason>"; past runs that stopped early load their events so the label is right after a reload.
  TEST: services/gateway/test/command-hub/vtid-05071-kiro-approval-visibility.test.ts
AC-7: End to end, an unanswered approval times out, the turn ends refused, and the run record carries the timed-out answer before the refused status.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

## Staging (read-only)
`staging-tests.json`: /command-hub/ loads kiro-console.* and app.js at `?v=20261114-vtid-05071`; the served files contain the timeout label, the badge and the app.js hook.

## Decisions taken
- One app.js hook line for the sidebar badge (scope addition, sparred).
- The tab-title marker is also refreshed on every pane render, not only on the delayed refresh.
- Past runs that stopped early load their events up front (one replay per such run) so the timeout label survives a reload.
- The VTID-05018 clip test's "long" input grew from 5,000 to 12,000 chars because the cap it exercises grew to 6,000.
