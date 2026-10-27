---
lane: platform-rules
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
  - .kiro/steering/vitana-owner-autonomy.md
  - .kiro/steering/vitana-pipeline.md
  - scripts/ci/kiro-steering/guard.cjs
  - scripts/ci/kiro-steering/guard.test.cjs
  - docs/kiro/**
  - docs/validation/VTID-*/**
updated: 2026-10-27T11:00Z
---
# Lane: platform-rules (repo exafyltd/vitana-platform)
Tasks in `tasks.md` (`<!-- lane: platform-rules -->`). `executor: kiro` with the reviewer agent: `.kiro/steering/**` and
`.claude/**` are governance paths, and no path here is a protected gate file. The VTID is allocated by PLAN-SPAR on
convergence.

## Log
### 2026-10-27T11:00Z · kiro-exafyltd-202610261510-099d · ready
Lane created with the plan.
