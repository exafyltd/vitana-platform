# VTID-04218 — Dev Autopilot pipeline resilience: record before you merge, stamp the merge SHA when you reconcile

## Root cause

Two gaps, both surfaced on 2026-09-21 when the Aurora cutover write-freeze
(`scripts/aws/aurora-cutover-freeze-writes.sql`, 12:03–13:16 UTC) revoked
`service_role` writes while the staging gateway kept running:

1. **The watcher merged without being able to record it.** `ciWatcherTick`
   called `transitionStatus(ci → merging)` and then `mergePullRequest`
   unconditionally. Every PATCH was refused for ~70 minutes, yet 11 PRs
   (#3503–#3518) were squash-merged on GitHub with their rows still in `ci`
   and no `pr_merged` event. `transitionStatus` also treated a 0-row
   conditional PATCH as success, because it asked for `return=minimal` and
   PostgREST answers 204 either way.

2. **The reconciler advanced merged rows without a `merge_sha`.**
   `reconcileCi` / `reconcileMerging` found the PRs merged and PATCHed
   `status: 'deploying'` only. Without `metadata.merge_sha` the deploy stage
   can match a deploy event only by recency (VTID-04215's fallback), and a
   `deploying`/`verifying` failure cannot be auto-reverted
   (`revertExecutionPR` needs the SHA).

## Fix

`dev-autopilot-watcher.ts`
- `transitionMovedRow(r)` (pure, exported): true only when the PATCH
  succeeded AND returned at least one row.
- `transitionStatus` requests `return=representation`, returns
  `transitionMovedRow(r)`, warns when nothing moved, and fires the terminal
  side effects only when a row moved.
- Live CI path: `const enteredMerging = await transitionStatus(...)`; if
  false, log and `continue` — the PR is left for the next tick or the
  reconciler. The DRY_RUN synthetic path is unchanged.

`dev-autopilot-execute.ts`
- `mergedShaFromPr(pr)` (pure, exported): the PR's `merge_commit_sha` when
  merged and well-formed, else null.
- `reconcileCi` and `reconcileMerging` request `merge_commit_sha` and PATCH
  `metadata: { ...existing, merge_sha }` alongside `status: 'deploying'`,
  and carry `merge_sha` on the `pr_merged` event payload.

## Acceptance Criteria

AC-1 — `mergedShaFromPr` returns the trimmed SHA of a merged PR and null for unmerged, missing or malformed values.
TEST: services/gateway/test/vtid-04218-pipeline-resilience.test.ts — "returns the squash-merge SHA of a merged PR and null otherwise" (`npx jest services/gateway/test/vtid-04218-pipeline-resilience.test.ts`).

AC-2 — `transitionMovedRow` is true only for an ok response carrying at least one row.
TEST: services/gateway/test/vtid-04218-pipeline-resilience.test.ts — "is true only for a successful PATCH that returned at least one row".

AC-3 — `transitionStatus` asks for the representation; returns true on a one-row response, false on a 0-row response, false when the database refuses the write.
TEST: services/gateway/test/vtid-04218-pipeline-resilience.test.ts — the three "transitionStatus reports whether a row actually moved" cases.

AC-4 — The live CI path checks the ci→merging result and skips the GitHub merge when it did not record.
TEST: services/gateway/test/vtid-04218-pipeline-resilience.test.ts — "checks the transition result and `continue`s before calling mergePullRequest".

AC-5 — `reconcileStuckExecutions` on a stuck `ci` or `merging` row whose PR GitHub reports merged PATCHes `status: deploying` with `metadata.merge_sha` merged into the existing metadata; without a SHA it still advances.
TEST: services/gateway/test/vtid-04218-pipeline-resilience.test.ts — the "reconcileStuckExecutions stamps merge_sha" cases.

AC-6 — Existing watcher / execute / reconciler behaviour unchanged.
TEST: services/gateway/test/dev-autopilot-watcher.test.ts, test/dev-autopilot-execute.test.ts, test/self-healing-reconciler-autopilot-link.test.ts, test/vtid-04215-deploy-event-contract.test.ts (re-run green).

## Verification

- `tsc --noEmit` (services/gateway): clean.
- New suite 11/11; the four sibling suites above 80/80.

## Not verified

No live outage to replay. The next signal is a `dev_autopilot.execution.pr_merged`
event from the reconciler carrying `merge_sha`, and — should a write outage
recur — watcher logs reading "ci→merging not recorded; refusing to merge"
with no unrecorded merge on `main`.
