# VTID-04415 — Orchestrator P3→P4: delegation jobs written to agent_runs

Plan: docs/ORCHESTRATOR-REDESIGN-PLAN.md §5 (P3 async jobs, P4 "dev planes on
the ledger"), §3.3 run ledger.

Dispatcher jobs lived only in process memory. A voice session is pinned to
one gateway task, but the member's NEXT session may land on another one, and
then `get_delegation_result` finds nothing. With
`ORCHESTRATOR_DELEGATION_PERSIST_ENABLED=true` each job is written through to
the native `agent_runs` table (created by VTID-04319, live, browser roles
revoked): an insert when it starts, an update when it finishes or is
cancelled, the update always chained after the insert. `get_delegation_result`
now reads memory first and falls back to the ledger under the same owner rules
(same user, same surface). Memory stays primary; every store call is
fail-open. Cancel stays memory-only: a job running on another task cannot be
stopped from here. No schema change; unset flag = behaviour as before.

## Acceptance

AC-1 The store is off unless ORCHESTRATOR_DELEGATION_PERSIST_ENABLED is exactly 'true'.
TEST: services/gateway/test/services/orchestrator/vtid-04415-delegation-run-store.test.ts

AC-2 Start is written, and finish only after start, even when the job finishes inside the ack window.
TEST: services/gateway/test/services/orchestrator/vtid-04415-delegation-run-store.test.ts

AC-3 A cancelled job is written as cancelled.
TEST: services/gateway/test/services/orchestrator/vtid-04415-delegation-run-store.test.ts

AC-4 A failing store never changes the delegation outcome.
TEST: services/gateway/test/services/orchestrator/vtid-04415-delegation-run-store.test.ts

AC-5 A job this task no longer holds is found in the ledger by its owner on its surface only; another user, another surface or an anonymous caller reads nothing.
TEST: services/gateway/test/services/orchestrator/vtid-04415-delegation-run-store.test.ts

AC-6 latestJob returns the newest of local and ledger; without a store it is local only.
TEST: services/gateway/test/services/orchestrator/vtid-04415-delegation-run-store.test.ts

AC-7 The start row fits agent_runs (plane 'orb', surface in metadata, intent bounded to 500 chars, created_via and tier only allowed values).
TEST: services/gateway/test/services/orchestrator/vtid-04415-delegation-run-store.test.ts

AC-8 Only uuid-keyed jobs persist, results are bounded to 8 000 chars, and rows in states a delegation never writes are rejected.
TEST: services/gateway/test/services/orchestrator/vtid-04415-delegation-run-store.test.ts

AC-9 The Supabase store filters reads by id, plane, user and surface.
TEST: services/gateway/test/services/orchestrator/vtid-04415-delegation-run-store.test.ts

## Not verified live

Staging still serves `e09eb26` (AWS task-placement block) and the flag is not
pinned anywhere. The live check once it is: a `plane='orb'` row in
`agent_runs` (and so in `agent_runs_unified` / the Orchestrator view) per
delegation, with `status` moving from running to succeeded.
