# VTID-05438 acceptance (review-survives-main-merge/land-guard-merge, tasks.md T1-T5)
Change types: Tooling/CI (collab script, its tests, one rule sentence, validation records).
Red-on-base output: `red-on-base.txt`. Command log: `commands.log`.

AC-1 `mergeKeepsReview` refuses an octopus or single-parent commit, a second parent not on `origin/main`, a merge
with conflicts (`git merge-tree --write-tree` exit 1), a tree that differs from Git's automatic merge, and a merge
that brings in a governance path or protected gate file; each reason names the condition.
TEST: node --test scripts/collab/land-guard.test.mjs ("mergeKeepsReview: each condition is checked and named")
AC-2 `reviewCurrent` accepts a merge commit only when `mergeKeepsReview` is ok and `prDiffSame === true`; every other
commit keeps the entry-only test; the ok reason names "clean merges of main".
TEST: node --test scripts/collab/land-guard.test.mjs ("reviewCurrent: a merge commit counts only when ...")
AC-3 `localAfter` walks `reviewed..head` first-parent in a local checkout and computes the PR-diff identity:
(a) clean merge kept, (b) main touched a PR file refused, (c) hand-resolved conflict refused, (d) extra edit refused,
(e/e2) `CLAUDE.md` and `.claude/rules/collaboration.md` refused, (f) non-main branch refused, (g) rebase refused,
(h) merge + review entry kept, then a code commit refused.
TEST: node --test scripts/collab/land-guard.test.mjs ("local walk (a)" ... "local walk (h)")
AC-4 `review`/`merge --repo <checkout>` use the local walk after checking that `origin` names `--gh`; without
`--repo` the GitHub-API walk is unchanged (existing tests unchanged and green); exit codes unchanged.
TEST: node --test scripts/collab/land-guard.test.mjs ("CLI (j)", POSIX only: runs on CI ubuntu, skipped on win32)
AC-5 `collaboration.md` §3 "current head" sentence carries the clean-merge clause, the governance-path sentence and
the PM-path sentence; no other section changes.
TEST: git diff origin/main -- .claude/rules/collaboration.md (one hunk, §3)

Outcome: an accept survives a clean, conflict-free merge of `main` that leaves the PR's own diff byte-identical and
changes no governance or protected gate file. States/Surfaces/Locales/Accessibility: n/a (no UI or runtime change).
Staging proof: nothing deploys; covering test is `scripts/collab/land-guard.test.mjs`. No test skipped or loosened.
