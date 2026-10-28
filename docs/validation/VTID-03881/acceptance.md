# VTID-03881 — self-healing-reconciler: set vtid_ledger.status on the terminal-failure branch

## Report

Found while proactively verifying VTID-03877's fix against real production data
(not a new user report). After backfilling VTID-03862's `metadata.
autopilot_execution_id` link and confirming the reconciler's next cycle
correctly terminalized it (`is_terminal=true`, `terminal_outcome='failed'`,
OASIS event emitted, verified live in `oasis_events`/gateway logs at
2026-09-14 11:36:59 UTC), the ledger row's `status` column was still
`in_progress`.

Root cause: `reconcileAutopilotLinkedSelfHealingVtids()`'s success branch
explicitly sets `status: 'completed'` alongside `terminal_outcome: 'success'`
— but its sibling failure branch only ever set `is_terminal`/`terminal_outcome`/
`metadata`, never `status`. Any status-only reader (the Operator Console's
`autopilot_get_status`, or anything filtering `vtid_ledger.status` directly)
still reports a terminally-failed VTID as in-flight — the exact class of bug
VTID-03877 exists to fix, reintroduced on the failure path specifically.

## Acceptance Criteria

AC-1 — The failure branch's `vtid_ledger` PATCH body includes
`status: 'failed'`, matching the success branch's `status: 'completed'`.

TEST: `outputs/jest-new-vtid-suites.txt` — all three failure-path cases in
`self-healing-reconciler-autopilot-link.test.ts` (`execution.status=failed`,
`execution.status=failed_escalated`, and the VTID-03877 operator-onramp case)
now assert `ledger.body.status === 'failed'`.

AC-2 — `'failed'` is a value already used for `vtid_ledger.status` elsewhere
in this codebase (not a new, invented enum value).

Confirmed by inspection: `services/gateway/src/routes/events.ts` already
queries `vtid_ledger` for `status.eq.failed` among other terminal-like
status values.

AC-3 — Existing success-path and in-flight-status behavior is byte-for-byte
unchanged.

TEST: `outputs/jest-new-vtid-suites.txt` — all other pre-existing cases in
`self-healing-reconciler-autopilot-link.test.ts` pass unmodified.

AC-4 — A separate, independently-discovered regression from PR #3305
(VTID-03880) is fixed in the same PR: that PR renamed
`AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml`'s `DEEPSEEK_SECRET_NAME` env var to
a hardcoded `DEEPSEEK_SECRET_ARN` literal, but PR #3305 was validated only by
YAML/bash-syntax checks (workflow-only change, no `services/gateway/src|test`
touched) — the full jest suite was not run before merging, and it broke
`vtid-03850-staging-executor-dispatch-pinned.test.ts`'s pin on the old env
var name/shape. Caught here by running the full suite as part of this PR's
own validation, before push.

TEST: `outputs/jest-new-vtid-suites.txt` —
`vtid-03850-staging-executor-dispatch-pinned.test.ts` updated to pin the new
`DEEPSEEK_SECRET_ARN` literal shape; full suite in
`outputs/jest-full-suite-summary.txt` confirms 0 failures.

AC-5 — `tsc --noEmit` is clean and the full gateway test suite passes.

TEST: `outputs/tsc-noemit.txt` (exit 0); `outputs/jest-full-suite-summary.txt`
— 763/764 suites (1 pre-existing skip), 13907/13942 tests, 0 failures.

---

**Live proof, not just structural:** VTID-03862 itself is the evidence this
fix is real — it terminalized failed via the reconciler at 2026-09-14
11:36:59 UTC while its `status` column stayed `in_progress` (queried
directly from `vtid_ledger` immediately after). This PR's fix, once deployed,
should be re-verified by re-querying that same row's `status` — it will not
retroactively fix VTID-03862 (already-written rows aren't touched by this
change), but the next VTID this reconciler terminalizes-as-failed should
show `status: 'failed'`.
