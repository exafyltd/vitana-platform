# VTID-03877 — Operator on-ramp: sync execution outcome back to vtid_ledger

## Report

Surfaced directly by the platform owner testing the operator on-ramp eval work
(VTID-03862/VTID-03867/VTID-03875 chain): asked the Operator Console for
VTID-03862's status the morning after its execution had already reverted, and
was told it was still `in_progress`. Traced via direct DB query: the execution
(`dev_autopilot_executions` row `37fa35bb-...`) had genuinely reverted at
2026-09-13 20:59 UTC via the 20-minute stuck-execution watchdog — but
`vtid_ledger.status`, which every status-reporting tool (including the
Operator Console's own `autopilot_get_status`/`oasis_analyze_vtid`) reads, was
never updated. Root-caused to two independent, compounding gaps:

1. `operator-execution-onramp.ts` never wrote `metadata.autopilot_execution_id`
   onto the VTID's own `vtid_ledger` row — the only field
   `self-healing-reconciler.ts`'s existing outcome-sync logic looks for.
2. That sync logic (`reconcileAutopilotLinkedSelfHealingVtids`) additionally
   hard-filtered its ledger scan to `metadata->>source=eq.self-healing`, so
   even a correctly-linked operator-onramp VTID would still have been invisible
   to it — the filter excluded every bridge except the self-healing plane this
   function was originally built for, with no actual dependency on that field
   in the function's own logic.

## Acceptance Criteria

AC-1 — `triggerOperatorExecution()` links the queued execution onto the
target VTID's `vtid_ledger.metadata.autopilot_execution_id`, merging into
(never replacing) whatever metadata already exists on that row.

TEST: `outputs/jest-new-vtid-suites.txt` —
`vtid-03820-operator-execution-onramp.test.ts` "VTID-03877: links the
execution onto vtid_ledger.metadata..." case, asserting the merged body
retains pre-existing keys (`source`, `purpose`) alongside the new
`autopilot_execution_id`.

AC-2 — `reconcileAutopilotLinkedSelfHealingVtids()`'s ledger scan no longer
filters on `metadata->>source=eq.self-healing` — any ledger row with a linked,
non-terminal execution is picked up regardless of who created the link.

TEST: `outputs/jest-new-vtid-suites.txt` —
`self-healing-reconciler-autopilot-link.test.ts` "VTID-03877: terminalizes a
non-self-healing VTID (e.g. operator-onramp)..." case, using the exact
metadata shape (`source:'claude-code'`, no `source:'self-healing'`) the
on-ramp actually produces, and the exact failure shape (`status: 'reverted'`)
VTID-03862's real execution had.

AC-3 — Existing self-healing-plane behavior is byte-for-byte unchanged: a
self-healing VTID with a linked execution still terminalizes exactly as
before this change.

TEST: `outputs/jest-new-vtid-suites.txt` — all 11 pre-existing cases in
`self-healing-reconciler-autopilot-link.test.ts` pass unmodified (only the
mock's URL matcher was updated to match the new, widened query string; no
test's assertions or fixtures changed).

AC-4 — A failure while linking to `vtid_ledger` (network blip, row not found)
never fails the on-ramp trigger itself — the real execution is already queued
by that point and must not be rolled back over a best-effort bookkeeping write.

TEST: `outputs/jest-new-vtid-suites.txt` —
`vtid-03820-operator-execution-onramp.test.ts` "VTID-03877: a failure linking
to vtid_ledger does not fail the on-ramp trigger itself" case (ledger GET
mocked to reject; `triggerOperatorExecution` still returns `ok: true`).

AC-5 — `tsc --noEmit` is clean and the full gateway test suite passes
unmodified elsewhere.

TEST: `outputs/tsc-noemit.txt` (exit 0); `outputs/jest-full-suite-summary.txt`
— 763/764 suites (1 pre-existing skip), 13,907/13,942 tests, 0 failures.

---

**Known limitation, not silently deferred:** this fix takes effect on the
reconciler's next scheduled cycle after deploy (no new cron/dispatch needed —
`runReconcileCycle` already calls `reconcileAutopilotLinkedSelfHealingVtids()`
every cycle). It has not yet been observed correcting a real stuck VTID in
staging — the next real signal is VTID-03862 itself (already terminal,
`is_terminal=false` today) flipping to `is_terminal=true` on the first
reconcile cycle after this deploys.

OASIS_PROOF: the existing `self-healing.completed`/`self-healing.execution.failed`
OASIS events (unchanged event `type` values, generalized `message` wording)
now also fire for operator-onramp-linked VTIDs — verified structurally by the
new test cases; not yet observed as a real event for a real operator-onramp
VTID in staging (no live access from this session to watch `oasis_events`
after this deploys).
