# VTID-04472 — A fix-mode lineage's VTID is no longer closed `failed` at the first red CI

The VTID-04465 operator regression suite found this bug. When an agent PR's CI failed, the watcher moved the parent `ci → failed` through `transitionStatus()`, and `applyExecTerminalSideEffects(…, 'failed')` then closed the VTID ledger row as `failed` straight away. The bridge then spawned a fix-mode child that fixed the PR on the same branch and completed. That success could not reopen the ledger (the PATCH is guarded by `is_terminal=eq.false`), so every self-healed operator task was recorded as failed.

## Acceptance criteria

AC-1 The watcher's `→ failed` transitions run the terminal side effects with `deferLedger`, so the ledger is not closed at the failure. Every such transition is followed by a bridge call.
TEST: services/gateway/test/vtid-04472-ledger-deferred-to-bridge.test.ts

AC-2 `applyExecTerminalSideEffects(…, { deferLedger: true })` skips only the ledger. Outcome bookkeeping still runs, and without the option the status→ledger mapping is unchanged.
TEST: services/gateway/test/vtid-04378-ledger-terminalization.test.ts

AC-3 After the bridge runs, the watcher closes the ledger as `failed` itself unless the bridge owns the outcome. The bridge owns `self_heal_injected` (a child continues the VTID) and `escalated`, `env_blocker` and `triage_failed` (each closes the ledger through `closeLedgerForEscalation`). Already bridged, missing row and a thrown call fall back to the watcher's close, so no VTID is left open.
TEST: services/gateway/test/vtid-04472-ledger-deferred-to-bridge.test.ts

AC-4 End to end: red CI → fix-mode child on the same PR → green → merged → the VTID closes as `success`. With the deferral removed (mutant `deferLedger: false`), this test fails.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

## Not verified live

The live signal is a staging operator task whose first PR fails CI and whose fix-mode child merges, with the VTID ending `completed`/`success` instead of `failed`.
