---
lane: prod-frontend-oidc
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - .github/workflows/AWS-PROD-DEPLOY-FRONTEND.yml
  - .github/workflows/DEPLOY.yml
  - src/lib/eng-platform-prod-frontend-oidc.test.ts
  - docs/validation/**
updated: 2026-11-03T18:17Z
---
# Lane: prod-frontend-oidc (repo vitana-v1)
Tasks in `tasks.md`. Owner command for the production-workflow change: "ok 2" (2026-11-03). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-03T18:17Z · kiro-exafy-202611021438-cff7 · ready
Lane created with the plan.
