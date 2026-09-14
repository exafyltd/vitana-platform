# VTID-03887 — Gateway: the approver sees the BackOffice command payload

**Layer:** DEV / Gateway · **Profile:** gateway_backend · **Design gate:** `docs/backoffice/GOLDEN-WORKFLOWS.md` §3.3 (maker-checker: requester ≠ approver) · **Recorded gap:** `docs/validation/VTID-03873/acceptance.md` ("the payload itself is not on GET /commands/:id yet").

## Why

VTID-03873 shipped the Approvals decision screen against `GET /api/v1/backoffice/commands/:id`, which returned the command without its `payload`/`resolved_payload` (VTID-03842's `publicCommand()` deliberately kept them off the list and the single read). An approver therefore saw *what kind* of command was queued but not *what it does* — an invoice id, an amount, a reason. Maker-checker without the material is a rubber stamp.

## What changed

- `services/backoffice/command-orchestrator.ts` — `publicCommand(row, replayed, withPayload)` adds `payload` + `resolved_payload` only when the route says so; new pure `mayViewPayload(row, viewer, approval)`: the requester, an `audit.view` holder, or a holder of the queued approval's `approve_capability`.
- `routes/backoffice-commands.ts` — `GET /commands/:id` resolves the approval (when any) and answers 200 + payload to the three viewer classes, 404 to everyone else (unchanged for the requester/audit case, widened for the approver). `GET /approvals` attaches `command` (with payload) to each approval the caller may see the payload of, `null` otherwise. `GET /commands` (the list) stays a summary — never a payload.
- `services/backoffice/command-store.ts` — `getCommandsByIds(tenantId, ids)` on the interface, the PostgREST store (`id=in.(…)`, one round trip for the approvals page) and the memory store.
- No schema change, no new route, no migration.

## Acceptance criteria

AC-1 — Requester and `audit.view` see `payload` + `resolved_payload` on `GET /commands/:id`
TEST: `test/routes/backoffice-commands.test.ts` › "VTID-03887" › "requester and audit.view see payload + resolved_payload" (`outputs/jest-backoffice-commands.txt`)

AC-2 — A holder of the approval's approve capability sees the queued command with its payload; a caller with an unrelated capability still gets 404
TEST: `test/routes/backoffice-commands.test.ts` › "a holder of the approve capability sees the queued command; anyone else still gets 404"

AC-3 — The command list never carries a payload
TEST: `test/routes/backoffice-commands.test.ts` › "GET /commands (list) never carries a payload"

AC-4 — `GET /approvals` attaches the command with payload for the approver and the requester, `null` for a bystander; `can_decide` unchanged
TEST: `test/routes/backoffice-commands.test.ts` › "GET /approvals attaches the command with payload…"

AC-5 — After the decision the approver still sees what was approved (audit trail)
TEST: `test/routes/backoffice-commands.test.ts` › "the approver still sees the payload after deciding"

AC-6 — Nothing else in the BackOffice suites changed behaviour
TEST: `test/routes/backoffice-commands.test.ts` (24/24), `test/routes/backoffice-access.test.ts`, `test/vtid-03848-backoffice-voice-tools.test.ts`, `test/vtid-03848-orchestrator-voice-ceiling.test.ts` — 47/47; full gateway suite `outputs/gateway-jest-full-tail.txt`; `tsc --noEmit` clean (`outputs/tsc-noemit.txt`).

## Not verified / owed

- Staging curl of `GET /api/v1/backoffice/approvals` with a real queued command — needs a live bridge (VTID-03840 provisioning) so a High-risk command can be queued at all.
- The frontend half (Approvals decision dialog renders `command.payload`) is VTID-03888 in `exafyltd/vitana-v1`.
