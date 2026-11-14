---
lane: staging-db-isolation
state: ready
next_actor: kiro
branch: kiro/autonomous-to-staging/staging-db-isolation
depends_on: []
executor: kiro
seat: exafy
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - infra/staging-db/**
  - .github/workflows/AWS-STAGE-PROVISION-DB.yml
  - scripts/aws/staging-db-*.sh
  - scripts/ci/staging-prod-ref-guard.mjs
  - .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml
  - .github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml
  - docs/STAGING.md
  - docs/validation/VTID-*/**
updated: 2026-11-11T23:41Z
vtid: VTID-05771
---
# Lane: staging-db-isolation (repo vitana-platform)
Tasks in `tasks.md`. The VTID is allocated by PLAN-SPAR.

## Log
### 2026-11-11T21:30Z · kiro-exafy-202611110920-270b · ready
Lane created with the plan.

### 2026-11-11T23:41Z · ci-plan-spar · ready (VTID allocated)
VTID-05771 allocated after policy approval (converged-auto-v1).
