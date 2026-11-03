---
lane: oidc-roles
state: executing
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/aws/setup-github-oidc-roles.sh
  - scripts/aws/iam/eng-platform-oidc-*.json
  - services/gateway/test/eng-platform-oidc-roles.test.ts
  - docs/validation/**
claimed_by: kiro-exafy-202611021438-cff7
branch: kiro/eng-platform-p01/oidc-roles
updated: 2026-11-02T20:57Z
vtid: VTID-05516
---
# Lane: oidc-roles (repo vitana-platform)
Tasks in `tasks.md`. VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-02T14:55Z · kiro-exafy-202611021438-cff7 · ready
Lane created with the plan.

### 2026-11-02T17:02Z · ci-plan-spar · ready (VTID allocated)
VTID-05516 allocated after policy approval (converged-auto-v1).

### 2026-11-02T20:57Z · kiro-exafy-202611021438-cff7 · ready → executing
Claimed; code, tests and evidence on branch kiro/eng-platform-p01/oidc-roles.

### 2026-11-03T13:34Z · kiro-exafy-202611021438-cff7 · executing (deviation from plan §3, recorded)
Plan §3 / tasks O3 say the staging role copies IAM user claude-staging-validation. The owner's live inventory
(2026-11-03) showed that user holds AmazonECS_FullAccess, ECR/ELB full access, ReadOnlyAccess and "-temp" inline policies
including iam:CreateRole/PutRolePolicy on vitana-gateway-awsdr-deploy-role. A copy would move that escalation path onto
the new role, so the role gets an explicit staging-only policy instead (strictly narrower). Reviewer findings of
agent-vitana-lane-reviewer-202611031327-bc3d fixed: every secret name the staging workflows touch is covered
(grep-based test), ecs:TagResource for the frontend create-service fallback, PassRole read from the staging task
definitions. Gate 2 lists this under "Decisions taken".
