---
lane: vtid-on-pr
state: ready
next_actor: kiro
branch: kiro/agentic-delivery-v2/vtid-on-pr
depends_on: []
executor: kiro
seat: exafyltd
repos: [exafyltd/vitana-v1]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - .github/workflows/VTID-ON-PR.yml
  - scripts/ci/pr-gate/vtid-on-pr.mjs
  - scripts/ci/pr-gate/__tests__/vtid-on-pr.test.mjs
updated: 2026-11-11T11:27Z
vtid: VTID-05714
---

# Lane: vtid-on-pr (repo exafyltd/vitana-v1)

A frontend-simple PR gets its VTID from CI, with no plan and no session allocation (plan §9). Needs Phase 0 P8.

## Log
### 2026-11-11T12:00Z · kiro-exafyltd-202611111044-8f1d · ready
Lane created with the plan.

### 2026-11-11T11:27Z · ci-plan-spar · ready (VTID allocated)
VTID-05714 allocated after policy approval (converged-auto-v1).
