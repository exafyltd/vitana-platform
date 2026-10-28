# Plan sparring record — VTID-05300 (collab-queue-perf / queue-batch-read)

change class: standard

Plan: `exafyltd/vitana-platform` `.kiro/specs/collab-queue-perf/plan.md` (plan PR #4187, merged to `main`).
CI record: `.kiro/specs/collab-queue-perf/sparring/` (`round-1.md`, `responses-1.md`, `round-2.md`, `responses-2.md`,
`round-3.md`, `state.json`, `verdict.md`).

- Verdict: **CONVERGED** in round 3 (PLAN-SPAR run https://github.com/exafyltd/vitana-platform/actions/runs/39591406007).
- Sparring session: `0793eaa6-86ee-4f43-aae1-b09739830129`.
- Final plan hash: `da595f4918a543b28cb2ae749559cc0711dd6287067b138fa7e71f1b11316543`.
- Owner approval: policy approval `converged-auto-v1` at 2026-10-21T11:22:26.915+00:00 (replaces Gate 1 for a
  CI-sparred plan, collaboration.md §7).
- VTID allocated by CI: VTID-05300 (this lane, queue-batch-read).
- Rounds: R1 4 findings (all accepted), R2 2 findings (both accepted), R3 no findings. Caveat recorded by the partner:
  in round 3 its GitHub reads returned 403, so it verified no new premises that round; rounds 1–2 verified against
  the code.

## Accepted findings and where the lane PR meets them

| finding | what the plan requires | lane PR |
|---|---|---|
| R1-F1 | exported `listClaims(repo)` keeps signature and output; `claim`, `release`, `claims` CLI not edited | `listClaims` = own `for-each-ref` + one `cat-file --batch` via internal `claimsFrom()`; callers unchanged; test: equal to the old implementation, exactly 2 spawns |
| R1-F2 | the off-main walk (`rev-list --parents` + `log --cc --name-status`, DFS through parents in S, deleted-on-main guard) is normative in `plan.md` | implemented as written; `log --cc` keeps a merge commit's own conflict resolutions (combined status, path = last tab field); fixture covers a conflict resolution and an edit made only in the merge commit |
| R1-F3 | budget: `collect()` = 6 with `origin/HEAD`, ≤ 8 without; same count with 3 and 8 branches | tests assert exactly 6, ≤ 8 after `remote set-head -d`, 4 with no recent refs, and 3 vs 8 branches equal |
| R1-F4 | `loadPrograms(repo, ref)` through one `cat-file --batch` after `ls-tree` (2 spawns) | implemented; test asserts 2 spawns and equality with one `git show` per file |
| R2-F1 | `maxBuffer: 256 * 1024 * 1024` on every batch-style call; spawn errors thrown | `BIG_BUFFER = 256 MiB` on `cat-file --batch`, `rev-list`, `log`; those use the throwing `git()`; test reads > 2 MB of spec blobs in full |
| R2-F2 | equality fixture uses the A-status case; a separate, labelled M-status guard fixture is excluded from equality | `kiro/gone/add` (status A, spec deleted on main) is in the equality fixture; the guard has its own test with a comment naming the plan section |
