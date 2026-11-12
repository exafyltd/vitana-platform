---
lane: staging-db-provision
state: ready
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
updated: 2026-11-12T19:00Z
---
# Lane: staging-db-provision (repo vitana-platform)
Tasks in `tasks.md`. The VTID is allocated by PLAN-SPAR.

## Log
### 2026-11-12T19:00Z · kiro-exafy-202611110920-270b · ready
Lane created with the plan.
