---
lane: staging-db-provision
state: executing
next_actor: kiro
branch: kiro/autonomous-to-staging-r2/staging-db-provision
depends_on: []
executor: kiro
seat: exafy
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - infra/staging-db/**
  - scripts/aws/staging-db-*.sh
  - scripts/ci/staging-db/**
  - scripts/ci/staging-prod-ref-guard.mjs
  - .github/workflows/AWS-STAGE-PROVISION-DB.yml
  - .github/workflows/STAGING-DB-SCHEMA.yml
  - docs/STAGING.md
  - docs/validation/VTID-*/**
updated: 2026-11-12T21:04Z
vtid: VTID-05782
---
# Lane: staging-db-provision (repo vitana-platform)
Tasks in `tasks.md`. The VTID is allocated by PLAN-SPAR.

## Log
### 2026-11-12T19:00Z · kiro-exafy-202611110920-270b · ready
Lane created with the plan.

### 2026-11-12T19:30Z · ci-plan-spar · ready (VTID allocated)
VTID-05782 allocated after policy approval (converged-auto-v1).

### 2026-11-12T21:04Z · kiro-exafy-202611110920-270b · ready → executing
Claimed (`queue.mjs claim`); code and validation only per owner directive 2026-11-12 (plan §3.3): no AWS call, no provisioning, no production role.
