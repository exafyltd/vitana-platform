---
lane: throughput-code
state: ready
next_actor: claude
depends_on: []
executor: claude
seat: claude
reviewer_seat: exafy
paths:
  - scripts/collab/queue.mjs
  - scripts/collab/queue.test.mjs
  - scripts/collab/plan-spar.mjs
  - scripts/collab/plan-spar.test.mjs
  - .github/workflows/PLAN-SPAR.yml
  - .github/workflows/ALERT-PLAN-SPARRING-CODE-ACCESS.yml
  - services/gateway/src/routes/plans-spar.ts
  - services/gateway/src/services/plan-sparring/github-tools.ts
  - services/gateway/src/services/plan-sparring/partner.ts
  - services/gateway/src/services/plan-sparring/plan-sparring-service.ts
  - services/gateway/test/**
  - docs/validation/**
updated: 2026-10-18T20:40Z
---
# Lane: throughput-code

Tasks T1–T4 in `tasks.md`. Claude Code builds it (governance paths). Build it after `sparring-floor-retry` merges,
since both edit `plan-spar.mjs`. The VTID is allocated by PLAN-SPAR on convergence.

## Log

### 2026-10-18T20:40Z · kiro-exafy-202610181845-661d · ready
Lane created with the plan.
