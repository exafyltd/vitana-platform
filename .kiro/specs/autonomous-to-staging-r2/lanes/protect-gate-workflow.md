---
lane: protect-gate-workflow
state: ready
next_actor: kiro
branch: kiro/autonomous-to-staging-r2/protect-gate-workflow
depends_on: []
executor: kiro
seat: exafy
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
protected_gate: two-model
repos: [exafyltd/vitana-platform]
paths:
  - scripts/collab/protected-gate-files.json
  - scripts/collab/queue.mjs
  - scripts/collab/land-guard.mjs
  - scripts/collab/gate-audit.mjs
  - scripts/collab/*.test.mjs
  - scripts/collab/fixtures/**
  - services/gateway/src/services/project-manager/governance.ts
  - services/gateway/test/**
  - .github/workflows/GATE-INVARIANTS.yml
  - scripts/ci/workflow-trigger-check.test.mjs
  - docs/validation/VTID-*/**
updated: 2026-11-12T19:00Z
---
# Lane: protect-gate-workflow (repo vitana-platform)
Tasks in `tasks.md`. The VTID is allocated by PLAN-SPAR.

## Log
### 2026-11-12T19:00Z · kiro-exafy-202611110920-270b · ready
Lane created with the plan.
