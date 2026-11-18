---
lane: bedrock-invoke-policy
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - scripts/aws/iam/delivery-bedrock-invoke-policy.json
  - scripts/aws/test/test_delivery_bedrock_policy.py
updated: 2026-11-12T07:09Z
vtid: VTID-05774
---

# Lane: bedrock-invoke-policy (repo exafyltd/vitana-platform)

The P7 Bedrock policy as a file: invoke rights for the delivery model chains (M1, M4, M5) on the EU inference profiles
and their EU destination Regions, and DeepSeek V3.2 in `eu-north-1` (option A, off in config). The owner applies it;
nothing in this lane changes IAM. Late lane (owner instruction 2026-11-12). Tasks in `tasks.md`.

## Log
### 2026-11-12T07:07Z · kiro-exafyltd-202611111044-8f1d · ready
Late lane added after convergence (owner instruction 2026-11-12, item 3); its VTID comes from the next PLAN-SPAR run.

### 2026-11-12T07:09Z · ci-plan-spar · ready (VTID allocated)
VTID-05774 allocated after policy approval (converged-auto-v1).
