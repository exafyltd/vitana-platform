---
lane: staging-migrations-auto
state: ready
next_actor: kiro
branch: kiro/autonomous-to-staging/staging-migrations-auto
depends_on: [staging-db-isolation]
executor: kiro
seat: exafy
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - .github/workflows/RUN-MIGRATION.yml
  - .github/workflows/STAGING-MIGRATE.yml
  - scripts/aws/aurora-apply-migration.sh
  - scripts/aws/staging-db-*.sh
  - services/gateway/test/**
  - docs/validation/VTID-*/**
updated: 2026-11-11T23:41Z
vtid: VTID-05773
---
# Lane: staging-migrations-auto (repo vitana-platform)
Tasks in `tasks.md`. The VTID is allocated by PLAN-SPAR.

## Log
### 2026-11-11T21:30Z · kiro-exafy-202611110920-270b · ready
Lane created with the plan.

### 2026-11-11T23:41Z · ci-plan-spar · ready (VTID allocated)
VTID-05773 allocated after policy approval (converged-auto-v1).
