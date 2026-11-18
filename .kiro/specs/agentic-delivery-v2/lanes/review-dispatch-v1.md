---
lane: review-dispatch-v1
state: ready
next_actor: kiro
branch: kiro/agentic-delivery-v2/review-dispatch-v1
depends_on: [review-workflow]
executor: kiro
seat: exafyltd
repos: [exafyltd/vitana-v1]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - .github/workflows/REVIEW-BEDROCK-DISPATCH.yml
  - scripts/ci/pr-gate/__tests__/review-dispatch.test.mjs
updated: 2026-11-11T11:27Z
vtid: VTID-05706
---

# Lane: review-dispatch-v1 (repo exafyltd/vitana-v1)

A v1 lane PR whose checks are green asks the platform review workflow for its Bedrock review (plan §12).

## Log
### 2026-11-11T12:00Z · kiro-exafyltd-202611111044-8f1d · ready
Lane created with the plan.

### 2026-11-11T11:27Z · ci-plan-spar · ready (VTID allocated)
VTID-05706 allocated after policy approval (converged-auto-v1).
