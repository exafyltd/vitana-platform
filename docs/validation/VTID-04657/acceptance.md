# VTID-04657 — Command Hub "Activate" never reached Dev Autopilot execution

## Root cause

1. `activate_autopilot_recommendation` sets the finding to `status='activated'`.
2. The route then calls `bridgeActivationToExecution` → `approveAutoExecute`,
   which refused every finding whose status was not `'new'` (VTID-02639 guard).
3. The bridge was fire-and-forget; the refusal only reached the gateway log,
   and the route answered `ok:true`, so the Command Hub showed "Activated!".
4. The activation reaper only retries `status='activated'` rows, so it hit the
   same guard on every tick.
5. The RPC also replaced `spec_snapshot`, dropping `scanner`, `file_path`,
   `proposed_files` and `intake` that the safety gate reads.

Live evidence: `outputs/live-activation-evidence.md` — the last 6 Activate
clicks created 0 executions. Reproduction before the fix:
`outputs/repro-before-fix.test.ts` → `finding status is 'activated' — only
'new' findings can be approved`.

## Fix

- `ApprovalInput.allowActivatedStatus`, set only by `bridgeActivationToExecution`:
  an `'activated'` finding is accepted; `completed`/`rejected`/`snoozed` stay
  refused; stranded-PR and in-flight guards unchanged; autonomous approvals
  unchanged.
- Route: the bridge is awaited up to `AUTOPILOT_ACTIVATION_BRIDGE_BUDGET_MS`
  (8 s) and its outcome is returned as `execution`
  (`queued` / `pending` / `failed` + violations / `not_executable`). A failure
  is recorded as OASIS `autopilot.recommendation.activation_bridge_failed`.
- Command Hub: the toast states what happened to the execution; the button is
  re-enabled after a failure.
- Migration `20260926120000_vtid_04657_activate_keeps_spec_snapshot.sql`:
  the RPC merges into `spec_snapshot` instead of replacing it.

## Acceptance criteria

AC-1 An activated dev_autopilot finding bridges into a new execution row.
TEST: services/gateway/test/vtid-04657-activate-reaches-execution.test.ts

AC-2 `new` findings still bridge; `completed`/`rejected`/`snoozed` stay refused; autonomous approvals still refuse `activated`; an in-flight execution is reused, not duplicated.
TEST: services/gateway/test/vtid-04657-activate-reaches-execution.test.ts

AC-3 The Activate response reports the execution outcome, including safety-gate violations, and records a failure in OASIS.
TEST: services/gateway/test/vtid-04657-activate-reaches-execution.test.ts

AC-4 oasis / roadmap / behavior recommendations are reported as `not_executable` instead of implying execution.
TEST: services/gateway/test/vtid-04657-activate-reaches-execution.test.ts

AC-5 The activate RPC keeps producer keys in `spec_snapshot`.
TEST: services/gateway/test/vtid-04657-activate-reaches-execution.test.ts

## Not verified live

- No Activate click was made on staging: staging writes to the production
  database and an activation creates a VTID and a real agent run.
- The migration ships as a file; it takes effect after
  `RUN-MIGRATION.yml` is dispatched for it.
