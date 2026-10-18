# Plan — collab-queue-perf
Make `queue.mjs` run in a few seconds again, so a session can read the queue inside its 120 s tool timeout.
<!-- plan:begin -->
## Problem
Every session starts with `node scripts/collab/queue.mjs --repo <vitana-platform> --repo <vitana-v1>` (collaboration.md
§4). On the owner's Windows machine it now runs past the 120 s tool timeout, so sessions start without a queue.

**Measured 2026-10-18 (session kiro-202610181950-f0b7, Windows, git 2.52, after `git fetch --prune`):**

| repo | `collect()` 30 days | `collect()` 3 days | recent branches 30 d / 3 d | spec files on main | claims |
|---|---|---|---|---|---|
| vitana-platform | 37 s | 56 s (cold cache) | 103 / 27 | 40 handoff/lane files (150+ spec files read) | 21 |
| vitana-v1 | 80 s | 18 s | 389 / 46 | 22 | 15 |

Full CLI run with `--days 3`: 149 s. So `--days` is not a fix: vitana-platform's cost does not depend on it.

**Why.** Each `git` call is a separate process, and one spawn costs 0.13–0.4 s here (`git show` 0.24–0.42 s,
`git log -1` 0.13–0.17 s, `git diff` 0.14–0.17 s). `collect()` (`scripts/collab/queue.mjs` ~L247) makes:
- one `git show <main>:<path>` per spec file on main (`consider()` via `showFile()`);
- one `git diff --name-only <main>...<ref> -- .kiro/specs` per remote branch updated within `--days` (389 in vitana-v1);
- one `git show <ref>:<path>` per spec file each branch changed (119 in vitana-platform for 3 days);
- `listClaims()`: one `git log -1 --format=%B` per `collab-claim/*` ref.

Cost grows with branches × spec files, and both keep growing. vitana-v1 also has
`delete_branch_on_merge: false`, so merged PR branches pile up (1,681 remote refs, vs 494 in vitana-platform).

## Goal
1. `queue.mjs` (table, `--json`, `--mine`, `--seat`, `validate`) shows exactly the same rows as today.
2. The number of `git` processes per repo is constant (≤ 6), not proportional to branches, spec files or claims.
3. A two-repo run takes < 10 s on the owner's Windows machine (today: 75–150 s).

## Changes (all in `scripts/collab/queue.mjs`)
1. **One batch reader.** A helper that starts one `git cat-file --batch` process, writes all `<rev>:<path>` (or
   `<sha>`) queries to stdin and parses the replies (`<oid> <type> <size>\n<bytes>\n`, or `<query> missing`).
   Synchronous via `execFileSync(..., { input })`, so `collect()` keeps its signature and stays synchronous.
2. **Main specs.** `specFilesAt(main)` stays one `ls-tree`; their contents come from the batch reader.
3. **Which branch changed which spec file**, in two calls instead of one diff per branch, with the recent refs
   (same `--days` filter on tip committer date as today) on stdin:
   `git rev-list --stdin --not <main> --parents` (the off-main commit graph) and
   `git log --stdin --not <main> --format=%x00%H --name-status -- .kiro/specs` (the spec files each of those
   commits touched). In JS, walk each branch tip through parents inside that set and union the files: that is
   the set of spec files changed on `main..ref`. Read each `(ref, path)` pair in the same batch as step 2.
   Details in `design.md`.
4. **Claims.** `listClaims()` reads the claim commits' messages through the batch reader (`<sha>` queries, parse the
   body after the first blank line) instead of one `git log -1` each.
5. Merge rule unchanged: per path, the newest `updated` wins; main is considered first and wins ties.

**Difference from today, accepted:** `main..ref` (commits) is a superset of `main...ref` (net diff). A file a branch
changed and then reverted is now read too. Its content is the base version, so it is equal to or older than main's
and never wins, except for a file main has since deleted. Then it can reappear as a row. Guard: skip a `(ref, path)`
whose `path` is not on main unless the branch's own commits added it (the walk tells us).

## Not in this plan (owner decision, deletes data on GitHub)
- Turning on "Automatically delete head branches" for `exafyltd/vitana-v1`.
- A one-off delete of remote branches whose PR is merged (never `collab-claim/*`, never a branch with an open PR,
  never a closed-unmerged branch without review).
After this plan they make `git fetch` faster but are no longer needed for the queue.

## Tests
- `scripts/collab/queue.test.mjs`: a fixture repo (temp dir, `git init`, a fake `origin` remote) with main specs,
  three branches (one changing a lane, one changing then reverting, one adding a new spec), an old branch outside
  `--days`, a file deleted on main, and two claim refs. Assert `collect()` output equals the old implementation's
  output (keep the old one in the test as `collectReference`), and assert the git spawn count ≤ 6 per repo by
  wrapping the `git` helper.
- Run `node --test scripts/collab/queue.test.mjs` and the existing `queue.mjs validate` tests.
- Manual timing on the owner's machine: `Measure-Command { node scripts/collab/queue.mjs --repo … --repo … }`
  before and after, recorded in the lane log.

## Lane
- `queue-batch-read`: executor **claude** (governance path `scripts/collab/**`), reviewer `exafy`. Touches the same
  file family as `sparring-floor-retry/floor-retry-code` (PR #4186); the coordinator may build both in one PR.
<!-- plan:end -->
