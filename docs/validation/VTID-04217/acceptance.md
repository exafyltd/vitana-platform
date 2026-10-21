# VTID-04217 — Agent executor fix mode: resolve merge conflicts instead of failing on them

## Root cause

When several Dev Autopilot executions run in parallel and touch the same file,
the first PR to merge makes the others `mergeable_state=dirty`. The CI watcher
then fails the row with `merge conflict (dirty)` (or the reconciler with
`PR mergeable_state=dirty`), and — for an agent-executor PR — the self-heal
bridge spawns a fix-mode child (VTID-04017) that clones the PR branch and is
told to make CI pass. That child could not: the tool surface has no git merge,
`run_check` maps only tsc/jest/git_diff/git_status/node_check, and the clone is
`--depth 1 --single-branch`, so there is no merge base to merge across even if
it tried. A conflict was therefore an unrecoverable failure.

Measured on the 2026-09-21 batch of 16 approved executions: 4 (c5a4f0bf →
PR #3515, 9e1c371f → #3518, add20bb2 → #3512, c80751b5 → #3514) failed this
way within minutes of the first sibling merges, and their fix-mode children
(546373b0, 6fd8ed30) started with `merge conflict (dirty)` as their only
evidence.

## Fix

`agent-workspace.ts`
- `mergeBaseIntoBranch(repoDir, baseBranch)` — runs BEFORE the tool loop in
  fix mode: `git fetch --unshallow origin` (plain `fetch origin` when the clone
  is already complete), `git fetch origin <base>`, `git merge --no-edit
  FETCH_HEAD`. Returns `merged` (merge commit on HEAD), `up_to_date`, or
  `conflict` with the unmerged paths; any other merge failure is thrown.
- `listUnmergedFiles`, `textHasConflictMarkers`, `findFilesWithConflictMarkers`.
- `commitAndPush` now commits only when the tree has staged changes — a clean
  auto-merge already put the commit on HEAD and `git commit` would otherwise
  exit 1 with "nothing to commit" and the push would never run.

`agent-prompt.ts`
- `buildFixModeTaskPrompt` gains `mergeBase`; `buildMergeConflictSection`
  renders "Merge conflicts to resolve FIRST" (files, marker explanation, keep
  both intents, never discard the base's side) or "Base branch already merged".

`run-agent-execution.ts`
- Fix mode calls `mergeBaseIntoBranch` right after the clone, records a
  `runner:merge_base` step, uses the merged base SHA for the PR diff, passes
  the outcome into the prompt, exempts a clean merge from the "agent changed
  nothing" refusal (the merge commit IS the change), and after every round
  scans the conflicted + changed files for markers: a remaining marker becomes
  a fix-round prompt, and after the last round a hard failure. A marker can
  never be pushed.

## Acceptance Criteria

AC-1 — `mergeBaseIntoBranch` deepens the clone, fetches the base branch, merges `FETCH_HEAD`, and reports `merged`, `up_to_date` (plain-fetch fallback on a complete clone) or `conflict` with the unmerged paths; a non-conflict merge failure is thrown.
TEST: services/gateway/test/vtid-04217-fix-mode-merge-conflicts.test.ts — the four "mergeBaseIntoBranch (scripted git)" cases (`npx jest services/gateway/test/vtid-04217-fix-mode-merge-conflicts.test.ts`).

AC-2 — `commitAndPush` pushes HEAD without a commit when the tree is clean, and still commits when something is staged.
TEST: services/gateway/test/vtid-04217-fix-mode-merge-conflicts.test.ts — "pushes HEAD without committing when git status is empty" / "still commits when something is staged".

AC-3 — The fix-mode prompt lists conflicted files before the CI evidence, tells the agent to keep both intents and that the runner refuses to push markers; says when the merge was clean; adds nothing when up to date or absent.
TEST: services/gateway/test/vtid-04217-fix-mode-merge-conflicts.test.ts — the three "fix-mode prompt carries the merge outcome" cases.

AC-4 — Conflict markers are detected only at line start, for all three marker kinds.
TEST: services/gateway/test/vtid-04217-fix-mode-merge-conflicts.test.ts — "detects each marker kind at line start only".

AC-5 — Real git: on a shallow single-branch clone of a PR branch whose base diverged on the same line, the merge reports the conflicted file, the marker scan finds it, an edit that removes the markers clears the scan, and `commitAndPush(force:false)` pushes a two-parent merge commit whose tree holds the resolution.
TEST: services/gateway/test/vtid-04217-fix-mode-merge-conflicts.test.ts — "reports the conflict, leaves markers, refuses until resolved, then pushes the merge commit".

AC-6 — Pre-existing fix-mode behaviour (eligibility, child inheritance, flood-guard exemption, escalation) is unchanged.
TEST: services/gateway/test/vtid-04017-fix-mode.test.ts (16 tests, re-run green).

## Verification

- `tsc --noEmit` (services/gateway): clean.
- `test/vtid-04217-fix-mode-merge-conflicts.test.ts`: 11/11.
- `vtid-04017-fix-mode`, `vtid-04032-cancel-running-execution`,
  `vtid-04046-agent-prompt-date`, `autopilot-agent-scope-validate`: 50/50.

## Not verified

No live fix-mode run on this code yet — it needs the executor image rebuilt
from the merge (`AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml`) and a real
`dirty` PR. The three fix-mode children spawned on 2026-09-21 (546373b0,
d2f8af0f, 6fd8ed30) run on the previous image and will still fail on the
conflict; they are the natural first exercise once the image is rebuilt.
