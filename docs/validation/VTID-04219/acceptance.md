# VTID-04219 — Fix `main`: two independently-green Dev Autopilot merges broke each other

## Root cause

On 2026-09-21 the Dev Autopilot watcher auto-merged PR #3508 (VTID-04185,
execution e1fa489e: a test asserting the bootstrap pack renders exactly 8
"(unavailable: …)" content lines when every source fails) and PR #3513
(VTID-04175, execution e39f056a: a new static
`OPERATOR_THREADS_ENABLED=… , OPERATOR_TURN_MEMORY_ENABLED=…` line in the same
pack). Each PR's CI ran against the `main` it was opened from and was green;
merged together, the pack renders 9 lines and
`test/console-task-21-bootstrap-all-sources-fail.test.ts` fails on `main`
(`Expected length: 8, Received length: 9`), which turns the
`Gateway (Jest, ~7.5k tests)` check red on every subsequent PR (#3521 was the
first to hit it).

This is a semantic conflict, not a textual one: git merged both cleanly and
the watcher's 30-second re-check only re-reads the PR's own CI. The pipeline
has no "branch must be up to date with main" or merge-queue step — recorded
as an improvement item in the Operator Console recovery report.

## Fix

The test's content-line filter now also excludes the flag-state line, which
is rendered from process env (never fetched) and therefore can never be an
"unavailable" line — exactly the class of line the filter already excluded
for the tool catalog. The 8-line assertion and the "every remaining line is
unavailable" assertion both hold again. No production code changes.

## Acceptance Criteria

AC-1 — The all-sources-fail suite passes on current `main` with VTID-04175's flag line present.
TEST: services/gateway/test/console-task-21-bootstrap-all-sources-fail.test.ts — "assembles a string, one unavailable line per failure, under the byte cap" (`npx jest services/gateway/test/console-task-21-bootstrap-all-sources-fail.test.ts`).

AC-2 — VTID-04175's own coverage still passes.
TEST: services/gateway/test/console-task-12-bootstrap-flag-visibility.test.ts (re-run green).

## Verification

- Reproduced locally on `main`: 1 failed / 1 passed before the fix.
- After: both suites green (see commands.log).

## Not verified

Nothing beyond CI — this is a test-only reconciliation.
