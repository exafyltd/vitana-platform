---
lane: plan-pr-merge
state: ready
next_actor: kiro
depends_on: [reviewer-fallback]
executor: claude
seat: exafyltd
area: platform
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - .github/workflows/PLAN-PR-MERGE.yml
  - scripts/collab/plan-merge.mjs
  - scripts/collab/plan-merge.test.mjs
  - docs/validation/VTID-*/**
updated: 2026-10-27T15:40Z
---
# Lane: plan-pr-merge (repo vitana-platform)
Tasks in `tasks.md` (`<!-- lane: plan-pr-merge -->`). Plan: `plan.md` §3.
`executor: claude`: protected gate files; while Claude is unavailable the exceptions seat `exafyltd` builds it (collaboration.md §7). Merge needs a legacy Claude review on the current head or an owner instruction naming `pipeline-agent-wake-and-review`.

## Log
### 2026-10-27T15:40Z · kiro-exafyltd-202610271503-9458 · ready
Lane created with the plan.
