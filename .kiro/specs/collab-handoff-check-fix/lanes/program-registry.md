---
lane: program-registry
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - docs/programs/native-app/program.md
  - docs/programs/desktop-redesign/program.md
  - docs/programs/standalone/program.md
  - scripts/collab/program-registry.test.mjs
  - docs/validation/VTID-*/**
updated: 2026-10-28T10:22Z
vtid: VTID-05364
---
# program-registry — list the unregistered specs in their programmes
Plan: `.kiro/specs/collab-handoff-check-fix/plan.md`, `tasks.md` section `program-registry`. **Held until PLAN-SPAR
allocates this lane's VTID.**
## Log
### 2026-10-28T10:10Z · kiro-hotmail-202610281000-73d4 · created → ready
Created and held.

### 2026-10-28T10:22Z · ci-plan-spar · ready (VTID allocated)
VTID-05364 allocated after policy approval (converged-auto-v1).
