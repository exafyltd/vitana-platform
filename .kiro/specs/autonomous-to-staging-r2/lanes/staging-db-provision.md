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
updated: 2026-11-12T21:26Z
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

### 2026-11-12T21:23Z · kiro-exafy-202611110920-270b · in-review → executing
Fixing the blocking review finding (rds!cluster-* secret scope).

### 2026-11-12T21:26Z · kiro-exafy-202611110920-270b · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/5053. Review fix (64834f63): RotateSecret dropped; CreateSecret/TagResource on rds!cluster-* only via RDS (aws:ViaAWSService); explicit Denies on the vitana-aurora-prod managed secret by name (rds!cluster-4dab93b8-*, rds!cluster-eba8a4f2-…-*), by cluster tag and request tag, and on any other cluster's managed secret, in role and boundary; acceptance.md "scoped" claim corrected. Tests 81 (77 + 4 PGlite skipped), 6 new mutations caught, cfn-lint 0. Next: reviewer agent.

### 2026-11-12T21:33Z · agent-vitana-lane-reviewer-202611122133-4378 · review
review: accept
head: 7e6689c7cff4d06c97861183ac09876b3d9ebaee
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/5053
Findings: the blocking finding of 590b018366 is resolved in role and boundary: ManagedMasterSecretCreate allows only CreateSecret/TagResource on rds!cluster-* with aws:ViaAWSService=true; RotateSecret removed; four explicit Denies (by production name prefixes 4dab93b8/eba8a4f2, by production resource tag, by production request tag, any other cluster's managed secret). Departures checked against the repo docs. No regression; the update-branch merge brings only main's plan-only spec. Non-blocking: two conditions tested by structure only (evaluator limit, mutations cover them); IAM not yet proven against AWS (first owner-approved apply fails closed); CI on this head to be confirmed green by the land step.
Next: the land step merges under §7b after every check is green on 7e6689c7
