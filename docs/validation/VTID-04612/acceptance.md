# VTID-04612 — operator PRs merge while main keeps moving

Observed 2026-09-26 on staging: main took a merge every 5-10 minutes. The
VTID-04379 rule brought every green operator PR up to date on each of those
merges, re-ran ~8 minutes of CI, and gave up after 5 updates. PR #3726
(VTID-04597) reached update 3 of 5 within 20 minutes without merging.

Rule now: a PR whose GitHub state is `clean` and that is behind main merges on
its green CI when the commits main gained touch none of its files. Overlap, a
truncated compare, an unknown PR file list, a failed lookup, or the `behind`
state (strict branch protection) keep the branch-update path.

## Acceptance criteria

AC-1: `canMergeBehindWithoutUpdate` merges only on a complete, non-overlapping file comparison.
TEST: services/gateway/test/vtid-04612-merge-behind-without-update.test.ts

AC-2: the watcher runs the overlap check only for a clean PR, before the update step, and falls back to updating on any error.
TEST: services/gateway/test/vtid-04612-merge-behind-without-update.test.ts

AC-3: end to end over the in-memory platform, a PR behind main with no shared files merges without an update-branch call; with a shared file it is updated and not merged (rule 42f scenario, mutation-checked).
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

AC-4: the VTID-04379 behaviour is unchanged when no overlap check applies.
TEST: services/gateway/test/vtid-04379-branch-up-to-date.test.ts
