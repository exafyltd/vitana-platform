---
lane: lane-executor-transfer
state: ready
next_actor: claude
depends_on: []
executor: claude
repos: [exafyltd/vitana-platform, exafyltd/vitana-v1]
paths:
  - scripts/collab/queue.mjs
  - scripts/collab/queue.test.mjs
  - .claude/rules/collaboration.md
  - .kiro/steering/vitana-collaboration.md
updated: 2026-11-15T07:40Z
---
# Lane: lane-executor-transfer
Tasks as in plan.md. The protected gate file scripts/collab/queue.mjs changes in its own PR citing this plan. VTID from CI PLAN-SPAR; never by hand.
