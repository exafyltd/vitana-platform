---
lane: staging-verify-wiring
state: ready
next_actor: kiro
depends_on: [traceability]
executor: kiro
seat: exafyltd
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - .github/workflows/STAGING-VERIFY.yml
  - scripts/ci/staging-verify/record-oasis.sh
  - scripts/ci/staging-verify/record-oasis.test.cjs
updated: 2026-11-11T16:49Z
vtid: VTID-05744
---

# Lane: staging-verify-wiring (repo exafyltd/vitana-platform)

STAGING-VERIFY records through the gateway with the service token, one event per VTID, direct write as fallback; the job gets the delivery Bedrock role when `vars.DELIVERY_BEDROCK_ROLE_ARN` is set. Tasks in `tasks.md`.

## Log
### 2026-11-11T16:23Z · kiro-exafyltd-202611111044-8f1d · ready
Lane created with the plan.

### 2026-11-11T16:49Z · ci-plan-spar · ready (VTID allocated)
VTID-05744 allocated after policy approval (converged-auto-v1).
