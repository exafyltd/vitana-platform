---
lane: merge-queue
state: ready
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
updated: 2026-11-04T20:50Z
---
# Lane: merge-queue (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.5 and the trigger of §3.9. Starts when eng-gitlab-m2 lane merge-bot is done (plan §9). Edits neither land-guard.mjs nor queue.mjs. VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-04T20:50Z · kiro-exafy-202611041929-802c · ready
Lane created with the plan.
