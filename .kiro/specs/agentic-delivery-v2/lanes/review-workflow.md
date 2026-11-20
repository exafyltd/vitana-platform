---
lane: review-workflow
state: ready
next_actor: kiro
branch: kiro/agentic-delivery-v2/review-workflow
depends_on: [review-service, reviewer-identity]
executor: kiro
seat: exafyltd
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - .github/workflows/REVIEW-BEDROCK.yml
  - scripts/ci/review-bedrock/review-bedrock.mjs
  - scripts/ci/review-bedrock/review-bedrock.test.mjs
updated: 2026-11-12T21:26Z
vtid: VTID-05708
---

# Lane: review-workflow (repo exafyltd/vitana-platform)

When a lane PR's required checks are green, CI gets the Bedrock verdict and writes the review entry; no session in
between (plan §12).

## Log
### 2026-11-11T12:00Z · kiro-exafyltd-202611111044-8f1d · ready
Lane created with the plan.

### 2026-11-11T11:27Z · ci-plan-spar · ready (VTID allocated)
VTID-05708 allocated after policy approval (converged-auto-v1).
### 2026-11-12T21:26Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)
