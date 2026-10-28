---
lane: land-guard
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/collab/land-guard.mjs
  - scripts/collab/land-guard.test.mjs
  - .kiro/pipeline/common-rules.md
  - docs/validation/VTID-*/**
updated: 2026-10-28T09:40Z
---
# Lane: land-guard (repo vitana-platform)
Tasks in `tasks.md`. The VTID is allocated by PLAN-SPAR.

## Log
### 2026-10-28T09:40Z · kiro-exafyltd-202610261510-099d · ready
Lane created with the plan.
