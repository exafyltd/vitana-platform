---
lane: bedrock-invoke-policy
state: in-review
next_actor: kiro
claimed_by: kiro-exafyltd-202611111044-8f1d
pr: https://github.com/exafyltd/vitana-platform/pull/5006
branch: kiro/agentic-delivery-scope/bedrock-invoke-policy
depends_on: []
executor: kiro
seat: exafyltd
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - scripts/aws/iam/delivery-bedrock-invoke-policy.json
  - scripts/aws/test/test_delivery_bedrock_policy.py
updated: 2026-11-12T07:24Z
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

### 2026-11-12T07:19Z · kiro-exafyltd-202611111044-8f1d · ready → executing
Claimed (claim ref `refs/heads/collab-claim/agentic-delivery-scope/bedrock-invoke-policy`). Test first: 8 failures on
`origin/main` (no policy file), 8 passed with the policy; IAM simulation 58 allowed. Evidence in
`docs/validation/VTID-05774/`.

### 2026-11-12T07:24Z · kiro-exafyltd-202611111044-8f1d · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/5006; 11 of 11 checks green on `7e1eb090f9`. Review by the M4 chain pending:
the chain cannot run from a Kiro session until the owner applies this policy (commands in the PR body), so the lane
is blocked on M4 and is not merged without an accept.
