---
lane: delivery-bedrock
state: ready
next_actor: kiro
branch: kiro/agentic-delivery-v2/delivery-bedrock
depends_on: []
executor: kiro
seat: exafyltd
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - scripts/aws/setup-delivery-bedrock.sh
  - services/gateway/src/providers/bedrock.ts
  - services/gateway/test/delivery/bedrock-role.test.ts
updated: 2026-11-12T21:26Z
vtid: VTID-05702
---

# Lane: delivery-bedrock (repo exafyltd/vitana-platform)

Delivery stages call Bedrock through a role in the engineering account, outside production's quota (plan §10, §11,
Phase 0 P3). The owner applies the script.

## Log
### 2026-11-11T12:00Z · kiro-exafyltd-202611111044-8f1d · ready
Lane created with the plan.

### 2026-11-11T11:27Z · ci-plan-spar · ready (VTID allocated)
VTID-05702 allocated after policy approval (converged-auto-v1).
### 2026-11-12T21:26Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)
