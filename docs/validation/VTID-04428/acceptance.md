# VTID-04428 (companion VTID-04429) — acceptance

Recovery doc (`docs/OPERATOR-CONSOLE-E2E-RECOVERY-2026-09-21.md`) items 6 and 7b.

## Problem
A deploy- or verification-stage failure makes the bridge open a revert PR and
auto-merge it. The row went `reverted` with its original `pr_url`, and
`STRANDED_PR_FILTER` still counted it as a stranded PR, so the finding's own
self-heal child was refused ("already has an unmerged PR"). Separately, a
single transient PostgREST failure on the `vtid_ledger` close left the VTID
`in_progress` forever.

## Acceptance criteria
AC-1: `revertExecutionPR` reports `reverted_on_main: true` only when the revert PR merged.
TEST: services/gateway/test/vtid-04428-post-merge-retry.test.ts
AC-2: the bridge stamps `metadata.pr_reverted_at` only for a post-merge stage whose revert merged (not CI closes, not an open revert PR, not dry-run).
TEST: services/gateway/test/vtid-04428-post-merge-retry.test.ts
AC-3: `STRANDED_PR_FILTER` excludes rows carrying `pr_reverted_at`; the earlier clauses are unchanged, and all three flood guards still use it.
TEST: services/gateway/test/vtid-04428-post-merge-retry.test.ts
TEST: services/gateway/test/vtid-04280-pipeline-unstick.test.ts
AC-4 (VTID-04429): a failed `vtid_ledger` PATCH is retried once; two failures log `vtid_ledger terminalize FAILED`; a first-try success writes once.
TEST: services/gateway/test/vtid-04428-post-merge-retry.test.ts
TEST: services/gateway/test/vtid-03895-terminalize-vtid-ledger.test.ts

## Not covered
- Rows reverted before this change carry no stamp and stay blocked; the closed-PR reconciler sees their PR as `merged` and correctly does not unblock them. Clearing them is a manual decision.
- Not verified live: staging ECS cannot place tasks (AWS account block). The live signal is a post-merge failure whose self-heal child starts instead of being refused.

OASIS_PROOF: no new event types; the existing `dev_autopilot.execution.reverted` event is unchanged.
