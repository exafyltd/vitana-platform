# VTID-04691 — close a VTID in the ledger when its PR merges

## Acceptance criteria

AC-1: On a PR merged into main, each VTID named in the PR title that is still open in `vtid_ledger` is closed as `success` through `POST /api/v1/oasis/tasks/:vtid/complete`.
  TEST: scripts/ci/vtid-auto-close.test.cjs — "closes open rows as success and leaves terminal ones untouched"
AC-2: A row that is already terminal (cancelled, rejected, completed) is never posted to, so a cancel decision is never overwritten with success.
  TEST: scripts/ci/vtid-auto-close.test.cjs — "rowAction: only a non-terminal row is closed"; mutation-checked (removing the guard fails 2 tests)
AC-3: VTIDs cited only in the PR body are not closed; Dev Autopilot PRs (`dev-autopilot/*`) and PRs with the `vtid-keep-open` label or a `VTID_AUTO_CLOSE: no` body line are skipped with no ledger call.
  TEST: scripts/ci/vtid-auto-close.test.cjs — "extractTitleVtids", "autoCloseDecision", "a skipped PR makes no ledger call at all"
AC-4: A failed read or close is reported (warning + job summary) and never fails the job; the remaining VTIDs are still processed.
  TEST: scripts/ci/vtid-auto-close.test.cjs — "a per-VTID failure is reported, never thrown"

## Not verified here

The workflow itself runs only on a real merge; the first merged PR after this lands (this PR's own merge closes VTID-04691) is the live exercise.

## OASIS

OASIS_PROOF: the workflow emits nothing itself; each close goes through `POST /api/v1/oasis/tasks/:vtid/complete`, which writes `vtid.lifecycle.completed`. Verified on the live ledger: VTID-04633, closed through the same endpoint on 2026-09-26, has `oasis_events` row `topic=vtid.lifecycle.completed, created_at=2026-09-26 14:18:18.27+00`. No new topic is introduced.
