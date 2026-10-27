---
lane: v1-rules
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - .kiro/steering/vitana-owner-autonomy.md
  - .kiro/steering/vitana-pipeline.md
  - .claude/rules/collaboration.md
  - scripts/ci/kiro-steering/guard.cjs
  - scripts/ci/kiro-steering/guard.test.cjs
  - docs/validation/VTID-*/**
updated: 2026-10-27T11:00Z
---
# Lane: v1-rules (repo exafyltd/vitana-v1)
Tasks in `tasks.md` (`<!-- lane: v1-rules -->`). `executor: kiro` with the reviewer agent: `.kiro/steering/**` and
`.claude/**` are governance paths, and no path here is a protected gate file. The VTID is allocated by PLAN-SPAR on
convergence.

## Log
### 2026-10-27T11:00Z · kiro-exafyltd-202610261510-099d · ready
Lane created with the plan.
