---
lane: verify-on-gitlab
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/ci/staging-verify/run.mjs
  - scripts/ci/staging-verify/deploy-runs.test.mjs
  - scripts/eng/verify/**
  - infra/gitlab-engineering/ci/tpl-verify.yml
  - docs/validation/**
updated: 2026-11-04T20:50Z
---
# Lane: verify-on-gitlab (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.6 steps 3 to 6. Starts at once; its template file merges after eng-gitlab-m2 lane settings is done (plan §9). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-04T20:50Z · kiro-exafy-202611041929-802c · ready
Lane created with the plan.
