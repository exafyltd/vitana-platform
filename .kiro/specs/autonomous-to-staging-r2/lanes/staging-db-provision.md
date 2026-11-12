---
lane: staging-db-provision
state: in-review
next_actor: kiro
branch: kiro/autonomous-to-staging-r2/staging-db-provision
depends_on: []
executor: kiro
seat: exafy
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - infra/staging-db/**
  - scripts/aws/staging-db-*.sh
  - scripts/ci/staging-db/**
  - scripts/ci/staging-prod-ref-guard.mjs
  - .github/workflows/AWS-STAGE-PROVISION-DB.yml
  - .github/workflows/STAGING-DB-SCHEMA.yml
  - docs/STAGING.md
  - docs/validation/VTID-*/**
updated: 2026-11-12T21:12Z
vtid: VTID-05782
---
# Lane: staging-db-provision (repo vitana-platform)
Tasks in `tasks.md`. The VTID is allocated by PLAN-SPAR.

## Log
### 2026-11-12T19:00Z · kiro-exafy-202611110920-270b · ready
Lane created with the plan.

### 2026-11-12T19:30Z · ci-plan-spar · ready (VTID allocated)
VTID-05782 allocated after policy approval (converged-auto-v1).

### 2026-11-12T21:04Z · kiro-exafy-202611110920-270b · ready → executing
Claimed (`queue.mjs claim`); code and validation only per owner directive 2026-11-12 (plan §3.3): no AWS call, no provisioning, no production role.

### 2026-11-12T21:12Z · kiro-exafy-202611110920-270b · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/5053. Owner-applied stack, provision/load scripts (staging cluster only, cost-approval gated), PGlite schema bundle + hash, production-reference guard, dispatch-only fail-closed provisioning workflow, AWS-free schema workflow, docs/STAGING.md for AWS. Tests 80/80 (76 + 4 skipped without PGlite), 3 mutations caught, cfn-lint 0. No AWS call, nothing provisioned. Next: reviewer agent.

### 2026-11-12T21:19Z · agent-vitana-lane-reviewer-202611122119-724d · review
review: changes
head: 64e8361aa6ec1df274b25646c2fc1293afaafc63
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/5053
Findings: BLOCKING infra/staging-db/stack.yaml:452 (role copy ~735): Sid ManagedMasterSecretCreate allows secretsmanager:CreateSecret/TagResource/RotateSecret on secret:rds!cluster-* with no condition; the production vitana-aurora-prod RDS-managed master secret matches and no Deny covers it. Drop RotateSecret, tag-condition CreateSecret/TagResource, explicit Deny on secrets tagged aws:rds:primaryDBClusterArn = vitana-aurora-prod, test + mutation in stack.test.mjs, correct the acceptance.md "scoped" claim. Non-blocking: prod-deny test list lacks an rds!cluster prod secret case; client-SG deviation from design.md §4 is tighter and accepted; load --verify-only has no cost check (read-only, workflow-gated); red-on-base is module-absent, mutations make the tests meaningful.
Next: the lane's seat fixes the blocking finding
