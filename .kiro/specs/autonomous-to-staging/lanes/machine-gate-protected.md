---
lane: machine-gate-protected
state: ready
next_actor: kiro
branch: kiro/autonomous-to-staging/machine-gate-protected
depends_on: []
executor: claude
area: platform
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/collab/queue.mjs
  - scripts/collab/land-guard.mjs
  - scripts/collab/protected-gate-files.json
  - scripts/collab/gate-invariants.mjs
  - services/gateway/src/services/project-manager/governance.ts
  - scripts/collab/*.test.mjs
  - services/gateway/test/**
  - docs/validation/VTID-*/**
updated: 2026-11-11T21:30Z
---
# Lane: machine-gate-protected (repo vitana-platform)
Tasks in `tasks.md`. The VTID is allocated by PLAN-SPAR.

## Log
### 2026-11-11T21:30Z · kiro-exafy-202611110920-270b · ready
Lane created with the plan.
