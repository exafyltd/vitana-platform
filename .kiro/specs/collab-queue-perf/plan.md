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
1. `queue.mjs` (table, `--json`, `--mine`, `--seat`, `validate`) shows exactly the same rows as today, except the
   one case named in "Difference from today".
2. The number of `git` processes per repo is constant, not proportional to branches, spec files, claims or
   programmes: `collect()` ≤ 8 (6 when `origin/HEAD` is set; see the budget below), `loadPrograms()` 2,
   standalone `listClaims()` 2. A CLI `queue` run is ≤ 10 per repo.
3. A two-repo run takes < 10 s on the owner's Windows machine (today: 75–150 s).

## Changes (all in `scripts/collab/queue.mjs`)
1. **One batch reader.** A helper that starts one `git cat-file --batch` process, writes all `<rev>:<path>` (or
   `<sha>`) queries to stdin and parses the replies (`<oid> <type> <size>\n<bytes>\n`, or `<query> missing`).
   Synchronous via `execFileSync(..., { input })`, so `collect()` keeps its signature and stays synchronous.
   **Every batch-style call sets `maxBuffer: 256 * 1024 * 1024`** (the Node default of 1 MB is exceeded by
   vitana-platform's 150+ spec files): the `cat-file --batch` reader returns a Buffer (`encoding: 'buffer'`, sizes
   are bytes), and the `rev-list --parents` and `log --cc --name-status` calls of step 3 use the same limit. An
   `ENOBUFS` or other spawn error is thrown, never swallowed as "no data".
2. **Main specs.** `specFilesAt(main)` stays one `ls-tree`; their contents come from the batch reader.
3. **Which branch changed which spec file**, in two calls instead of one diff per branch, with the recent refs
   (same `--days` filter on tip committer date as today) on stdin:
   `git rev-list --stdin --not <main> --parents` (the off-main commit graph) and
   `git log --stdin --not <main> --format=%x00%H --name-status -- .kiro/specs` (the spec files each of those
   commits touched). In JS, walk each branch tip through parents inside that set and union the files: that is
   the set of spec files changed on `main..ref`. Read each `(ref, path)` pair in the same batch as step 2.
   **The walk, exactly** (also in `design.md`; this block is normative):
   - `rev-list --stdin --not <main> --parents` (no pathspec, so parents are not rewritten) prints one line per
     off-main commit reachable from any recent tip: `<sha> <parent>…`. Build `parents: Map<sha, sha[]>`; its keys
     are the off-main set `S`.
   - `log --stdin --not <main> --cc --format=%x00%H --name-status -- .kiro/specs` prints, per off-main commit that
     touched a spec file, `\0<sha>` then `<status>\t<path>` lines (`--cc` keeps a merge commit's own conflict
     resolutions; a combined status has one letter per parent; the path is the last tab field). Build
     `touched: Map<sha, Map<path, statuses>>`.
   - Per recent ref: if its tip is not in `S` (already on main), it changed nothing — same as today's empty diff.
     Otherwise depth-first from the tip, visiting each sha once, following only parents in `S`; union
     `touched.get(sha)` over the visited commits. Paths that are not a handoff/lane file (`classifyPath`) are
     dropped as today.
   - Guard (see "Difference from today"): keep `(ref, path)` if `path` is on main, or a visited commit's status for it
     contains `A`.
4. **Claims.** One internal helper `claimsFrom(refLines, messages)` builds the claim objects (same shape as today:
   `{key, slug, lane, sha, session, at}`). `collect()` takes the `collab-claim/*` lines from its single
   `for-each-ref refs/remotes/origin` call (separated in JS, no second `for-each-ref`) and reads their commit
   messages as `<sha>` queries in the same `cat-file --batch` (message = text after the first blank line).
   **The exported `listClaims(repo)` keeps its signature and return value** for its standalone callers — `claim`
   (queue.mjs `listClaims(repo).find(...)` after `fetch --prune`), `release`, and the `claims` CLI command: it runs
   its own `for-each-ref refs/remotes/origin/collab-claim/` plus one `cat-file --batch` (2 spawns instead of 1 + N)
   and returns the same array. Those callers are not edited.
5. **Programmes.** `loadPrograms(repo, ref)` keeps its signature; it reads the `program.md` contents through one
   `cat-file --batch` after its `ls-tree` (2 spawns instead of 1 + N).
6. Merge rule unchanged: per path, the newest `updated` wins; main is considered first and wins ties.

**Process budget per repo** (`collect()`): `symbolic-ref` 1 (+ up to 2 `rev-parse` in `defaultRemoteBranch()` only
when `origin/HEAD` is unset), `for-each-ref refs/remotes/origin` 1 (branches and claims), `ls-tree` 1, `rev-list` 1,
`log` 1, `cat-file --batch` 1 = 6, at most 8. `rev-list` and `log` are skipped when there are no recent refs. The
CLI `queue` path adds `loadPrograms()` = 2.

**Difference from today, accepted:** `main..ref` (commits) is a superset of `main...ref` (net diff). A file a branch
changed and then reverted is now read too. Its content is the base version, so it is equal to or older than main's
and never wins, except for a file main has since deleted. Then it can reappear as a row. Guard: skip a `(ref, path)`
whose `path` is not on main unless the branch's own commits added it (the walk tells us).
The guard's one visible difference: a stale branch that **modified** (status `M`, not `A`) a handoff/lane file that
`main` has since deleted. Today the three-dot diff lists it and the branch's copy shows as a row; with the guard it
does not. Accepted: `main` deleting a spec file means that plan or lane was removed, and a stale branch must not bring
it back into the queue. Every other case gives the same rows as today:
- reverted on the branch, path on main → read, but its `updated` is the base version's (≤ main's; main wins ties);
- reverted, path not on main, status `M` → skipped by the guard, as today (empty net diff);
- added then deleted on the branch → `<ref>:<path>` is `missing` in the batch → skipped, as today;
- added on the branch (status `A`), deleted on main or never on main → read, as today.

## Not in this plan (owner decision, deletes data on GitHub)
- Turning on "Automatically delete head branches" for `exafyltd/vitana-v1`.
- A one-off delete of remote branches whose PR is merged (never `collab-claim/*`, never a branch with an open PR,
  never a closed-unmerged branch without review).
After this plan they make `git fetch` faster but are no longer needed for the queue.

## Tests
- `scripts/collab/queue.test.mjs`: a fixture repo (temp dir, `git init`, a fake `origin` remote) with main specs,
  three branches (one changing a lane, one changing then reverting, one adding a new spec), an old branch outside
  `--days`, a branch that added a lane file (status `A`) which main later deleted, a branch that merged `main` in with
  a conflict resolution in a spec file in the merge commit, and two claim refs. Assert `collect()` output equals the
  old implementation's output (keep the old one in the test as `collectReference`). **Separate, labelled guard
  fixture** (excluded from the equality check, with a comment naming this section): a stale branch that modified
  (status `M`) a lane file main has since deleted; assert that path does NOT appear in the new `collect()` output.
  A batch-size test: a fixture whose spec blobs total > 2 MB reads back in full (guards the `maxBuffer` setting). Spawn count, by wrapping the `git` helper: `collect()` = 6 with
  `origin/HEAD` set, ≤ 8 without it, and the same count with 3 and with 8 recent branches; `loadPrograms()` = 2;
  `listClaims()` = 2 and its output equals the old implementation's for the two claim refs.
- Run `node --test scripts/collab/queue.test.mjs` and the existing `queue.mjs validate` tests.
- Manual timing on the owner's machine: `Measure-Command { node scripts/collab/queue.mjs --repo … --repo … }`
  before and after, recorded in the lane log.

## Lane
- `queue-batch-read`: executor **claude** (governance path `scripts/collab/**`), reviewer `exafy`. Touches the same
  file family as `sparring-floor-retry/floor-retry-code` (PR #4186); the coordinator may build both in one PR.
<!-- plan:end -->
