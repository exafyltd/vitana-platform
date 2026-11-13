---
lane: staging-cutover
state: in-review
next_actor: kiro
branch: kiro/autonomous-to-staging-r2/staging-cutover
depends_on: [staging-db-provision]
executor: kiro
seat: exafy
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml
  - .github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml
  - .github/workflows/AWS-STAGE-CUTOVER.yml
  - .github/workflows/AWS-STAGE-CUTOVER-REHEARSAL.yml
  - scripts/aws/staging-cutover-*.sh
  - scripts/aws/staging-cutover-*.mjs
  - scripts/ci/staging-db/**
  - docs/validation/VTID-*/**
updated: 2026-11-12T22:39Z
vtid: VTID-05781
---
# Lane: staging-cutover (repo vitana-platform)
Tasks in `tasks.md`. The VTID is allocated by PLAN-SPAR.

## Log
### 2026-11-12T19:00Z · kiro-exafy-202611110920-270b · ready
Lane created with the plan.

### 2026-11-12T19:30Z · ci-plan-spar · ready (VTID allocated)
VTID-05781 allocated after policy approval (converged-auto-v1).

### 2026-11-12T22:08Z · kiro-exafy-202611110920-270b · ready → executing
Claimed; building on `kiro/autonomous-to-staging-r2/staging-cutover` from origin/main `bb15274201`. Code, tests and docs only (owner directive 2026-11-12): no AWS call, no deploy, no dispatch.

### 2026-11-12T22:39Z · kiro-exafy-202611110920-270b · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/5059 (head 6d50ab8577). STAGING_DATA_PLANE switch (default shared, byte-identical), rehearsal on the -iso candidates, owner-gated flip with automatic rollback, impact check; 107/107 tests, 24 mutations. No AWS call, nothing flipped. Owner actions: docs/validation/VTID-05781/runbook.md §2.

### 2026-11-13T07:57Z · agent-vitana-lane-reviewer-202611130757-c585 · review
review: accept
head: 9937886725a6fe63be8ac7284f9ffdb69e08eadc
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/5059
Findings: non-blocking — env VTID_ALLOCATOR_ENABLED=false alone does not disable the allocator (system-controls-service.ts:416-430); isolated mode relies on the replayed control row being FALSE (migration 20260117150000:84-88); pin it before the flip. Non-blocking — manual rollback does not check that recorded task-definition ARNs are staging families. Non-blocking — impact.mjs finds staging callers only by literal host. Non-blocking — owner-applied IAM additions, candidate services, url-aurora-proxy-iso secret and client SG are prerequisites (runbook.md §2), each step fails closed without them. Non-blocking — vitana_staging_app has rds_superuser on the synthetic staging cluster (documented).
Next: the land step merges under §7b
