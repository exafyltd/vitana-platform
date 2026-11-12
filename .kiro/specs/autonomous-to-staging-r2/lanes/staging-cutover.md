---
lane: staging-cutover
state: executing
next_actor: kiro
branch: kiro/autonomous-to-staging-r2/staging-cutover
depends_on: [staging-db-provision]
executor: kiro
seat: exafy
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml
  - .github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml
  - .github/workflows/AWS-STAGE-CUTOVER.yml
  - .github/workflows/AWS-STAGE-CUTOVER-REHEARSAL.yml
  - scripts/aws/staging-cutover-*.sh
  - scripts/aws/staging-cutover-*.mjs
  - scripts/ci/staging-db/**
  - docs/validation/VTID-*/**
updated: 2026-11-12T22:08Z
vtid: VTID-05781
---
# Lane: staging-cutover (repo vitana-platform)
Tasks in `tasks.md`. The VTID is allocated by PLAN-SPAR.

## Log
### 2026-11-12T19:00Z · kiro-exafy-202611110920-270b · ready
Lane created with the plan.

### 2026-11-12T19:30Z · ci-plan-spar · ready (VTID allocated)
VTID-05781 allocated after policy approval (converged-auto-v1).

### 2026-11-12T22:08Z · kiro-exafy-202611110920-270b · executing
Claimed; building on `kiro/autonomous-to-staging-r2/staging-cutover` from origin/main `bb15274201`. Code, tests and docs only (owner directive 2026-11-12): no AWS call, no deploy, no dispatch.
