# Plan sparring record — VTID-05076

- Sparring id: `plan_sparring_sessions` `b080a424-fa23-456e-b078-36eb16c93488`
- Plan hash (sha256 of the text between the plan markers): `2db99d1e64128c616f5639654e652b07690f7bd9efd057aa6b1b56f17607ac78`
- Change class: light · producer: claude-code · partner: plan-sparring-partner (independent, read-only) · 2 rounds · verdict **CONVERGED**
- **Owner approval:** 2026-10-12, Claude Code session https://claude.ai/code/session_019XRHThojRVzYPDzoLtuby6 — "yes" (Gate 1, together with VTID-05077's plan)

# Plan — STAGING-VERIFY judges each merged change by its first-parent commit

<!-- plan:begin -->
## Change class
light (CI tooling, one function + tests, no runtime code, no deploy).

## Problem (verified on main 97bfacc1)
- `scripts/ci/staging-verify/run.mjs:134-145` `commitsBetween()` lists the production→verified range with `git log --reverse <prod>..<sha>` (no `--first-parent`) and takes each commit's files from `git show --name-only --format= <sha>`. `lib.cjs:200-212` `planRange()` then requires a VTID in every listed commit's subject (rule 47 bucket `missing`).
- Every PR on main has been squash-merged (one first-parent commit whose subject is the PR title with its VTID; validate-pr enforces the VTID in the title) — except VTID-05072's #4037/#4038/#4039, merged with merge commits. That put the branch's own commits on main; one of them, `9358d991` "chore(gateway): sync pnpm-lock.yaml with acorn 8.15.0 devDependency", has no VTID. Its subject is permanent, so STAGING-VERIFY for every later commit fails rule 47 forever, although its change is part of PR #4037 (`a294dad5`, "VTID-05072: … (#4037)").
- `git show --name-only` on a merge commit uses the combined diff: it lists only conflict-resolved files (nothing for a clean merge), so a merge commit's PR files would be missed by `touchesService`.

## Change
1. `commitsBetween()` moves from `run.mjs` into `lib.cjs` (exported, takes a `git(args)` runner), and `run.mjs` calls it from there. It lists `git log --first-parent --reverse <prod>..<sha>`: one entry per change that landed on main (a squash commit, a direct push, or a PR merge commit). Branch-internal commits are judged through the merge commit that brought them in.
2. Files for each listed commit: `git diff --name-only <sha>^1 <sha>` (first-parent diff). For a non-merge commit this equals today's `git show --name-only`; for a merge commit (octopus included) it is everything the merge brought into main.
3. Nothing else changes: `planRange()`, `extractVtids()`, the enforce date, and the suite lookup are untouched (the ready message changes only as item 5 says). A direct push to main without a VTID is still a first-parent commit and still lands in `missing`.
4. Tests in `scripts/ci/staging-verify/lib.test.cjs` (the file `STAGING-TESTS-REQUIRED.yml` already runs with `node --test`), against temp git repos built in the test (`git init`, commits, `git merge --no-ff`) and the real `commitsBetween` from `lib.cjs`: (a) squash history → identical result to today; (b) merge-commit PR whose merge subject has a VTID and whose branch has a VTID-less commit → no `missing`, suite of that VTID runs, files = PR's files; (c) direct VTID-less push → still `missing`; (d) merge commit whose subject has no VTID → `missing`.
5. Ready message (rule 49): each listed entry is one change that landed on main; for a merge commit the entry adds "(N branch commits)" so the count of underlying commits stays visible. The full first-parent range is still every change between production and the verified commit.
6. Process: PRs are normally squash-merged but GitHub does not enforce it; the check now handles both, and the Kiro IDE instructions ask for squash merges.

## Out of scope
Any SHA allowlist or exemption list; rewriting main; deploying with a red STAGING-VERIFY.

## Verification
Unit tests above; after merge, STAGING-VERIFY re-run on main must list a294dad5/3743dff5/97bfacc1 (+ this fix's own commit) and pass rule 47 with VTID-05072's suite.
<!-- plan:end -->

## Planner responses — round 1
- F1 minor — ACCEPTED: premise reworded (combined diff lists only conflict-resolved files).
- F2 minor — ACKNOWLEDGED: the `~1` fallback stays; with --first-parent it is still one commit; unreachable today.
- F3 minor — ACCEPTED: item 5 — each entry is one landed change, merge entries show "(N branch commits)".
- F4 major — ACCEPTED: `commitsBetween` moves to `lib.cjs` (exported, injectable git runner); tests in `lib.test.cjs` on temp git repos with real merges.
- F5 minor — ACCEPTED: octopus merges noted in item 2.
- F6 minor — ACCEPTED: item 6 reworded (not enforced by GitHub; handled either way).
- Q1: extract to lib.cjs, test in lib.test.cjs. Q2: only `commitsBetween` changes; `isAncestor`/`describeBaseline` unchanged.

## Sparring verdict
Round 1: 1 major, 5 minors. Round 2: all closed, no new findings. Verdict: CONVERGED (2 rounds, light).


## Partner findings (verbatim)

### Round 1

I now have enough information to produce my round-1 review.

## Verified premises

- **"commitsBetween() at run.mjs:134-145 uses `git log --reverse` without `--first-parent` and `git show --name-only --format=` for files"** → TRUE — `/home/user/vitana-platform/scripts/ci/staging-verify/run.mjs:135-145`. The log call at line 137 has no `--first-parent`, and the file list at line 143 uses `git show --name-only --format=`.

- **"planRange() at lib.cjs:200-212 requires a VTID in every listed commit's subject (rule 47 bucket `missing`)"** → TRUE — `/home/user/vitana-platform/scripts/ci/staging-verify/lib.cjs:198-229`. Lines 206-211 show that a commit with `vtids.length === 0` is pushed to `missing` (if post-enforce) or `legacy`, and `decideOutcome` at line 328 fails on `plan.missing.length > 0`.

- **"git show --name-only on a merge commit prints nothing by default (combined diff)"** → PARTIAL — `/home/user/vitana-platform/scripts/ci/staging-verify/run.mjs:143`. `git show --name-only` on a merge defaults to combined diff, which lists only files that differ from ALL parents (i.e., conflict-resolved files). For a clean merge (no conflicts), the output is indeed empty. For a merge with resolved conflicts, it would list the conflicted files. The plan's statement is accurate for the typical case but slightly imprecise.

- **"The workflow checks out with fetch-depth: 0 (full clone)"** → TRUE — `/home/user/vitana-platform/.github/workflows/STAGING-VERIFY.yml:143` (gateway) and line 153 (community-app) both have `fetch-depth: 0`. This means `--first-parent` and `<sha>^1` will have full history available.

## Findings

**F1 [minor] The plan claims `git show --name-only` "prints nothing" for merge commits; it prints nothing only for clean (no-conflict) merges.**

Evidence: `git show --name-only` uses combined diff, which shows files modified relative to ALL parents. For a conflict-free merge this is empty; for a merge with resolved conflicts it lists those files. The plan's fix (`git diff --name-only <sha>^1 <sha>`) is correct either way, but the stated premise is imprecise.

Suggestion: Reword to "prints only conflict-resolved files (empty for a typical clean merge)" or just drop the detailed explanation and say the combined-diff default omits most/all of the PR's files.

**F2 [minor] The fallback range `${toSha}~1..${toSha}` with `--first-parent` works correctly but the plan does not call out why.**

Evidence: `/home/user/vitana-platform/scripts/ci/staging-verify/run.mjs:136`. When `fromSha` is null, the range is `${toSha}~1..${toSha}`. With `--first-parent` added, `~1` follows the first parent, producing a single-commit range. This is correct, but the fallback path is only reached when `describeBaseline` returns `rangeFrom: null`, and in every such case (`same`, `ahead`, `unknown`, `missing`, `diverged`) the caller at line 324 sets `commits = []` and never calls `commitsBetween`. So the fallback path is effectively dead code. No bug, but noting it.

Suggestion: No action needed; just an observation that the fallback path cannot be reached in the current flow. The plan's change is still safe for it.

**F3 [minor] Rule 49 says "every commit between production and the verified commit" -- the ready message's shipping list will shrink.**

Evidence: CLAUDE.md rule 49: *"with the verified commit, what passed, and every commit between production and the verified commit"*. With `--first-parent`, branch-internal commits (like the VTID-less `9358d991`) are hidden behind their merge commit. The "What would ship" section at `/home/user/vitana-platform/scripts/ci/staging-verify/lib.cjs:374-380` iterates `shipping` (filtered from `commits`), so the list shortens from N total commits to N first-parent commits.

Suggestion: This is arguably a better representation (each entry = one landed change, with its full file diff), and the merge commit subject carries the PR title with the VTID. But the plan should explicitly acknowledge the shipping-list change and state that each first-parent entry represents the full PR, satisfying rule 49's intent. If the owner considers the literal reading binding, a footnote "(N branch commits via this merge)" could be added per merge entry.

**F4 [major] The plan does not address `commitsBetween`'s current untestability -- the git-shelling function lives in `run.mjs` (ESM, not exported) and cannot be unit-tested without refactoring it out.**

Evidence: `commitsBetween` is defined at `/home/user/vitana-platform/scripts/ci/staging-verify/run.mjs:135` as a file-local function in an ESM module. The existing tests in `lib.test.cjs` test `planRange` with mock commit arrays -- they never exercise the actual git commands. The plan says "Tests in `scripts/ci/staging-verify/lib.test.cjs` (or a new `run.test.mjs` on a temp git repo)" but does not commit to which approach. The scenarios (a)-(d) require a real git repo with merge commits, squash commits, etc. -- these cannot be tested with mock data.

Suggestion: Commit to the "new `run.test.mjs` on a temp git repo" approach. Either (1) extract `commitsBetween` into `lib.cjs` so it can be tested with the existing CommonJS test harness and a temp git repo fixture, or (2) create `run.test.mjs` (ESM) that builds temp repos with `git init`/`git commit`/`git merge` and calls the extracted function. Option (1) is simpler and matches the existing pattern. The plan should name which one.

**F5 [minor] The plan does not mention octopus merges (3+ parents).**

Evidence: An octopus merge on main (rare but possible from `git merge A B C`) would be a first-parent commit with `^1` pointing to the prior main commit. `git diff --name-only <sha>^1 <sha>` would show everything all branches brought in, which is correct. `--first-parent` still walks past it properly.

Suggestion: No code change needed; just note in the plan that octopus merges are handled correctly by the same `^1` diff (everything merged is shown, which is the desired behavior).

**F6 [minor] The plan says "PRs are squash-merged (the repo's existing convention)" but VTID-05072 proves that convention is not enforced at the GitHub level.**

Evidence: The plan's own problem statement says VTID-05072's PRs were merge-committed, not squash-merged. There is no branch-protection setting enforcing squash-only merges. The fix handles this correctly (that is the point), but the plan's statement 5 implies a convention that is already broken and could break again.

Suggestion: Remove the "convention" statement or reword it to "PRs are normally squash-merged, but the repo does not enforce this; the fix handles both merge-commit and squash-commit PRs."

## Questions for the planner

1. The plan says tests will go in `lib.test.cjs` or a new `run.test.mjs`. Since `commitsBetween` shells out to git and needs a real repo, will you extract it into `lib.cjs` (testable from the existing CJS harness) or create a separate ESM test file? This matters for CI integration since `STAGING-TESTS-REQUIRED.yml` currently runs `node --test scripts/ci/staging-verify/lib.test.cjs`.

2. Does the plan intend to add `--first-parent` only to the `git log` call in `commitsBetween`, or also anywhere else (e.g., the `isAncestor` check, `describeBaseline` flow)? I believe only `commitsBetween` needs it, but want to confirm.

## Verdict

NOT CONVERGED -- F4 is a major finding. The test strategy needs to be concrete: either commit to extracting `commitsBetween` into `lib.cjs` or commit to a new ESM test file with temp-repo fixtures. The remaining findings are minor and can be acknowledged in a revision without plan changes.

---

### Round 2

Good. `ubuntu-latest` has `git` pre-installed, and the checkout uses `fetch-depth: 0`. The temp-repo tests will work fine in CI.

## Verified premises
- F1 claim reworded → TRUE — plan line 10 now says "combined diff: lists only conflict-resolved files (nothing for a clean merge)"
- F4 fix (extract to lib.cjs) → plan item 1 (line 13) commits to `lib.cjs` with injectable git runner, tests in `lib.test.cjs`
- STAGING-TESTS-REQUIRED.yml runs on `ubuntu-latest` with `fetch-depth: 0` → `/home/user/vitana-platform/.github/workflows/STAGING-TESTS-REQUIRED.yml:27-28,33` — `git` is available, full history present, temp-repo creation will work

## Findings

- F1 [minor] premise wording → **closed** (reworded accurately at plan line 10)
- F2 [minor] dead fallback path → **closed** (acknowledged, no action needed)
- F3 [minor] rule 49 shipping list shrinks → **closed** (item 5 adds "(N branch commits)" annotation per merge entry; the full first-parent range satisfies rule 49's intent)
- F4 [major] commitsBetween untestable → **closed** (accepted: extracted to lib.cjs with injectable git runner, temp-repo tests in lib.test.cjs, same CI file)
- F5 [minor] octopus merges → **closed** (noted in item 2)
- F6 [minor] squash convention not enforced → **closed** (item 6 reworded)

No new blockers or majors introduced by the revision. The injectable git runner pattern is clean, the CI environment supports temp-repo tests, and the "(N branch commits)" annotation addresses rule 49 without bloat.

## Questions for the planner

None.

## Verdict

CONVERGED