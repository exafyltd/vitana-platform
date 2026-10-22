---
lane: queue-batch-read
state: done
next_actor: kiro
depends_on: []
executor: claude
reviewer_seat: exafy
paths:
  - scripts/collab/queue.mjs
  - scripts/collab/queue.test.mjs
  - docs/validation/**
updated: 2026-10-22T18:28Z
vtid: VTID-05300
branch: kiro/collab-queue-perf/queue-batch-read
pr: https://github.com/exafyltd/vitana-platform/pull/4188
---
# Lane: queue-batch-read
Tasks T1–T5 in `tasks.md`. Claude Code builds it because `scripts/collab/**` is a governance path. The VTID is
allocated by PLAN-SPAR on convergence.
## Log
### 2026-10-18T20:10Z · kiro-202610181950-f0b7 · ready
Lane created with the plan.
### 2026-10-21T11:24Z · ci-plan-spar · ready (VTID allocated)
VTID-05300 allocated after policy approval (converged-auto-v1).
### 2026-10-21T15:49Z · kiro-202610181950-f0b7 · ready → executing
Built T1–T6 in PR https://github.com/exafyltd/vitana-platform/pull/4188 (branch
`kiro/collab-queue-perf/queue-batch-read`, origin/main merged in). Every accepted finding (R1-F1..F4, R2-F1, R2-F2)
is mapped to the code in `docs/validation/VTID-05300/plan-sparring.md`; `scope.json` kind infra.
- `collect()`: 6 git processes per repo (≤ 8 without `origin/HEAD`), `log --cc` for merge-commit spec changes,
  `maxBuffer` 256 MiB; `listClaims()` 2 (callers `claim`, `release`, `claims` unchanged); `loadPrograms()` 2.
- Tests: `node --test "scripts/collab/*.test.mjs"` 101/101 pass (Windows, node 24).
- Timing (owner's Windows machine, local reads, no fetch, machine loaded by parallel sessions):
  `collect({ days: 30 })` vitana-platform 4.05 s / 4.45 s (6 spawns, 234 files, 62 claims), vitana-v1 9.24 s /
  7.15 s (6 spawns, 46 files, 19 claims). Full CLI `queue.mjs --repo vitana-platform --repo vitana-v1`: before
  (origin/main) 238.2 s, after 12.8 s and 6.9 s; same 283 rows, differing only in `updated`/last-log of lanes that
  `pm-agent` pushed between the runs.
- The lane stays `executing` in this PR: Collab handoff checks merge-base → head, and `ready → in-review` is not one
  legal step. `in-review` follows as a lane-state commit.
- Claim ref `collab-claim/collab-queue-perf/queue-batch-read` is held by `kiro-202610211043-0e91` (an earlier,
  interrupted attempt of this same build; its uncommitted diff is the base of this update). Not broken (< 24 h);
  every commit in this PR is from `kiro-202610181950-f0b7`.
Next: reviewer agent on the current head; Lane scope needs `executor: claude` handling for this governance lane.
### 2026-10-22T18:02Z · kiro-202610181950-f0b7 · executing → in-review
Missing §7b record: exafyltd/vitana-platform#4188 (`84fc0ca6a0d116f4e41dfd77c5125cb329b95f15`) was merged under collaboration.md §7b (PM merge rule) on the owner instruction 2026-10-21 (authorized the collaboration.md §7b merges of exafyltd/vitana-platform#4250 and exafyltd/vitana-v1#1470; "now you can run fully end to end without stopping") (run end to end). Recorded now. Next: verified (one edge per PR).
### 2026-10-22T18:13Z · kiro-202610181950-f0b7 · in-review → verified
Acceptance met on `main` (`84fc0ca6`): batched `queue.mjs` reads are on main and in use by every queue run since (collab tests in #4188 green). Tooling only, nothing deploys, so no Gate 2. §7b merge: exafyltd/vitana-platform#4188 (`84fc0ca6a0d116f4e41dfd77c5125cb329b95f15`). Next: done.
### 2026-10-22T18:28Z · kiro-202610181950-f0b7 · verified → done
Lane closed under §7b (owner instruction 2026-10-21 (authorized the collaboration.md §7b merges of exafyltd/vitana-platform#4250 and exafyltd/vitana-v1#1470; "now you can run fully end to end without stopping")); merge exafyltd/vitana-platform#4188 (`84fc0ca6a0d116f4e41dfd77c5125cb329b95f15`). Claim released.
