---
lane: merge-queue
state: executing
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/eng/gitlab-land.mjs
  - scripts/eng/gitlab-land-queue.test.mjs
  - scripts/eng/review-source.mjs
  - scripts/eng/review-source.test.mjs
  - scripts/eng/gitlab-gates.mjs
  - scripts/eng/gitlab-gates.test.mjs
  - scripts/eng/assist-trigger.mjs
  - scripts/eng/assist-trigger.test.mjs
  - docs/validation/**
updated: 2026-11-05T22:17Z
vtid: VTID-05549
claimed_by: kiro-exafy-202611051413-6eb1
branch: kiro/agentic-delivery/merge-queue
pr: https://github.com/exafyltd/vitana-platform/pull/4721
---
# Lane: merge-queue (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.5 and the trigger of §3.9. Starts when eng-gitlab-m2 lane merge-bot is done (plan §9). Edits neither land-guard.mjs nor queue.mjs. VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-04T23:03Z · kiro-exafy-202611041929-802c · ready
Lane created with the plan.

### 2026-11-05T00:25Z · ci-plan-spar · ready (VTID allocated)
VTID-05549 allocated after policy approval (converged-auto-v1).
### 2026-11-05T02:53Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)
### 2026-11-05T02:59Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)

### 2026-11-05T16:05Z · kiro-exafy-202611051413-6eb1 · ready → executing
Built Q1-Q3: the queue mode of `scripts/eng/gitlab-land.mjs` (order, red-main pause, hot files, train of 8, plan merge requests, trailers, labels) and `review-source.mjs`, `gitlab-gates.mjs`, `assist-trigger.mjs`, with their tests and evidence in `docs/validation/VTID-05549/`.
Tests first: red on the scratch base 25 of 25 (30 of 30 on stubs), green 106 of 106 (52 new plus M2's 54); UNIT 727 tests, 0 fail; a 12-merge-request run over the fake GitLab; `land-guard.mjs` and `queue.mjs` untouched.
Parked locally (F2): built on the local scratch commit "scratch: merge-bot tree" (main after merge-bot #4697, which has a `changes` review); nothing pushed. The driver rebuilds the lane's commits on origin/main after merge-bot lands.
Decisions taken and the merge-bot functions this lane depends on: `acceptance.md` ("Decisions taken", "Contract").

### 2026-11-05T16:12Z · kiro-exafy-202611051413-6eb1 · executing
Parked locally, waiting for eng-gitlab-m2 lane merge-bot (#4697, `changes` review at 14:13Z) to land; nothing pushed, no PR. Local commits on the scratch base 5209c22376: af6cfd1e7a (code), 0c19e60e38 (this lane file), 71f0273b71 (train positions need gate, not the per-merge-request governance jobs), d8893eebdd (acceptance decisions 15-16), and this entry.
Final counts: red on base 26 of 26 (30 of 30 on stubs), green 107 of 107 (53 new plus M2's 54), UNIT 728 tests, 0 fail. Next: the driver rebuilds these commits on origin/main after merge-bot lands (cherry-pick, adapt to its fix, re-test, preflight), then pushes and opens the PR.

### 2026-11-05T22:08Z · kiro-exafy-202611051413-6eb1 · executing
Rebuilt after eng-gitlab-m2 merge-bot (#4697, `72dbefbaae`) landed: the branch was made anew from origin/main `0f45367bb6`, the lane's five own commits were cherry-picked unchanged (`3c5af48ecb`, `cc748671c8`, `f8268ba07a`, `5f154fa094`, `19abaf4c0b`; the scratch commit stays local), and `8d90a0fb85` adapts the queue to merge-bot's final `gitlab-land.mjs`: the queue switch by project name, M2's 60-minute bound for a merge GitLab keeps refusing, `-c credential.helper=` on every git command of a queue tick, and a regression test of M2's conflict rule.
Tests first: the adaptation tests 3 of 4 red on the cherry-picked code; red on base 30 of 30 (30 of 30 on stubs), green 115 of 115, UNIT 939 tests, 0 fail; preflight passed. PR https://github.com/exafyltd/vitana-platform/pull/4721 open.
Waits for eng-gitlab-m2 lane settings (#4711): `gitlab-land.mjs` reads its projects through `loadEffectiveProjects` (cut checklist item `bot-config`) once #4711 lands with that function; then main is merged, the call is added test first, and the lane goes to in-review. For the driver: `acceptance.md` decisions 1, 4 and 19.

### 2026-11-05T22:17Z · kiro-exafy-202611051413-6eb1 · executing
Follow-up `cd814f0e34` on PR https://github.com/exafyltd/vitana-platform/pull/4721: a merge request dropped in the tick in which the bot merged `main` into it is dropped and commented for the head the bot made, so it stays out until its builder pushes (test red first on `43ef9402f5`). Red on base 31 of 31, green 116 of 116, UNIT 940 tests, 0 fail.
Still waits for eng-gitlab-m2 lane settings (#4711) and its `loadEffectiveProjects`.
