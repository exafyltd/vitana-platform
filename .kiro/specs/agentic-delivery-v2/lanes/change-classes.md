---
lane: change-classes
state: ready
next_actor: kiro
branch: kiro/agentic-delivery-v2/change-classes
depends_on: []
executor: kiro
seat: exafy
area: platform
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - config/delivery/change-classes.json
  - scripts/eng/change-class.mjs
  - scripts/eng/change-class.test.mjs
updated: 2026-11-11T11:27Z
vtid: VTID-05701
---

# Lane: change-classes (repo exafyltd/vitana-platform)

One rule file and one classifier for classes A1, A2, B and P (plan §7).

## Log
### 2026-11-11T12:00Z · kiro-exafyltd-202611111044-8f1d · ready
Lane created with the plan.

### 2026-11-11T11:27Z · ci-plan-spar · ready (VTID allocated)
VTID-05701 allocated after policy approval (converged-auto-v1).
