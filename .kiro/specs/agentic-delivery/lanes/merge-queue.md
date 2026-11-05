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
updated: 2026-11-05T16:05Z
vtid: VTID-05549
claimed_by: kiro-exafy-202611051413-6eb1
branch: kiro/agentic-delivery/merge-queue
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
