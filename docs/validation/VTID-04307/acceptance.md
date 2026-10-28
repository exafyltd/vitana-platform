# VTID-04307 — Ticket admin endpoints verify the JWT (+ VTID-04308 dispatch)

Part of the intake-channels plan (`docs/INTAKE-CHANNELS-PLAN.md`, VTID-04306),
steps 1 and 2. Companion VTIDs in this PR: VTID-04306 (the plan document),
VTID-04308 (Approve & Fix dispatch, VTID per ticket, kill switch).

## Why

- `ensureTenantAdmin` (`routes/tenant-specialists.ts`) base64-decoded the JWT
  `sub` claim and never verified the signature. `Authorization: Bearer
  header.<any-sub>.sig` passed every `/api/v1/admin/tenants/:tid/*` route,
  including `POST /tickets/:id/activate`, which dispatches a Dev Autopilot
  code execution.
- Command Hub "Approve & Fix" and tenant approve-all only flipped
  `spec_ready → in_progress`; nothing ran, `linked_finding_id` stayed null so
  the completion reconciler never closed the ticket, and Activate then
  refused it as `ALREADY_IN_PROGRESS`.
- Live (2026-09-22): 134 tickets, 0 with `linked_vtid`.
- Feedback-lane findings bypassed the Dev Autopilot kill switch (VTID-02676).

## Acceptance Criteria

AC-1 A request to any tenant ticket/specialist endpoint with an unsigned or forged token is rejected 401 `INVALID_TOKEN` before any database read.
TEST: services/gateway/test/routes/tenant-specialists.test.ts

AC-2 A verified caller who is neither exafy_admin nor `active_role='admin'` in the requested tenant gets 403; a verified tenant admin passes.
TEST: services/gateway/test/routes/tenant-specialists.test.ts

AC-3 Approving a spec_ready bug/ux_issue ticket (Command Hub approve and tenant approve-all) dispatches it through `approveAndDispatchTicket`; the ticket moves to in_progress with `linked_finding_id` only after a successful dispatch, and a refused dispatch leaves it at spec_ready.
TEST: services/gateway/test/vtid-04308-feedback-approve-dispatch.test.ts

AC-4 Every dispatched ticket gets a real VTID before its execution exists (reused if the finding already has one), mirrored onto `feedback_tickets.linked_vtid`; allocation failure refuses the dispatch.
TEST: services/gateway/test/vtid-04308-feedback-approve-dispatch.test.ts

AC-5 The kill switch applies to feedback-lane findings in the safety gate and in the executor tick.
TEST: services/gateway/test/vtid-04308-feedback-approve-dispatch.test.ts

AC-6 The auto-approve allocator keeps its ledger shape when no source is passed.
TEST: services/gateway/test/vtid-04246-auto-approve-vtid-allocation.test.ts

## Not verified here

No live staging run: no ticket was approved on staging from this session
(approving would start a real Dev Autopilot execution against a real
member's report). The first Approve & Fix after deploy is the exercise:
expect `feedback_tickets.linked_vtid` set and a `dev_autopilot_executions`
row with the ticket's finding.
