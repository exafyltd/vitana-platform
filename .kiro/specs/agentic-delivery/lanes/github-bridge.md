---
lane: github-bridge
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/eng/github-bridge.mjs
  - scripts/eng/github-bridge.test.mjs
  - infra/gitlab-engineering/host/units/vitana-github-bridge.service
  - infra/gitlab-engineering/host/units/vitana-github-bridge.timer
  - infra/gitlab-engineering/RUNBOOK-github-bridge.md
  - docs/validation/**
updated: 2026-11-05T02:53Z
vtid: VTID-05548
---
# Lane: github-bridge (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.13 (branches, pull requests, statuses). Starts when eng-gitlab-m2 lane gitlab-client is done (plan §9). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-04T23:03Z · kiro-exafy-202611041929-802c · ready
Lane created with the plan.

### 2026-11-05T00:25Z · ci-plan-spar · ready (VTID allocated)
VTID-05548 allocated after policy approval (converged-auto-v1).
### 2026-11-05T02:53Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)
