---
change_class: standard
---
# plan(review-survives-main-merge): a review stays current across a clean merge of main
Author: Kiro, seat `hotmail`, session `kiro-hotmail-202611010146-1707` (Kiro IDE, workflow `wf_c66636d402deaa3e`,
owner backlog-cleanup task 2026-10-28: "move ahead, you can review and you can decide"). Code repo:
`exafyltd/vitana-platform`. Premises pinned to vitana-platform `origin/main` `601cc2c3e8` and vitana-v1 `origin/main`
as fetched 2026-11-01. Detail: `tasks.md`; lane file under `lanes/`.
<!-- plan:begin -->
## Goal
A reviewer-agent accept on head R keeps counting at a later head H when every commit between them is either an
entry-only commit that §3 already allows, or a **clean merge of `main`**: a merge whose second parent is on
`origin/main`, that needed no conflict resolution, that changes no protected gate file, and after which the PR's own
diff is byte-identical to its diff at R. Required checks must still be green on H (unchanged), so CI stays the safety
net for semantic conflicts. Rebases, conflict resolutions and anything that changes the PR's own diff still need a new
review. Enforced by `land-guard.mjs` on the plan driver's merge path; the Project Manager stays stricter for now
(premise 5).

## Today (evidence, read-only)
1. **The rule.** `.claude/rules/collaboration.md:101-104` (§3, "Review entry"): an entry counts for the current head
   when `Collab-Reviewed-Head` equals the PR head, "or every commit after it only appends review entries to this lane
   file (front matter unchanged) or is a `pm-agent` lane-state commit". A merge of `main` is neither, so it voids the
   review.
2. **The PR must be up to date to merge.** §7b (`collaboration.md:259`): "the PR is up to date with latest `main` and
   its checks were re-run on that head"; §8a item 3 (`collaboration.md:348`): serialized landing. `land-guard.mjs`
   `mergeDecision` (`scripts/collab/land-guard.mjs:82-89`) refuses `behindBy > 0`.
3. **The enforcement.** `land-guard.mjs` `reviewCurrent` (`:41-55`) checks every commit in `after`; `afterCommits`
   (`:120-125`) builds `after` from `GET compare/<reviewed>...<head>`, which lists every commit reachable from head and
   not from the reviewed head, i.e. after a merge of `main` it also lists **all of main's commits brought in** plus
   the merge commit. Each fails the entry-only test, so `review` and `merge` refuse with "a new review is needed".
4. **Observed cost (2026-10-31 / 11-01).** platform #4533 needed 4 reviewer runs for one unchanged 10-file diff;
   platform #4531 needed 2; vitana-v1 #1528, #1529, #1531 and #1532 were each voided by one merge of `main`. Each
   cycle costs one reviewer run plus a full CI pass behind a CI backlog of 60+ minutes. In a busy repo every merge to
   `main` voids the review of every waiting PR, so the serialized landing of §8a re-reviews O(n²) times.
5. **The Project Manager mirrors the rule separately.** `services/gateway/src/services/project-manager/governance.ts`
   `reviewOnCurrentHead` (protected gate file) accepts `pr.review_only_since`, which
   `observe-live.ts` `reviewOnlySince` computes from `pulls/<n>/commits` and stops at the first commit that is not a
   review/pm-agent entry. It stays stricter than the new rule (a merge commit ends the walk). Stricter is safe: it can
   only ask for a review that land-guard would no longer need; it cannot merge anything land-guard refuses. The PM
   reads GitHub only (no checkout), so it cannot run `git merge-tree`; mirroring the rule there is a separate design.
   **Scope of the gain:** the re-review saving applies to merges made by the plan driver through `land-guard.mjs merge`
   (`.kiro/pipeline/lane-land.md` step 3d, the path every Kiro merge of this backlog used, premise 4). On the PM path
   a merge of `main` still voids the review until the follow-up (Out of scope). §3 says so explicitly (Change 5).
5a. **The pipeline text already expects this.** `.kiro/pipeline/lane-land.md:37-38` (step 3d): "if behind, `gh pr
   update-branch <n>` (no force); clean → keep the accept (log: only `main`'s commits added)", then
   `land-guard.mjs merge --gh … --pr … --reviewed-head …`. `land-guard.mjs` refuses that kept accept (premise 3), so
   step 3d and the guard disagree today. Step 3d is the only caller of `land-guard.mjs merge` (`git grep` over
   `.kiro .claude scripts .github docs`); no caller runs `land-guard.mjs review` with arguments.
6. **Protected gate files.** `scripts/collab/protected-gate-files.json` on `origin/main` lists neither
   `.claude/rules/collaboration.md` nor `scripts/collab/land-guard.mjs`; both are governance paths (§3a). The owner's
   task for this plan states that **`collaboration.md` and `land-guard.mjs` are protected gate files for this plan and
   need the owner's instruction naming this plan** (`review-survives-main-merge`) plus a reviewer-agent accept on the
   current head before merge; the parent session merges the plan PR and the lane PR with that instruction, never on a
   reviewer accept alone. Because neither path is in the JSON list, `queue.mjs` lane validation allows
   `executor: kiro` for the lane with `reviewer_seat: agent:vitana-lane-reviewer` (the governance-path rule). This plan does not add them to the JSON list (out of scope, below).
7. **vitana-v1 mirror.** vitana-v1 `origin/main:.claude/rules/collaboration.md` is **not** byte-identical to the
   platform file (SHA-256 differs; `git diff --no-index --stat`: 3 insertions, 13 deletions outside §3). Its §3
   paragraph is at line 104. Per the task's condition, the rule text is not mirrored into vitana-v1 by this plan;
   `land-guard.mjs` (platform) is what checks vitana-v1 PRs too (`--gh exafyltd/vitana-v1`), so the behaviour applies
   to both repos.
8. **Git version.** The rule needs `git merge-tree --write-tree` (Git ≥ 2.38). The local Kiro IDE has 2.52; GitHub's
   `ubuntu-latest` image ships a newer Git than 2.38.

## Change (lane `land-guard-merge`, vitana-platform)
1. **`land-guard.mjs`: a pure decision for a merge commit.**
   `mergeKeepsReview({ parents, secondParentOnMain, autoMergeTree, commitTree, protectedFiles })` → `{ ok, reason }`.
   `ok` only when: exactly two parents; `secondParentOnMain` (`git merge-base --is-ancestor <p2> origin/main`);
   `autoMergeTree === commitTree`, where `autoMergeTree` is `git merge-tree --write-tree <p1> <p2>` and the command
   exited 0 (exit 1 = conflicts → not ok; a different tree = manual resolution or extra edits → not ok);
   `protectedFiles` is empty, where `protectedFiles` = the files changed `p1..merge` that match
   `PROTECTED_GATE_PATHS` **or `GOVERNANCE_PATHS`** (both exported by `queue.mjs`; `GOVERNANCE_PATHS` at
   `queue.mjs:85` = `.github/**`, `.claude/**`, `.kiro/steering/**`, `.kiro/automations/**`, `scripts/collab/**`,
   `CLAUDE.md`, `docs/programs/areas.yaml`, so it covers `collaboration.md` and `land-guard.mjs`), matched with
   `protectedTouched`. A merge of `main` that brings in any governance or protected gate file change therefore voids
   the review exactly as today. An octopus merge, a merge of a branch that is not `main`, or such a merge is refused
   with a reason naming the condition.
2. **`reviewCurrent` accepts the new commit kind.** Each `after` entry may carry `merge: {…}` (the facts of change 1)
   and the call gets `prDiffSame` (change 3). A commit with `merge` is allowed when `mergeKeepsReview` is ok **and**
   `prDiffSame === true`; every other commit keeps today's entry-only test unchanged. The `ok` reason names both kinds
   ("only lane-file entries and clean merges of main after the reviewed head").
3. **PR-diff identity.** `prDiffSame` = the set of paths and the bytes of
   `git diff --full-index --binary <merge-base(origin/main, R)> R -- <paths>` equal those of
   `git diff --full-index --binary <merge-base(origin/main, H)> H -- <paths>`, where `<paths>` is the union of the
   paths each diff changes, minus this lane's own lane file and handoff (the entry-only commits of §3). If `main`
   touched a PR file, the diff (context or hunk offsets) changes and a new review is needed, as the task requires.
4. **The commit walk is local and first-parent.** `afterCommits` gains a local path: with `--repo <dir>`, land-guard
   fetches `origin main` and `refs/pull/<n>/head`, requires `R` to be an ancestor of `H` (a rebase or force-push
   fails here, as today), walks `git rev-list --first-parent --parents R..H` (so main's own commits brought in by a
   merge are not in `after`), and for each commit collects its files (`git diff-tree --no-commit-id --name-only -r
   <p1> <c>`), the `Collab-Session` trailer and, for a merge, the facts of change 1. Without `--repo` the GitHub-API
   path stays exactly as today (a merge commit fails the entry-only test), so a caller that cannot supply a checkout
   is never more permissive than now. `--repo` is accepted by `review` and `merge`; the usage line and header comment
   name it. The `merge` command keeps reading checks, `behind_by` and the PR's files from GitHub as today.
4a. **The caller passes `--repo`** (lane `lane-land-repo`). `.kiro/pipeline/lane-land.md` step 3d (`:38`), the only caller (premise 5a), becomes
   `node <vitana-platform>/scripts/collab/land-guard.mjs merge --gh <owner/repo> --repo <checkout of that repo>
   --pr <n> --reviewed-head <Collab-Reviewed-Head> --title "<title>" --wait 3600`, and its "clean → keep the accept"
   clause says the accept is kept only when `land-guard` reports it current (a clean merge of `main` per §3). The
   `<checkout>` is the session's clone of `<owner/repo>` (vitana-platform or vitana-v1); land-guard checks that its
   `origin` URL names `<owner/repo>` and refuses otherwise. A CLI test runs `review --repo` against a fixture whose
   `origin` is a local bare repo with a `refs/pull/1/head` ref and a stub `gh` on `PATH` (prints the PR JSON), so the
   path from the CLI flag to `localAfter` is exercised (that test and the origin check are in lane
   `land-guard-merge`).
5. **`collaboration.md` §3** (`:103-104`), the "current head" sentence becomes: an entry counts for the current head
   when `Collab-Reviewed-Head` equals the PR head, or every commit after it either only appends review entries to
   this lane file (front matter unchanged), is a `pm-agent` lane-state commit, or is a **clean merge of `main`**: a
   two-parent merge whose second parent is on `origin/main`, whose tree equals Git's automatic merge of its parents
   (no conflict resolution, no extra edits), that changes no protected gate file, and after which the PR's own diff
   (`git diff <merge-base> <head>` over the PR's paths) is byte-identical to its diff at the reviewed head. A rebase,
   a conflict resolution or any change to the PR's own diff needs a new review; required checks must be green on the
   final head; a merge that brings in a change to a governance path or protected gate file (§3a) still needs a new
   review. `land-guard.mjs review|merge --repo` enforces it for merges by the plan driver; the Project Manager does
   not apply the clean-merge clause yet, so on the PM path a merge of `main` still needs a new review (premise 5).
   §3 only; §7b and §8a are unchanged.
6. **Tests** (`scripts/collab/land-guard.test.mjs`, `node:test`, temp-dir git fixtures in the style of the existing
   CLI tests; no network): pure tests of `mergeKeepsReview` for each condition, and fixture tests through a new
   exported `localAfter(repo, reviewed, head, laneKey)` + `reviewCurrent`:
   - (a) accept at R, `main` advances on an unrelated file, PR merges `main` cleanly → **ok** (red on base: today's
     `reviewCurrent` refuses the merge commit);
   - (b) `main` changes a file the PR also changes (no conflict) and the PR merges it → refused, PR diff changed;
   - (c) `main` and the PR conflict, the merge resolves it by hand → refused, not Git's automatic merge;
   - (d) a clean merge that also edits a file in the merge commit → refused (tree differs);
   - (e) `main` changes `CLAUDE.md` and the PR merges it → refused, protected gate file; (e2) `main` changes
     `.claude/rules/collaboration.md` (a governance path, not in the JSON list) → refused;
   - (f) the PR merges a branch that is not on `main` → refused;
   - (g) the PR is rebased onto `main` after R → refused (R not an ancestor);
   - (h) a clean merge followed by a review-entry commit on the lane file → ok; followed by a code commit → refused;
   - (i) the existing API-path tests stay byte-identical and green;
   - (j) CLI: `review --gh o/r --repo <fixture> --pr 1 --reviewed-head R` with the stub `gh` exits 0 for case (a)
     and 1 for case (c); with an `origin` URL that does not name `o/r` it exits 1.
   Red-to-green: (a) and (h-ok) fail on `origin/main` (no `localAfter`/`mergeKeepsReview` export, and the merge
   commit is refused); all pass on the lane head; `node --test scripts/collab/*.test.mjs` stays green.

## Lanes
- `land-guard-merge` (vitana-platform, `executor: kiro`, seat `exafy`, area `platform` from `docs/programs/areas.yaml`
  — `scripts/**`): changes 1–6 and `docs/validation/<VTID>/**`. `depends_on: []`. Paths:
  `scripts/collab/land-guard.mjs`, `scripts/collab/land-guard.test.mjs`, `.claude/rules/collaboration.md`,
  `docs/validation/VTID-*/**`.
- `lane-land-repo` (vitana-platform, `executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer`, seat `exafy`,
  area `platform`): change 4a only, paths `.kiro/pipeline/lane-land.md`, `docs/validation/VTID-*/**`.
  `depends_on: [land-guard-merge]` (the `--repo` flag must be on `main` before the pipeline text uses it). A separate
  lane because a `_plan` commit may create a lane file but not edit one (`queue.mjs` handoff check). Merge: the owner's instruction naming this plan plus a reviewer-agent accept on the
  current head (premise 6); the parent session merges.

## Out of scope
- The Project Manager's `observe-live.ts` `reviewOnlySince` and `governance.ts` (protected): they stay stricter
  (premise 5) and §3 says so. Follow-up plan `pm-review-survives-main-merge` (the PM has no checkout, so it needs its
  own design for the conflict check) once this rule has run on real PRs; tracked in this plan's handoff.
- Adding `collaboration.md` or `land-guard.mjs` to `protected-gate-files.json`.
- vitana-v1 `collaboration.md` (not byte-identical, premise 7).
- Rebases, squash-and-force-push updates, GitHub's "Update branch" with rebase: all still need a new review.
- Any change to §7b/§8a (the PR must still be up to date and green on its final head).

## Test plan
- Lane: `node --test scripts/collab/land-guard.test.mjs` fails on `origin/main` for the new cases (output in
  `docs/validation/<VTID>/red-on-base.txt`) and passes on the lane head; `node --test scripts/collab/*.test.mjs`
  green; commands in `docs/validation/<VTID>/commands.log`.
- CI: the PR's required checks green on its head (incl. Lane scope, Collab handoff).
- Staging: nothing deploys (`scripts/collab/**` and `.claude/rules/**` are not in any deploy path); the change is done
  when merged with green checks. If STAGING-TESTS-REQUIRED asks for it, `docs/validation/<VTID>/staging-tests.json`
  with one `kind: "existing"` test, `ref: "node --test scripts/collab/land-guard.test.mjs"`, reason "tooling-only
  change, nothing deploys". No suite targets production.
<!-- plan:end -->
