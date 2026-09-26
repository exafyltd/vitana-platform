# VTID-04649 — Support auto-dispatch never reached Dev Autopilot

Found during the owner-requested full staging verification of the support
work (2026-09-26). Live evidence, `oasis_events`, 2026-09-24 12:45–13:00 UTC,
six `feedback.ticket.auto_dispatch_blocked` events on staging:

> bridge failed: approved_by must be a user UUID (dev_autopilot_executions.approved_by is uuid) — got "auto-dispatch".

## Root cause

Auto-dispatch (VTID-04333) calls `approveAndDispatchTicket(id, 'auto-dispatch')`.
The feedback bridge forwarded that actor label unchanged to
`bridgeActivationToExecution`, which passes it to `approveAutoExecute`. Since
VTID-03839, `approveAutoExecute` refuses any approver that is not a user UUID,
because `dev_autopilot_executions.approved_by` is a uuid column. A human
"Approve & Fix" click passes the admin's user id and works; only the automatic
path was broken — so no member bug report could ever start a fix run on its own.

The VTID-04456 regression suite did not catch it: its bridge stub accepted any
approver.

## Fix

- `bridgeApprover()` in `feedback-execution-bridge.ts`: only a real user id is
  passed to the bridge as the approver; a label becomes `null`. The label stays
  on the OASIS events and the ticket (`auto_dispatch: true`).
- The regression suite's bridge stub now enforces the real UUID rule (it uses
  the real `isUuidString`).

## Acceptance criteria

AC-1: An auto-dispatched bug ticket reaches the Dev Autopilot bridge with a null approver, so the bridge accepts it; the label `auto-dispatch` is never passed as `approved_by`.
TEST: services/gateway/test/vtid-04649-feedback-bridge-approver.test.ts

AC-2: The customer support regression suite fails when the label reaches the bridge (mutation: 7 of 22 tests fail with the old code) and passes with the fix.
TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts

AC-3: A human Approve & Fix click still passes the admin's user id as the approver; the existing bridge suites stay green.
TEST: services/gateway/test/vtid-04308-feedback-approve-dispatch.test.ts
TEST: services/gateway/test/vtid-04333-feedback-bridge-ticket-ref.test.ts

## OASIS

OASIS_PROOF: no new topic. The existing `feedback.ticket.dispatched` event (VTID-04333) is what a working auto-dispatch now emits instead of `feedback.ticket.auto_dispatch_blocked`; its payload keeps `approved_by: "auto-dispatch"` and `auto_dispatch: true`.

## Not verified live

A real ticket going through auto-dispatch on staging after this deploys. No
test ticket is created from a session (staging writes to the production
database; CLAUDE.md rules 31–32, 48) — the first real member bug report on
staging is the live exercise.
